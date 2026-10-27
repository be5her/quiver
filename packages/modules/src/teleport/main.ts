import {
  DbConnectionSchema,
  KUBE_CLUSTER_NAME,
  KubeActionSchema,
  KubePortForwardSpecSchema,
  KubeQuerySchema,
  QuiverError,
  lastKubeNamespace,
  loggedOutCluster,
  clusterLabel,
  dbKindForProtocol,
  defineCommand,
  defineModule,
  isAutoRenewOn,
  isDestructiveKubeAction,
  isKubeProtected,
  isPinned,
  kubeActionTarget,
  newDbConnection,
  normalizeProxy,
  nowIso,
  parseTshDatabases,
  parseTshKubeClusters,
  proxiesToAutoLogin,
  proxyAddress,
  resolveKubeAction,
  sameProxy,
  setAutoRenew,
  setKubeProtected,
  togglePin,
  type Caller,
  type DbConnection,
  type DbConnectionSummary,
  type HostApi,
  type KubeActionPreview,
  type KubeActionResult,
  type KubeHistoryEntry,
  type KubePortForward,
  type KubePreview,
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
    return cluster ? [cluster] : [loggedOutCluster(resolved, false)];
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
  const { pins, protectedKubes } = host.config.get().teleport;
  const out: TeleportKubeCluster[] = [];
  for (const cluster of targetClusters(session, proxy)) {
    const key = normalizeProxy(cluster.proxy);
    let cached = kubeCache.get(key);
    if (refresh || !cached || Date.now() - cached.at > LIST_CACHE_MS) {
      const stdout = await session.run(['kube', 'ls', '--format=json'], cluster.proxy);
      cached = { at: Date.now(), value: parseTshKubeClusters(stdout) };
      kubeCache.set(key, cached);
    }
    for (const k of cached.value) out.push({ ...k, proxy: cluster.proxy, pinned: isPinned(pins, 'kube', cluster.proxy, k.name), protected: isKubeProtected(protectedKubes, cluster.proxy, k.name) });
  }
  return out;
}

const ProxyInput = z.string().optional().describe('Proxy address of the cluster (see teleport.status). Defaults to the only usable cluster, else the current tsh profile.');

// ---------- session ----------

