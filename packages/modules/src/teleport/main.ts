import {
  DbConnectionSchema,
  QuiverError,
  dbKindForProtocol,
  defineCommand,
  defineModule,
  newDbConnection,
  nowIso,
  parseTshDatabases,
  parseTshKubeClusters,
  shouldAutoLogin,
  type DbConnection,
  type DbConnectionSummary,
  type HostApi,
  type TeleportDatabase,
  type TeleportKubeCluster,
  type TeleportLoginResult,
  type TeleportStatus,
  type TeleportTunnel,
} from '@quiver/core';
import { z } from 'zod';
import { COLLECTIONS, getConnection, listConnections } from '../db/connections';
import { getTeleport } from './runtime';

const LIST_CACHE_MS = 30_000;

interface Cached<T> {
  at: number;
  value: T;
}

let dbCache: Cached<Omit<TeleportDatabase, 'tunnel'>[]> | null = null;
let kubeCache: Cached<TeleportKubeCluster[]> | null = null;

function invalidateCaches(): void {
  dbCache = null;
  kubeCache = null;
}

async function listDatabases(host: HostApi, refresh: boolean): Promise<TeleportDatabase[]> {
  const { session, tunnels } = getTeleport(host);
  if (refresh || !dbCache || Date.now() - dbCache.at > LIST_CACHE_MS) {
    const stdout = await session.run(['db', 'ls', '--format=json']);
    dbCache = { at: Date.now(), value: parseTshDatabases(stdout) };
  }
  const running = tunnels.list();
  return dbCache.value.map((db) => ({ ...db, tunnel: running.find((t) => t.kind === 'teleport' && t.target === db.name) ?? null }));
}

async function listKubeClusters(host: HostApi, refresh: boolean): Promise<TeleportKubeCluster[]> {
  const { session } = getTeleport(host);
  if (refresh || !kubeCache || Date.now() - kubeCache.at > LIST_CACHE_MS) {
    const stdout = await session.run(['kube', 'ls', '--format=json']);
    kubeCache = { at: Date.now(), value: parseTshKubeClusters(stdout) };
  }
  return kubeCache.value;
}

// ---------- session ----------

const status = defineCommand({
  id: 'teleport.status',
  title: 'Teleport status',
  description:
    'Where tsh is, the active Teleport profile (proxy, cluster, user, certificate expiry), whether a login is running, and the local tunnels. State is one of no-tsh, logged-out, expired, logged-in, expiring.',
  scope: 'global',
  input: z.object({ refresh: z.boolean().optional().describe('Run tsh status now instead of returning the last poll') }),
  handler: async ({ refresh }, ctx): Promise<TeleportStatus> => {
    const { session } = getTeleport(ctx.host);
    return refresh ? session.refresh() : session.getStatus();
  },
});

const login = defineCommand({
  id: 'teleport.login',
  title: 'Log in to Teleport',
  description:
    'Runs tsh login --proxy=<addr>. The cluster default connector is SSO, so a browser window opens and the call returns when tsh exits (up to five minutes). Output lines are returned so links and MFA prompts are visible.',
  scope: 'global',
  mutating: true,
  input: z.object({ proxy: z.string().optional().describe('Proxy address; defaults to Settings > Teleport, then the current profile') }),
  handler: async ({ proxy }, ctx): Promise<TeleportLoginResult> => {
    const { session } = getTeleport(ctx.host);
    invalidateCaches();
    return session.login(proxy);
  },
});

const loginCancel = defineCommand({
  id: 'teleport.login.cancel',
  title: 'Cancel Teleport login',
  description: 'Kills a running tsh login.',
  scope: 'global',
  hidden: true,
  input: z.object({}),
  handler: async (_i, ctx) => ({ cancelled: getTeleport(ctx.host).session.cancelLogin() }),
});

const logout = defineCommand({
  id: 'teleport.logout',
  title: 'Log out of Teleport',
  description: 'Runs tsh logout, which also affects tsh and kubectl in your terminal since the profile is shared. Running tunnels are stopped.',
  scope: 'global',
  mutating: true,
  input: z.object({}),
  handler: async (_i, ctx): Promise<TeleportStatus> => {
    const { session, tunnels } = getTeleport(ctx.host);
    await tunnels.stopAll();
    invalidateCaches();
    return session.logout();
  },
});

// ---------- databases ----------

const dbList = defineCommand({
  id: 'teleport.db.list',
  title: 'List Teleport databases',
  description: 'Databases the current Teleport role can reach (tsh db ls): name, protocol, allowed database users, and the running tunnel if any. Cached for 30 seconds unless refresh is true.',
  scope: 'global',
  input: z.object({ refresh: z.boolean().optional() }),
  handler: async ({ refresh }, ctx): Promise<TeleportDatabase[]> => listDatabases(ctx.host, Boolean(refresh)),
});

function findTeleportConnection(connections: DbConnectionSummary[], database: string, dbUser?: string): DbConnectionSummary | undefined {
  return connections.find((c) => c.access.type === 'teleport' && c.access.database === database && (!dbUser || c.access.dbUser === dbUser));
}

