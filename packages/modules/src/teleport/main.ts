import {
  DbConnectionSchema,
  KUBE_CLUSTER_NAME,
  KubeQuerySchema,
  QuiverError,
  lastKubeNamespace,
  clusterLabel,
  dbKindForProtocol,
  defineCommand,
  defineModule,
  isPinned,
  newDbConnection,
  normalizeProxy,
  nowIso,
  parseTshDatabases,
  parseTshKubeClusters,
  proxiesToAutoLogin,
  proxyAddress,
  sameProxy,
  togglePin,
  type DbConnection,
  type DbConnectionSummary,
  type HostApi,
  type KubeHistoryEntry,
  type KubeRunResult,
  type KubeStreamRead,
  type ParsedDatabase,
  type ParsedKubeCluster,
  type TeleportClusterStatus,
  type TeleportDatabase,
  type TeleportKubeCluster,
  type TeleportLoginResult,
  type TeleportPin,
  type TeleportStatus,
  type TeleportTunnel,
} from '@quiver/core';
import { z } from 'zod';
import { COLLECTIONS, getConnection, listConnections } from '../db/connections';
import { getTeleport } from './runtime';
import type { TeleportSession } from './session';

const LIST_CACHE_MS = 30_000;

interface Cached<T> {
  at: number;
  value: T;
}

/** Per-cluster caches of `tsh db ls` and `tsh kube ls`, keyed by normalized proxy. */
const dbCache = new Map<string, Cached<ParsedDatabase[]>>();
const kubeCache = new Map<string, Cached<ParsedKubeCluster[]>>();

function invalidateCaches(proxy?: string | null): void {
  if (!proxy) {
    dbCache.clear();
    kubeCache.clear();
    return;
  }
  dbCache.delete(normalizeProxy(proxy));
  kubeCache.delete(normalizeProxy(proxy));
}

const usable = (c: TeleportClusterStatus) => c.state === 'logged-in' || c.state === 'expiring';

/** Clusters a listing applies to: the named one, else every cluster with a usable certificate. */
function targetClusters(session: TeleportSession, proxy: string | undefined): TeleportClusterStatus[] {
  const status = session.getStatus();
  if (proxy) {
    const resolved = session.resolveProxy(proxy);
    const cluster = status.clusters.find((c) => sameProxy(c.proxy, resolved));
    return cluster ? [cluster] : [{ proxy: resolved, cluster: null, user: null, roles: [], validUntil: null, kubeCluster: null, state: 'logged-out', current: false, configured: false }];
  }
  return status.clusters.filter(usable);
}

async function listDatabases(host: HostApi, proxy: string | undefined, refresh: boolean): Promise<TeleportDatabase[]> {
  const { session, tunnels } = getTeleport(host);
  const pins = host.config.get().teleport.pins;
  const running = tunnels.list();
  const out: TeleportDatabase[] = [];
  for (const cluster of targetClusters(session, proxy)) {
    const key = normalizeProxy(cluster.proxy);
    let cached = dbCache.get(key);
    if (refresh || !cached || Date.now() - cached.at > LIST_CACHE_MS) {
      const stdout = await session.run(['db', 'ls', '--format=json'], cluster.proxy);
      cached = { at: Date.now(), value: parseTshDatabases(stdout) };
      dbCache.set(key, cached);
    }
    for (const db of cached.value) {
      out.push({
        ...db,
        proxy: cluster.proxy,
        clusterName: cluster.cluster,
        pinned: isPinned(pins, 'db', cluster.proxy, db.name),
        tunnel: running.find((t) => t.kind === 'teleport' && t.target === db.name && sameProxy(t.proxy, cluster.proxy)) ?? null,
      });
    }
  }
  return out;
}

async function listKubeClusters(host: HostApi, proxy: string | undefined, refresh: boolean): Promise<TeleportKubeCluster[]> {
  const { session } = getTeleport(host);
  const pins = host.config.get().teleport.pins;
  const out: TeleportKubeCluster[] = [];
  for (const cluster of targetClusters(session, proxy)) {
    const key = normalizeProxy(cluster.proxy);
    let cached = kubeCache.get(key);
    if (refresh || !cached || Date.now() - cached.at > LIST_CACHE_MS) {
      const stdout = await session.run(['kube', 'ls', '--format=json'], cluster.proxy);
      cached = { at: Date.now(), value: parseTshKubeClusters(stdout) };
      kubeCache.set(key, cached);
    }
    for (const k of cached.value) out.push({ ...k, proxy: cluster.proxy, pinned: isPinned(pins, 'kube', cluster.proxy, k.name) });
  }
  return out;
}