const status = defineCommand({
  id: 'teleport.status',
  title: 'Teleport status',
  description:
    'Where tsh is, every known cluster with its proxy, name, user, certificate expiry and state (logged-out, expired, logged-in, expiring), whether a login is running, pinned resources, and the local tunnels. Per cluster, autoRenew says whether Keep me logged in renews its certificate before it expires, and renewal the last automatic attempt (lastAttemptAt, lastResult ok, failed or cancelled, lastError, nextEligibleAt, running, waitingForFocus). The top-level state is no-tsh or the best cluster state.',
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
  description:
    'Runs tsh logout for one cluster (proxy) or for all of them. This also affects tsh and kubectl in your terminal since profiles are shared. Tunnels and Kubernetes port forwards of the affected clusters are stopped.',
  scope: 'global',
  mutating: true,
  input: z.object({ proxy: z.string().optional().describe('Proxy address; omit to log out of every cluster') }),
  handler: async ({ proxy }, ctx): Promise<TeleportStatus> => {
    const { session, tunnels, forwards } = getTeleport(ctx.host);
    // No port forward may start on the cluster between stopping its forwards and the end of the logout.
    return forwards.refuseStartsWhile(proxy, async () => {
      if (proxy) await Promise.all([tunnels.stopCluster(proxy), forwards.stopCluster(proxy)]);
      else await Promise.all([tunnels.stopAll(), forwards.stopAll()]);
      invalidateCaches(proxy);
      getTeleport(ctx.host).kube.forget(proxy);
      return session.logout(proxy);
    });
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
  description:
    'Removes a proxy address from Settings along with its pins and Keep me logged in, and stops its tunnels and Kubernetes port forwards. Protected Kubernetes clusters stay protected. The tsh profile on disk is untouched; use teleport.logout for that.',
  scope: 'global',
  mutating: true,
  input: z.object({ proxy: z.string() }),
  handler: async ({ proxy }, ctx): Promise<TeleportStatus> => {
    const { session, tunnels, forwards } = getTeleport(ctx.host);
    const teleport = ctx.host.config.get().teleport;
    session.abandonRenewal(proxy);
    await Promise.all([tunnels.stopCluster(proxy), forwards.stopCluster(proxy)]);
    invalidateCaches(proxy);
    await ctx.host.config.update({
      teleport: {
        ...teleport,
        proxies: teleport.proxies.filter((p) => !sameProxy(p, proxy)),
        pins: teleport.pins.filter((p) => !sameProxy(p.proxy, proxy)),
        autoRenew: setAutoRenew(teleport.autoRenew, proxy, false),
      },
    });
    return session.refresh();
  },
});

const clusterAutoRenew = defineCommand({
  id: 'teleport.cluster.autoRenew',
  title: 'Keep me logged in to a Teleport cluster',
  description:
    'Turns Keep me logged in on or off for one cluster on this machine. When on, Quiver runs tsh login --proxy=<addr> for the cluster when its certificate is about to expire (less than 30 minutes left) or has expired, at most once per 10 minutes, one cluster at a time, and restarts its tunnels afterwards. An expired certificate needs the browser for SSO, so that renewal waits until the Quiver window is in front. Returns the status.',
  scope: 'global',
  // It changes what Quiver does on this machine: logins that may open the browser.
  mutating: true,
  input: z.object({ proxy: z.string().describe('Proxy address of the cluster (see teleport.status)'), enabled: z.boolean() }),
  handler: async ({ proxy, enabled }, ctx): Promise<TeleportStatus> => {
    const addr = proxyAddress(proxy);
    if (!addr) throw new QuiverError('INVALID_INPUT', 'Proxy address is empty');
    const teleport = ctx.host.config.get().teleport;
    if (isAutoRenewOn(teleport, addr) !== enabled) await ctx.host.config.update({ teleport: { ...teleport, autoRenew: setAutoRenew(teleport.autoRenew, addr, enabled) } });
    // Turned off while its renewal runs or waits: that tsh login is cancelled, not left to finish.
    if (!enabled) getTeleport(ctx.host).session.abandonRenewal(addr);
    ctx.host.emit('teleport.changed', { reason: 'status' });
    // A certificate that is due already is renewed now rather than on the next poll.
    return getTeleport(ctx.host).session.refresh();
  },
});

const windowFocus = defineCommand({
  id: 'teleport.window.focus',
  title: 'Tell Teleport whether Quiver is in front',
  description: 'The window reports whether it is focused, so a certificate renewal that opens the browser waits until the user is looking.',
  scope: 'global',
  hidden: true,
  input: z.object({ focused: z.boolean() }),
  handler: async ({ focused }, ctx) => {
    // Only the window knows; an agent claiming focus could make a renewal open the browser behind the user's back.
    if (ctx.caller !== 'ui') throw new QuiverError('INVALID_INPUT', 'Window focus is only reported by the Quiver window');
    getTeleport(ctx.host).session.setFocused(focused);
    return { focused };
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
    'Starts (or reuses) a local tunnel with tsh proxy db --tunnel for the database and user, then creates or reuses a Quiver database connection bound to it in the workspace (MySQL, PostgreSQL and Redis; other protocols only get the tunnel port). PostgreSQL needs dbName, the database inside the server, which tsh passes as --db-name. Without proxy the database is looked up across logged-in clusters and must be unique. dbUser defaults to the existing connection\'s user, or the single allowed user.',
  scope: 'global',
  input: z.object({
    proxy: ProxyInput,
    database: z.string().describe('Teleport database name (see teleport.db.list)'),
    dbUser: z.string().optional(),
    dbName: z.string().optional().describe('PostgreSQL: the database inside the server (--db-name)'),
    name: z.string().optional().describe('Name for a newly created Quiver connection; defaults to the database name'),
  }),
  handler: async ({ proxy: proxyArg, database, dbUser, dbName, name }, ctx): Promise<{ tunnel: TeleportTunnel; connection: DbConnectionSummary | null; database: TeleportDatabase; message: string | null }> => {
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

    const kind = dbKindForProtocol(db.protocol);
    const connections0 = connections;
    let name0 = dbName?.trim() ?? '';
    if (kind === 'postgres' && !name0) {
      const prior = findTeleportConnection(connections0, proxy, database, user);
      name0 = prior?.database ?? '';
    }
    if (kind === 'postgres' && !name0) {
      throw new QuiverError('INVALID_INPUT', `PostgreSQL needs the database name inside ${database} (tsh proxy db passes it as --db-name): pass dbName.`, { needs: 'dbName' });
    }
    const tunnel = await tunnels.ensure({ kind: 'teleport', proxy, database, dbUser: user, dbName: kind === 'postgres' ? name0 : null }, 'pinned');

    let connection: DbConnectionSummary | null = null;
    let message: string | null = null;
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
          user: kind === 'redis' ? '' : user,
          database: kind === 'postgres' ? name0 : '',
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
    'Kubernetes clusters reachable through Teleport (tsh kube ls) across every logged-in cluster, or one when proxy is given, with the one selected in kubeconfig and whether each is pinned or protected. Cached for 30 seconds per cluster unless refresh is true.',
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

const kubePreview = defineCommand({
  id: 'teleport.kube.preview',
  title: 'Preview a Kubernetes query',
  description:
    'The exact command line teleport.kube.query would spawn for a query (tsh path, the template arguments, --kubeconfig and --context), without running anything, plus the one-time tsh kube login that prepares the private kubeconfig if it has not run yet.',
  scope: 'global',
  input: z.object({ proxy: ProxyInput, cluster: KubeClusterInput, query: KubeQuerySchema }),
  handler: async ({ proxy: proxyArg, cluster, query }, ctx): Promise<KubePreview> => {
    const proxy = await resolveKubeProxy(ctx.host, proxyArg, cluster);
    return getTeleport(ctx.host).kube.preview(proxy, cluster, query);
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

// ---------- kubernetes actions and port forwards ----------

const ConfirmClusterInput = z.string().max(253).optional().describe('For a protected cluster: its name, as the user typed it to confirm. Agents cannot act on protected clusters unless the user allows it in Settings.');

/**
 * Writes go only to a Kubernetes cluster `tsh kube ls` lists under exactly that name. `tsh kube
 * login` also accepts other names for a cluster (an auto-discovered cluster's short name), which
 * would reach a protected cluster without matching its entry in the protected list.
 */
async function requireExactKube(host: HostApi, proxy: string, cluster: string): Promise<void> {
  if ((await listKubeClusters(host, proxy, false)).some((k) => k.name === cluster)) return;
  if ((await listKubeClusters(host, proxy, true)).some((k) => k.name === cluster)) return;
  throw new QuiverError('NOT_FOUND', `No Kubernetes cluster is named exactly "${cluster}" on ${proxy}. Actions and port forwards take the exact name from teleport.kube.list.`, { proxy, cluster });
}

/**
 * Protected clusters: from Quiver (and the command line) the user's typed cluster name has to come
 * with the call; agents are refused outright unless Settings > Teleport allows them. Port forwards
 * change nothing in the cluster, so only agents are held back from them.
 */
async function guardProtected(host: HostApi, caller: Caller, proxy: string, cluster: string, confirmCluster: string | undefined, what: 'action' | 'port forward'): Promise<void> {
  await requireExactKube(host, proxy, cluster);
  const teleport = host.config.get().teleport;
  if (!isKubeProtected(teleport.protectedKubes, proxy, cluster)) return;
  if (caller === 'mcp') {
    if (teleport.agentActionsOnProtected) return;
    throw new QuiverError('MUTATION_BLOCKED', `${cluster} is a protected cluster: agents may not run Kubernetes ${what}s on it. Run it from Quiver, or allow agents on protected clusters in Settings > Teleport.`, {
      reason: 'protected-cluster',
      cluster,
    });
  }
  if (what === 'action' && confirmCluster !== cluster) {
    throw new QuiverError('INVALID_INPUT', `${cluster} is a protected cluster: type its name to confirm the action (confirmCluster).`, { reason: 'protected-cluster', needs: 'confirmCluster', cluster });
  }
}

const KUBE_ACTION_SUMMARY =
  'scale (deployments, statefulsets, replicasets; 0-1000 replicas), rollout-restart, rollout-undo (optionally toRevision), rollout-pause and rollout-resume (deployments), delete (one pod or one job, by name), cordon, uncordon, set-image (one container, a strict image reference) and cronjob-trigger (create job --from=cronjob/<name>)';

const kubeAction = defineCommand({
  id: 'teleport.kube.action',
  title: 'Run a Kubernetes action',
  description:
    `Runs one predefined kubectl write action against a Kubernetes cluster reached through Teleport: ${KUBE_ACTION_SUMMARY}. ` +
    'Every action changes exactly one named object in an explicit namespace: no selectors, no --all, no command, arguments, flags, YAML or patches; exec, apply, edit, patch and drain do not exist here. ' +
    'Check the exact command first with teleport.kube.action.preview. A protected cluster refuses agents unless the user allows it in Settings. Recorded in the local history as an action. ' +
    'Returns stdout, stderr, the exit code and the exact command that ran.',
  scope: 'global',
  mutating: true,
  input: z.object({
    proxy: ProxyInput,
    cluster: KubeClusterInput,
    action: KubeActionSchema,
    runId: RunIdInput.optional(),
    timeoutSeconds: z.number().int().min(1).max(600).optional().describe('Stop the action after this long (default 60)'),
    confirmCluster: ConfirmClusterInput,
  }),
  // An agent is refused on a protected cluster whatever the user answers, so it is never asked about one.
  beforeApproval: async ({ proxy, cluster }, ctx) => guardProtected(ctx.host, ctx.caller, await resolveKubeProxy(ctx.host, proxy, cluster), cluster, undefined, 'action'),
  handler: async ({ proxy: proxyArg, cluster, action, runId, timeoutSeconds, confirmCluster }, ctx): Promise<KubeActionResult> => {
    const proxy = await resolveKubeProxy(ctx.host, proxyArg, cluster);
    await guardProtected(ctx.host, ctx.caller, proxy, cluster, confirmCluster, 'action');
    return getTeleport(ctx.host).kube.runAction({ proxy, cluster, action: resolveKubeAction(action), runId, caller: ctx.caller, timeoutMs: (timeoutSeconds ?? 60) * 1000 });
  },
});

const kubeActionPreview = defineCommand({
  id: 'teleport.kube.action.preview',
  title: 'Preview a Kubernetes action',
  description:
    'The exact command line and argv teleport.kube.action would spawn for an action, without running anything, plus the action with its defaults filled in (pass it back to run exactly this), the object it changes, whether it is destructive (delete, scale to 0, rollout-undo, cordon) and whether the cluster is protected.',
  scope: 'global',
  input: z.object({ proxy: ProxyInput, cluster: KubeClusterInput, action: KubeActionSchema }),
  handler: async ({ proxy: proxyArg, cluster, action }, ctx): Promise<KubeActionPreview> => {
    const proxy = await resolveKubeProxy(ctx.host, proxyArg, cluster);
    await requireExactKube(ctx.host, proxy, cluster);
    const resolved = resolveKubeAction(action);
    const preview = await getTeleport(ctx.host).kube.previewAction(proxy, cluster, resolved);
    return {
      ...preview,
      action: resolved,
      target: kubeActionTarget(resolved),
      destructive: isDestructiveKubeAction(resolved),
      protected: isKubeProtected(ctx.host.config.get().teleport.protectedKubes, proxy, cluster),
    };
  },
});

/** Agents may protect clusters (it only makes Quiver stricter), so the list is capped to keep it from growing without end. */
const MAX_PROTECTED_KUBES = 200;

function refuseAgentUnprotect(caller: Caller, cluster: string, on: boolean): void {
  if (!on && caller === 'mcp') throw new QuiverError('MUTATION_BLOCKED', 'Only the user can unprotect a cluster, from Quiver.', { reason: 'protected-cluster', cluster });
}

const kubeProtect = defineCommand({
  id: 'teleport.kube.protect',
  title: 'Protect a Kubernetes cluster',
  description:
    'Marks a Kubernetes cluster as protected, or no longer protected. Actions on a protected cluster need its name typed in Quiver, and agents are refused actions and port forwards on it unless the user allows them in Settings. Agents may protect a cluster (by the exact name teleport.kube.list gives) but never unprotect one.',
  scope: 'global',
  mutating: ({ protected: on }) => !on,
  input: z.object({ proxy: ProxyInput, cluster: KubeClusterInput, protected: z.boolean() }),
  // Refused whatever the user answers, so an agent's unprotect is never asked about.
  beforeApproval: async ({ cluster, protected: on }, ctx) => refuseAgentUnprotect(ctx.caller, cluster, on),
  handler: async ({ proxy: proxyArg, cluster, protected: on }, ctx) => {
    refuseAgentUnprotect(ctx.caller, cluster, on);
    const proxy = await resolveKubeProxy(ctx.host, proxyArg, cluster);
    // An agent's entry under a name tsh does not list would protect nothing while looking as if it did.
    if (on && ctx.caller === 'mcp') await requireExactKube(ctx.host, proxy, cluster);
    const teleport = ctx.host.config.get().teleport;
    if (on && !isKubeProtected(teleport.protectedKubes, proxy, cluster) && teleport.protectedKubes.length >= MAX_PROTECTED_KUBES) {
      throw new QuiverError('INVALID_INPUT', `At most ${MAX_PROTECTED_KUBES} Kubernetes clusters can be protected. Unprotect one in Quiver first.`, { max: MAX_PROTECTED_KUBES });
    }
    await ctx.host.config.update({ teleport: { ...teleport, protectedKubes: setKubeProtected(teleport.protectedKubes, { proxy, name: cluster }, on) } });
    ctx.host.emit('teleport.changed', { reason: 'protected' });
    return { proxy, cluster, protected: on };
  },
});

const ForwardFilter = { proxy: z.string().optional().describe('Only this Teleport cluster'), cluster: KubeClusterInput.optional() };

const portForwardStart = defineCommand({
  id: 'teleport.kube.portForward.start',
  title: 'Forward a Kubernetes port',
  description:
    'Runs tsh kubectl port-forward --address 127.0.0.1 to one pod, service or deployment and keeps it running until stopped, on a free local port unless localPort is given. Returns the forward with its local URL; a running forward to the same target and port is reused. ' +
    'Stopped by teleport.kube.portForward.stop, by logging out of the cluster and when Quiver quits. A protected cluster refuses agents unless the user allows it in Settings.',
  scope: 'global',
  mutating: true,
  input: z.object({ proxy: ProxyInput, cluster: KubeClusterInput, ...KubePortForwardSpecSchema.shape }),
  beforeApproval: async ({ proxy, cluster }, ctx) => guardProtected(ctx.host, ctx.caller, await resolveKubeProxy(ctx.host, proxy, cluster), cluster, undefined, 'port forward'),
  handler: async ({ proxy: proxyArg, cluster, kind, name, namespace, remotePort, localPort }, ctx): Promise<KubePortForward> => {
    const proxy = await resolveKubeProxy(ctx.host, proxyArg, cluster);
    await guardProtected(ctx.host, ctx.caller, proxy, cluster, undefined, 'port forward');
    return getTeleport(ctx.host).forwards.start({ proxy, cluster, spec: { kind, name, namespace, remotePort, localPort } });
  },
});

const portForwardList = defineCommand({
  id: 'teleport.kube.portForward.list',
  title: 'List Kubernetes port forwards',
  description: 'The running port forwards (all, one Teleport cluster or one Kubernetes cluster) with their target, local URL, state and last output. Forwards that exited on their own stay listed as exited until stopped.',
  scope: 'global',
  input: z.object(ForwardFilter),
  handler: async ({ proxy, cluster }, ctx): Promise<KubePortForward[]> =>
    getTeleport(ctx.host)
      .forwards.list()
      .filter((f) => (!proxy || sameProxy(f.proxy, proxy)) && (!cluster || f.cluster === cluster)),
});

const portForwardStop = defineCommand({
  id: 'teleport.kube.portForward.stop',
  title: 'Stop a Kubernetes port forward',
  description: 'Stops a port forward by id, with every process tsh started for it, and removes it from the list (also for one that already exited).',
  scope: 'global',
  mutating: true,
  input: z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) }),
  handler: async ({ id }, ctx) => ({ stopped: await getTeleport(ctx.host).forwards.stop(id) }),
});

const HistoryFilter = { proxy: z.string().optional().describe('Only this Teleport cluster'), cluster: KubeClusterInput.optional() };

function historyMatches(e: KubeHistoryEntry, proxy: string | undefined, cluster: string | undefined): boolean {
  return (!proxy || sameProxy(e.proxy, proxy)) && (!cluster || e.cluster === cluster);
}

const kubeHistoryList = defineCommand({
  id: 'teleport.kube.history.list',
  title: 'Kubernetes query history',
  description:
    'Past Kubernetes queries and actions on this machine, newest first, pinned ones included: kind (query or action), cluster, operation or action and its parameters (never a command line), time, exit code and duration, plus the namespace last used when a cluster is given. Entries are validated like live calls; tampered ones are left out.',
  scope: 'global',
  input: z.object({ ...HistoryFilter, limit: z.number().int().min(1).max(500).optional() }),
  handler: async ({ proxy, cluster, limit }, ctx): Promise<{ entries: KubeHistoryEntry[]; lastNamespace: string | null }> => {
    const kube = getTeleport(ctx.host).kube;
    const entries = (await kube.loadHistory()).filter((e) => historyMatches(e, proxy, cluster));
    const first = entries[0];
    return { entries: entries.slice(0, limit ?? 500), lastNamespace: cluster && first ? lastKubeNamespace(entries, first.proxy, cluster) : null };
  },
});

/**
 * The history entry a rerun names, read once per call: the registry hands the same input object to `mutating`,
 * `beforeApproval` and the handler, so the entry the gate saw (a query or an action) is the one that runs.
 */
const rerunEntries = new WeakMap<object, Promise<KubeHistoryEntry | undefined>>();

function historyEntry(host: HostApi, input: { id: string }): Promise<KubeHistoryEntry | undefined> {
  let entry = rerunEntries.get(input);
  if (!entry) {
    entry = getTeleport(host)
      .kube.loadHistory()
      .then((entries) => entries.find((e) => e.id === input.id));
    rerunEntries.set(input, entry);
  }
  return entry;
}

/**
 * Agents rerun queries only. An action rerun would be decided by the agent rules for this command instead of those
 * for teleport.kube.action, and its approval would show an entry id instead of the action, so an agent runs the
 * entry's action (teleport.kube.history.list returns it) through teleport.kube.action.
 */
function refuseAgentActionRerun(caller: Caller, entry: KubeHistoryEntry): void {
  if (caller !== 'mcp' || entry.kind !== 'action') return;
  throw new QuiverError(
    'MUTATION_BLOCKED',
    `History entry ${entry.id} is a Kubernetes action, and agents do not rerun actions. Run it with teleport_kube_action, passing the entry's proxy, cluster and action from teleport_kube_history_list.`,
    { reason: 'rerun-action', id: entry.id },
  );
}

const kubeHistoryRerun = defineCommand({
  id: 'teleport.kube.history.rerun',
  title: 'Run a Kubernetes query or action again',
  description:
    'Runs a history entry again on the same cluster, through the same validation as teleport.kube.query or teleport.kube.action. Running a query again is read-only; running an action again changes the cluster, so it is gated like teleport.kube.action, protected clusters included, and agents may not do it: they run the action of the entry with teleport.kube.action. A CronJob trigger gets a new job name.',
  scope: 'global',
  mutating: async (input, ctx) => (await historyEntry(ctx.host, input))?.kind === 'action',
  input: z.object({ id: z.string(), runId: RunIdInput.optional(), confirmCluster: ConfirmClusterInput }),
  // Refused whatever the user answers, so an agent is never asked about rerunning an action.
  beforeApproval: async (input, ctx) => {
    const entry = await historyEntry(ctx.host, input);
    if (entry) refuseAgentActionRerun(ctx.caller, entry);
  },
  handler: async (input, ctx): Promise<KubeRunResult | KubeActionResult> => {
    const { id, runId, confirmCluster } = input;
    const kube = getTeleport(ctx.host).kube;
    const entry = await historyEntry(ctx.host, input);
    if (!entry) throw new QuiverError('NOT_FOUND', `No Kubernetes history entry ${id}`);
    if (entry.kind === 'query') return kube.run({ proxy: entry.proxy, cluster: entry.cluster, query: entry.query, runId, caller: ctx.caller, timeoutMs: 60_000, record: true });
    refuseAgentActionRerun(ctx.caller, entry);
    await guardProtected(ctx.host, ctx.caller, entry.proxy, entry.cluster, confirmCluster, 'action');
    // A job name cannot be used twice, so a CronJob trigger gets a fresh one.
    const action = entry.action.action === 'cronjob-trigger' ? resolveKubeAction({ ...entry.action, params: { ...entry.action.params, jobName: undefined } }) : resolveKubeAction(entry.action);
    return kube.runAction({ proxy: entry.proxy, cluster: entry.cluster, action, runId, caller: ctx.caller, timeoutMs: 60_000 });
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
    clusterAutoRenew,
    windowFocus,
    pin,
    dbList,
    dbConnect,
    dbDisconnect,
    kubeList,
    kubeLogin,
    kubeQuery,
    kubePreview,
    kubeStreamRead,
    kubeCancel,
    kubeAction,
    kubeActionPreview,
    kubeProtect,
    portForwardStart,
    portForwardList,
    portForwardStop,
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
        // One browser flow at a time: expired clusters are logged into one after another. Those with Keep me
        // logged in on are the session's to renew, which it does after its first status read.
        const teleport = host.config.get().teleport;
        for (const proxy of proxiesToAutoLogin(teleport, initial.clusters).filter((p) => !isAutoRenewOn(teleport, p))) {
          const cluster = initial.clusters.find((c) => sameProxy(c.proxy, proxy));
          // A renewal the session started (Keep me logged in) may be running: one login at a time, so wait for it.
          await session.whenLoginDone();
          console.log(`[quiver] teleport certificate for ${cluster ? clusterLabel(cluster) : proxy} expired, starting tsh login (${nowIso()})`);
          await session.login(proxy).catch((err) => console.warn(`[quiver] teleport auto-login for ${proxy} failed: ${(err as Error).message}`));
        }
      })
      .catch((err) => console.warn(`[quiver] teleport status failed: ${(err as Error).message}`));
  },
  onStop: async (host) => {
    const { session, tunnels, kube, forwards } = getTeleport(host);
    session.stop();
    kube.stopAll();
    await Promise.all([tunnels.stopAll(), forwards.stopAll()]);
  },
});