const dbConnect = defineCommand({
  id: 'teleport.db.connect',
  title: 'Connect to a Teleport database',
  description:
    'Starts (or reuses) a local tunnel with tsh proxy db --tunnel for the database and user, then creates or reuses a Quiver database connection bound to it in the workspace (MySQL and Redis; other protocols only get the tunnel port). dbUser defaults to the existing connection\'s user, or the single allowed user.',
  scope: 'global',
  input: z.object({
    database: z.string().describe('Teleport database name (see teleport.db.list)'),
    dbUser: z.string().optional(),
    name: z.string().optional().describe('Name for a newly created Quiver connection; defaults to the database name'),
  }),
  handler: async ({ database, dbUser, name }, ctx): Promise<{ tunnel: TeleportTunnel; connection: DbConnectionSummary | null; database: TeleportDatabase; message: string | null }> => {
    const { tunnels } = getTeleport(ctx.host);
    const databases = await listDatabases(ctx.host, false);
    const db = databases.find((d) => d.name === database) ?? (await listDatabases(ctx.host, true)).find((d) => d.name === database);
    if (!db) throw new QuiverError('NOT_FOUND', `Teleport database "${database}" was not found. Run teleport.db.list to see what your roles allow.`);

    const connections = ctx.workspace ? await listConnections(ctx.workspace) : [];
    let user = dbUser?.trim() ?? '';
    if (!user) {
      const prior = findTeleportConnection(connections, database);
      if (prior?.access.type === 'teleport') user = prior.access.dbUser;
    }
    if (!user) {
      const concrete = db.allowedUsers.filter((u) => u !== '*');
      if (concrete.length === 1) user = concrete[0];
      else
        throw new QuiverError('INVALID_INPUT', `Pick a database user for ${database}: ${db.allowedUsers.length ? db.allowedUsers.join(', ') : 'none allowed'}`, { allowedUsers: db.allowedUsers });
    }

    const tunnel = await tunnels.ensure({ kind: 'teleport', database, dbUser: user }, 'pinned');

    let connection: DbConnectionSummary | null = null;
    let message: string | null = null;
    const kind = dbKindForProtocol(db.protocol);
    if (!ctx.workspace) {
      message = `Tunnel is listening on 127.0.0.1:${tunnel.port}. Open a workspace to attach a Quiver connection.`;
    } else if (!kind) {
      message = `Quiver has no ${db.protocol} client yet. The tunnel is listening on 127.0.0.1:${tunnel.port} for other tools.`;
    } else {
      const existing = findTeleportConnection(connections, database, user);
      if (existing) {
        connection = existing;
      } else {
        const created: DbConnection = newDbConnection(kind, {
          name: name?.trim() || database,
          host: '127.0.0.1',
          port: 0,
          user: kind === 'mysql' ? user : '',
          access: { type: 'teleport', database, dbUser: user },
        });
        await ctx.workspace.store.put(COLLECTIONS.connections, DbConnectionSchema.parse(created));
        connection = await getConnection(ctx.workspace, created.id);
      }
    }
    return { tunnel, connection, database: db, message };
  },
});

const dbDisconnect = defineCommand({
  id: 'teleport.db.disconnect',
  title: 'Stop a Teleport tunnel',
  description: 'Stops the local tunnel for a Teleport database (all users, or one dbUser), or a tunnel by id. Connections using it reconnect, and restart the tunnel, on their next query.',
  scope: 'global',
  mutating: true,
  input: z.object({ database: z.string().optional(), dbUser: z.string().optional(), tunnelId: z.string().optional() }),
  handler: async ({ database, dbUser, tunnelId }, ctx) => {
    const { tunnels } = getTeleport(ctx.host);
    if (tunnelId) return { stopped: (await tunnels.stop(tunnelId)) ? 1 : 0 };
    if (!database) throw new QuiverError('INVALID_INPUT', 'Provide database or tunnelId');
    return { stopped: await tunnels.stopTeleport(database, dbUser) };
  },
});

// ---------- kubernetes ----------

const kubeList = defineCommand({
  id: 'teleport.kube.list',
  title: 'List Teleport Kubernetes clusters',
  description: 'Kubernetes clusters reachable through Teleport (tsh kube ls) and which one is selected in kubeconfig. Cached for 30 seconds unless refresh is true.',
  scope: 'global',
  input: z.object({ refresh: z.boolean().optional() }),
  handler: async ({ refresh }, ctx): Promise<TeleportKubeCluster[]> => listKubeClusters(ctx.host, Boolean(refresh)),
});

const kubeLogin = defineCommand({
  id: 'teleport.kube.login',
  title: 'Select Kubernetes cluster',
  description: 'Runs tsh kube login <cluster>, which writes the kubeconfig context used by kubectl in your terminal.',
  scope: 'global',
  mutating: true,
  input: z.object({ cluster: z.string() }),
  handler: async ({ cluster }, ctx) => {
    const { session } = getTeleport(ctx.host);
    const output = await session.run(['kube', 'login', cluster]);
    kubeCache = null;
    void session.refresh().catch(() => {});
    return { cluster, output: output.trim() };
  },
});

export const teleportModule = defineModule({
  id: 'teleport',
  commands: [status, login, loginCancel, logout, dbList, dbConnect, dbDisconnect, kubeList, kubeLogin],
  onStart: (host) => {
    const { session } = getTeleport(host);
    // Never block startup on tsh; the UI polls status as soon as it mounts.
    void session
      .start()
      .then((initial) => {
        if (shouldAutoLogin(host.config.get().teleport, initial)) {
          console.log(`[quiver] teleport certificate expired at ${initial.validUntil ?? '?'}, starting tsh login (${nowIso()})`);
          void session.login().catch((err) => console.warn(`[quiver] teleport auto-login failed: ${(err as Error).message}`));
        }
      })
      .catch((err) => console.warn(`[quiver] teleport status failed: ${(err as Error).message}`));
  },
  onStop: async (host) => {
    const { session, tunnels } = getTeleport(host);
    session.stop();
    await tunnels.stopAll();
  },
});