const ProxyInput = z.string().optional().describe('Proxy address of the cluster (see teleport.status). Defaults to the only usable cluster, else the current tsh profile.');

// ---------- session ----------

const status = defineCommand({
  id: 'teleport.status',
  title: 'Teleport status',
  description:
    'Where tsh is, every known cluster with its proxy, name, user, certificate expiry and state (logged-out, expired, logged-in, expiring), whether a login is running, pinned resources, and the local tunnels. The top-level state is no-tsh or the best cluster state.',
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
    'Runs tsh login --proxy=<addr> for one cluster. The cluster default connector is SSO, so a browser window opens and the call returns when tsh exits (up to five minutes). Output lines are returned so links and MFA prompts are visible.',
  scope: 'global',
  mutating: true,
  input: z.object({ proxy: z.string().optional().describe('Proxy address to log in to; required when several clusters are known') }),
  handler: async ({ proxy }, ctx): Promise<TeleportLoginResult> => {
    const { session } = getTeleport(ctx.host);
    const result = await session.login(proxy);
    invalidateCaches(result.proxy);
    return result;
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
  description: 'Runs tsh logout for one cluster (proxy) or for all of them. This also affects tsh and kubectl in your terminal since profiles are shared. Tunnels of the affected clusters are stopped.',
  scope: 'global',
  mutating: true,
  input: z.object({ proxy: z.string().optional().describe('Proxy address; omit to log out of every cluster') }),
  handler: async ({ proxy }, ctx): Promise<TeleportStatus> => {
    const { session, tunnels } = getTeleport(ctx.host);
    if (proxy) await tunnels.stopCluster(proxy);
    else await tunnels.stopAll();
    invalidateCaches(proxy);
    getTeleport(ctx.host).kube.forget(proxy);
    return session.logout(proxy);
  },
});

// ---------- clusters ----------

const clusterAdd = defineCommand({
  id: 'teleport.cluster.add',
  title: 'Add Teleport cluster',
  description: 'Adds a proxy address to the clusters shown in the Teleport module. Clusters tsh already has a profile for appear without this.',
  scope: 'global',
  input: z.object({ proxy: z.string().describe('Proxy address, e.g. teleport.example.com:443') }),
  handler: async ({ proxy }, ctx): Promise<TeleportStatus> => {
    const addr = proxyAddress(proxy);
    if (!addr) throw new QuiverError('INVALID_INPUT', 'Proxy address is empty');
    const teleport = ctx.host.config.get().teleport;
    if (!teleport.proxies.some((p) => sameProxy(p, addr))) await ctx.host.config.update({ teleport: { ...teleport, proxies: [...teleport.proxies, addr] } });
    return getTeleport(ctx.host).session.refresh();
  },
});

const clusterRemove = defineCommand({
  id: 'teleport.cluster.remove',
  title: 'Remove Teleport cluster',
  description: 'Removes a proxy address from Settings along with its pins, and stops its tunnels. The tsh profile on disk is untouched; use teleport.logout for that.',
  scope: 'global',
  mutating: true,
  input: z.object({ proxy: z.string() }),
  handler: async ({ proxy }, ctx): Promise<TeleportStatus> => {
    const { session, tunnels } = getTeleport(ctx.host);
    const teleport = ctx.host.config.get().teleport;
    await tunnels.stopCluster(proxy);
    invalidateCaches(proxy);
    await ctx.host.config.update({
      teleport: { ...teleport, proxies: teleport.proxies.filter((p) => !sameProxy(p, proxy)), pins: teleport.pins.filter((p) => !sameProxy(p.proxy, proxy)) },
    });
    return session.refresh();
  },
});

// ---------- pins ----------

const pin = defineCommand({
  id: 'teleport.pin',
  title: 'Pin Teleport resource',
  description: 'Pins or unpins a database or Kubernetes cluster of a Teleport cluster so it shows at the top of the Teleport sidebar. Omit pinned to toggle. Returns the full pin list.',
  scope: 'global',
  input: z.object({
    proxy: z.string().describe('Proxy address of the cluster the resource belongs to'),
    kind: z.enum(['db', 'kube']),
    name: z.string(),
    pinned: z.boolean().optional(),
  }),
  handler: async ({ proxy, kind, name, pinned }, ctx): Promise<TeleportPin[]> => {
    const teleport = ctx.host.config.get().teleport;
    const next = pinned ?? !isPinned(teleport.pins, kind, proxy, name);
    const pins = togglePin(teleport.pins, { proxy, kind, name }, next);
    await ctx.host.config.update({ teleport: { ...teleport, pins } });
    ctx.host.emit('teleport.changed', { reason: 'pins' });
    return pins;
  },
});

// ---------- databases ----------

const dbList = defineCommand({
  id: 'teleport.db.list',
  title: 'List Teleport databases',
  description:
    'Databases the current roles can reach (tsh db ls) across every logged-in cluster, or one cluster when proxy is given: name, protocol, allowed database users, whether it is pinned, and the running tunnel if any. Cached for 30 seconds per cluster unless refresh is true.',
  scope: 'global',
  input: z.object({ proxy: ProxyInput, refresh: z.boolean().optional() }),
  handler: async ({ proxy, refresh }, ctx): Promise<TeleportDatabase[]> => listDatabases(ctx.host, proxy, Boolean(refresh)),
});

function findTeleportConnection(connections: DbConnectionSummary[], proxy: string, database: string, dbUser?: string): DbConnectionSummary | undefined {
  return connections.find(
    (c) => c.access.type === 'teleport' && c.access.database === database && (sameProxy(c.access.proxy, proxy) || c.access.proxy === '') && (!dbUser || c.access.dbUser === dbUser),
  );
}

const dbConnect = defineCommand({
  id: 'teleport.db.connect',
  title: 'Connect to a Teleport database',
  description:
    'Starts (or reuses) a local tunnel with tsh proxy db --tunnel for the database and user, then creates or reuses a Quiver database connection bound to it in the workspace (MySQL and Redis; other protocols only get the tunnel port). Without proxy the database is looked up across logged-in clusters and must be unique. dbUser defaults to the existing connection\'s user, or the single allowed user.',
  scope: 'global',
  input: z.object({
    proxy: ProxyInput,
    database: z.string().describe('Teleport database name (see teleport.db.list)'),
    dbUser: z.string().optional(),
    name: z.string().optional().describe('Name for a newly created Quiver connection; defaults to the database name'),
  }),
  handler: async ({ proxy: proxyArg, database, dbUser, name }, ctx): Promise<{ tunnel: TeleportTunnel; connection: DbConnectionSummary | null; database: TeleportDatabase; message: string | null }> => {
    const { tunnels } = getTeleport(ctx.host);
    let candidates = (await listDatabases(ctx.host, proxyArg, false)).filter((d) => d.name === database);
    if (!candidates.length) candidates = (await listDatabases(ctx.host, proxyArg, true)).filter((d) => d.name === database);
    if (!candidates.length) {
      throw new QuiverError('NOT_FOUND', `Teleport database "${database}" was not found${proxyArg ? ` on ${proxyArg}` : ' on any logged-in cluster'}. Run teleport.db.list to see what your roles allow.`);
    }
    if (candidates.length > 1) {
      throw new QuiverError('INVALID_INPUT', `"${database}" exists on several clusters; pass proxy: ${candidates.map((d) => d.proxy).join(', ')}`, { proxies: candidates.map((d) => d.proxy) });
    }
    const db = candidates[0];
    const proxy = db.proxy;

    const connections = ctx.workspace ? await listConnections(ctx.workspace) : [];
    let user = dbUser?.trim() ?? '';
    if (!user) {
      const prior = findTeleportConnection(connections, proxy, database);
      if (prior?.access.type === 'teleport') user = prior.access.dbUser;
    }
    if (!user) {
      const concrete = db.allowedUsers.filter((u) => u !== '*');
      if (concrete.length === 1) user = concrete[0];
      else
        throw new QuiverError('INVALID_INPUT', `Pick a database user for ${database}: ${db.allowedUsers.length ? db.allowedUsers.join(', ') : 'none allowed'}`, { allowedUsers: db.allowedUsers });
    }

    const tunnel = await tunnels.ensure({ kind: 'teleport', proxy, database, dbUser: user }, 'pinned');

    let connection: DbConnectionSummary | null = null;
    let message: string | null = null;
    const kind = dbKindForProtocol(db.protocol);
    if (!ctx.workspace) {
      message = `Tunnel is listening on 127.0.0.1:${tunnel.port}. Open a workspace to attach a Quiver connection.`;
    } else if (!kind) {
      message = `Quiver has no ${db.protocol} client yet. The tunnel is listening on 127.0.0.1:${tunnel.port} for other tools.`;
    } else {
      const existing = findTeleportConnection(connections, proxy, database, user);
      if (existing) {
        connection = existing;
      } else {
        const created: DbConnection = newDbConnection(kind, {
          name: name?.trim() || database,
          host: '127.0.0.1',
          port: 0,
          user: kind === 'mysql' ? user : '',
          access: { type: 'teleport', proxy, database, dbUser: user },
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
  description: 'Stops the local tunnel for a Teleport database (all users, or one dbUser; all clusters, or one proxy), or a tunnel by id. Connections using it reconnect, and restart the tunnel, on their next query.',
  scope: 'global',
  mutating: true,
  input: z.object({ proxy: z.string().optional(), database: z.string().optional(), dbUser: z.string().optional(), tunnelId: z.string().optional() }),
  handler: async ({ proxy, database, dbUser, tunnelId }, ctx) => {
    const { tunnels } = getTeleport(ctx.host);
    if (tunnelId) return { stopped: (await tunnels.stop(tunnelId)) ? 1 : 0 };
    if (!database) throw new QuiverError('INVALID_INPUT', 'Provide database or tunnelId');
    return { stopped: await tunnels.stopTeleport(database, { proxy, dbUser }) };
  },
});

// ---------- kubernetes ----------

const kubeList = defineCommand({
  id: 'teleport.kube.list',
  title: 'List Teleport Kubernetes clusters',
  description:
    'Kubernetes clusters reachable through Teleport (tsh kube ls) across every logged-in cluster, or one when proxy is given, with the one selected in kubeconfig and whether each is pinned. Cached for 30 seconds per cluster unless refresh is true.',
  scope: 'global',
  input: z.object({ proxy: ProxyInput, refresh: z.boolean().optional() }),
  handler: async ({ proxy, refresh }, ctx): Promise<TeleportKubeCluster[]> => listKubeClusters(ctx.host, proxy, Boolean(refresh)),
});

/** The Teleport cluster a Kubernetes cluster belongs to: the given proxy, else the only cluster that lists it. */
async function resolveKubeProxy(host: HostApi, proxyArg: string | undefined, cluster: string): Promise<string> {
  const { session } = getTeleport(host);
  if (proxyArg) return session.resolveProxy(proxyArg);
  const matches = (await listKubeClusters(host, undefined, false)).filter((k) => k.name === cluster);
  if (matches.length > 1) throw new QuiverError('INVALID_INPUT', `"${cluster}" exists on several clusters; pass proxy: ${matches.map((k) => k.proxy).join(', ')}`);
  return matches[0]?.proxy ?? session.resolveProxy(undefined);
}

const KubeClusterInput = z.string().max(253).regex(KUBE_CLUSTER_NAME, 'Not a Kubernetes cluster name').describe('Kubernetes cluster name from teleport.kube.list');

const kubeLogin = defineCommand({
  id: 'teleport.kube.login',
  title: 'Set kubectl context for your terminal',
  description:
    'Runs tsh kube login <cluster> on the given Teleport cluster, which rewrites the kubeconfig your terminal uses so kubectl there points at this cluster. Not needed for teleport.kube.query, which never touches that kubeconfig.',
  scope: 'global',
  mutating: true,
  input: z.object({ proxy: ProxyInput, cluster: KubeClusterInput }),
  handler: async ({ proxy: proxyArg, cluster }, ctx) => {
    const { session } = getTeleport(ctx.host);
    const proxy = await resolveKubeProxy(ctx.host, proxyArg, cluster);
    const output = await session.run(['kube', 'login', cluster], proxy);
    invalidateCaches();
    void session.refresh().catch(() => {});
    return { proxy: session.resolveProxy(proxy), cluster, output: output.trim() };
  },
});

// ---------- kubernetes queries ----------

const RunIdInput = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/)
  .describe('Id of the run, chosen by the caller so it can cancel before the result arrives');

const kubeQuery = defineCommand({
  id: 'teleport.kube.query',
  title: 'Query a Kubernetes cluster (read-only)',
  description:
    'Runs one predefined, read-only kubectl operation against a Kubernetes cluster reached through Teleport: list, get, describe, logs, logs-follow, events, top-pods, top-nodes, rollout-status, rollout-history, namespaces, api-resources, version or can-i. ' +
    'There is no way to pass a kubectl command, arguments or flags: pick an operation and fill in its typed parameters. Secrets cannot be read. ' +
    'The query targets the cluster explicitly through a private kubeconfig, so the kubectl context in your terminal is untouched. ' +
    'Returns stdout, stderr, the exit code and the duration. logs-follow returns at once with streaming: true; read more with teleport.kube.stream.read and stop it with teleport.kube.cancel.',
  scope: 'global',
  input: z.object({
    proxy: ProxyInput,
    cluster: KubeClusterInput,
    query: KubeQuerySchema,
    runId: RunIdInput.optional(),
    timeoutSeconds: z.number().int().min(1).max(600).optional().describe('Stop a one-shot query after this long (default 60)'),
    record: z.boolean().optional().describe('Add the run to the local history (default true)'),
  }),
  handler: async ({ proxy: proxyArg, cluster, query, runId, timeoutSeconds, record }, ctx): Promise<KubeRunResult> => {
    const proxy = await resolveKubeProxy(ctx.host, proxyArg, cluster);
    return getTeleport(ctx.host).kube.run({ proxy, cluster, query, runId, caller: ctx.caller, timeoutMs: (timeoutSeconds ?? 60) * 1000, record: record ?? true });
  },
});

const kubeStreamRead = defineCommand({
  id: 'teleport.kube.stream.read',
  title: 'Read a followed Kubernetes log',
  description: 'Lines of a logs-follow run after `since` (the `next` value of the previous read), whether it is still running, and how many lines fell out of its 5000-line buffer.',
  scope: 'global',
  input: z.object({ runId: RunIdInput, since: z.number().int().min(0).optional() }),
  handler: async ({ runId, since }, ctx): Promise<KubeStreamRead> => getTeleport(ctx.host).kube.read(runId, since ?? 0),
});

const kubeCancel = defineCommand({
  id: 'teleport.kube.cancel',
  title: 'Stop a Kubernetes query',
  description: 'Stops a running query or a followed log by its runId. Only affects the local tsh kubectl process.',
  scope: 'global',
  input: z.object({ runId: RunIdInput }),
  handler: async ({ runId }, ctx) => ({ cancelled: getTeleport(ctx.host).kube.cancel(runId) }),
});

const HistoryFilter = { proxy: z.string().optional().describe('Only this Teleport cluster'), cluster: KubeClusterInput.optional() };

function historyMatches(e: KubeHistoryEntry, proxy: string | undefined, cluster: string | undefined): boolean {
  return (!proxy || sameProxy(e.proxy, proxy)) && (!cluster || e.cluster === cluster);
}

const kubeHistoryList = defineCommand({
  id: 'teleport.kube.history.list',
  title: 'Kubernetes query history',
  description:
    'Past Kubernetes queries on this machine, newest first, pinned ones included: cluster, operation and parameters (never a command line), time, exit code and duration, plus the namespace last used when a cluster is given. Entries are validated like live queries; tampered ones are left out.',
  scope: 'global',
  input: z.object({ ...HistoryFilter, limit: z.number().int().min(1).max(500).optional() }),
  handler: async ({ proxy, cluster, limit }, ctx): Promise<{ entries: KubeHistoryEntry[]; lastNamespace: string | null }> => {
    const kube = getTeleport(ctx.host).kube;
    const entries = (await kube.loadHistory()).filter((e) => historyMatches(e, proxy, cluster));
    const first = entries[0];
    return { entries: entries.slice(0, limit ?? 500), lastNamespace: cluster && first ? lastKubeNamespace(entries, first.proxy, cluster) : null };
  },
});

const kubeHistoryRerun = defineCommand({
  id: 'teleport.kube.history.rerun',
  title: 'Run a Kubernetes query again',
  description: 'Runs a history entry again on the same cluster. It goes through the same validation as teleport.kube.query.',
  scope: 'global',
  input: z.object({ id: z.string(), runId: RunIdInput.optional() }),
  handler: async ({ id, runId }, ctx): Promise<KubeRunResult> => {
    const kube = getTeleport(ctx.host).kube;
    const entry = (await kube.loadHistory()).find((e) => e.id === id);
    if (!entry) throw new QuiverError('NOT_FOUND', `No Kubernetes history entry ${id}`);
    return kube.run({ proxy: entry.proxy, cluster: entry.cluster, query: entry.query, runId, caller: ctx.caller, timeoutMs: 60_000, record: true });
  },
});

const kubeHistoryPin = defineCommand({
  id: 'teleport.kube.history.pin',
  title: 'Pin a Kubernetes query',
  description: 'Pins or unpins a history entry as a favourite of its cluster. Pinned entries are kept when the history is trimmed or cleared. Omit pinned to toggle.',
  scope: 'global',
  input: z.object({ id: z.string(), pinned: z.boolean().optional() }),
  handler: async ({ id, pinned }, ctx): Promise<KubeHistoryEntry> => {
    const kube = getTeleport(ctx.host).kube;
    const entries = await kube.loadHistory();
    const entry = entries.find((e) => e.id === id);
    if (!entry) throw new QuiverError('NOT_FOUND', `No Kubernetes history entry ${id}`);
    const next = { ...entry, pinned: pinned ?? !entry.pinned };
    await kube.saveHistory(entries.map((e) => (e.id === id ? next : e)));
    return next;
  },
});

const kubeHistoryDelete = defineCommand({
  id: 'teleport.kube.history.delete',
  title: 'Delete a Kubernetes history entry',
  description: 'Removes one entry from the local Kubernetes query history.',
  scope: 'global',
  mutating: true,
  input: z.object({ id: z.string() }),
  handler: async ({ id }, ctx) => {
    const kube = getTeleport(ctx.host).kube;
    const entries = await kube.loadHistory();
    const next = entries.filter((e) => e.id !== id);
    if (next.length !== entries.length) await kube.saveHistory(next);
    return { deleted: entries.length - next.length };
  },
});

const kubeHistoryClear = defineCommand({
  id: 'teleport.kube.history.clear',
  title: 'Clear Kubernetes query history',
  description: 'Removes the local Kubernetes query history, of one cluster or all of them. Pinned entries stay unless keepPinned is false.',
  scope: 'global',
  mutating: true,
  input: z.object({ ...HistoryFilter, keepPinned: z.boolean().optional() }),
  handler: async ({ proxy, cluster, keepPinned }, ctx) => {
    const kube = getTeleport(ctx.host).kube;
    const entries = await kube.loadHistory();
    const next = entries.filter((e) => !historyMatches(e, proxy, cluster) || (e.pinned && keepPinned !== false));
    await kube.saveHistory(next);
    return { deleted: entries.length - next.length };
  },
});

export const teleportModule = defineModule({
  id: 'teleport',
  commands: [
    status,
    login,
    loginCancel,
    logout,
    clusterAdd,
    clusterRemove,
    pin,
    dbList,
    dbConnect,
    dbDisconnect,
    kubeList,
    kubeLogin,
    kubeQuery,
    kubeStreamRead,
    kubeCancel,
    kubeHistoryList,
    kubeHistoryRerun,
    kubeHistoryPin,
    kubeHistoryDelete,
    kubeHistoryClear,
  ],
  onStart: (host) => {
    const { session } = getTeleport(host);
    // Never block startup on tsh; the UI polls status as soon as it mounts.
    void session
      .start()
      .then(async (initial) => {
        // One browser flow at a time: expired clusters are logged into one after another.
        for (const proxy of proxiesToAutoLogin(host.config.get().teleport, initial.clusters)) {
          const cluster = initial.clusters.find((c) => sameProxy(c.proxy, proxy));
          console.log(`[quiver] teleport certificate for ${cluster ? clusterLabel(cluster) : proxy} expired, starting tsh login (${nowIso()})`);
          await session.login(proxy).catch((err) => console.warn(`[quiver] teleport auto-login for ${proxy} failed: ${(err as Error).message}`));
        }
      })
      .catch((err) => console.warn(`[quiver] teleport status failed: ${(err as Error).message}`));
  },
  onStop: async (host) => {
    const { session, tunnels, kube } = getTeleport(host);
    session.stop();
    kube.stopAll();
    await tunnels.stopAll();
  },
});
