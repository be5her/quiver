import { DbConnectionSchema, QuiverError, clusterLabel, findCluster, isLoginRequiredMessage, newId, type DbConnection, type DbConnectionSummary, type HostApi, type WorkspaceApi } from '@quiver/core';
import { getTeleport } from '../teleport/runtime';
import { createDriver, type Driver } from './drivers';

export const COLLECTIONS = {
  connections: 'db-connections',
  queries: 'db-queries',
} as const;

export const HISTORY_LOG = 'db-history';
const SECRETS_DOC = 'db-secrets';

type SecretsDoc = Record<string, string>;

// ---------- passwords (per machine, encrypted, never committed) ----------

export async function readPassword(ws: WorkspaceApi, host: HostApi, connectionId: string): Promise<string> {
  const secrets = await ws.store.readLocal<SecretsDoc>(SECRETS_DOC, {});
  const cipher = secrets[connectionId];
  if (!cipher) return '';
  try {
    return host.secrets.decrypt(cipher);
  } catch {
    return '';
  }
}

export async function writePassword(ws: WorkspaceApi, host: HostApi, connectionId: string, password: string | null): Promise<void> {
  const secrets = await ws.store.readLocal<SecretsDoc>(SECRETS_DOC, {});
  if (password) secrets[connectionId] = host.secrets.encrypt(password);
  else delete secrets[connectionId];
  await ws.store.writeLocal(SECRETS_DOC, secrets);
}

async function hasPasswordSet(ws: WorkspaceApi): Promise<Set<string>> {
  const secrets = await ws.store.readLocal<SecretsDoc>(SECRETS_DOC, {});
  return new Set(Object.keys(secrets));
}

// ---------- connections ----------

export async function listConnections(ws: WorkspaceApi): Promise<DbConnectionSummary[]> {
  const [items, withPassword] = await Promise.all([ws.store.list<DbConnection>(COLLECTIONS.connections), hasPasswordSet(ws)]);
  return items
    .map((c) => ({ ...DbConnectionSchema.parse(c), hasPassword: withPassword.has(c.id) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function getConnection(ws: WorkspaceApi, id: string): Promise<DbConnectionSummary> {
  const item = await ws.store.get<DbConnection>(COLLECTIONS.connections, id);
  if (!item) throw new QuiverError('NOT_FOUND', `Connection ${id} not found`);
  return { ...DbConnectionSchema.parse(item), hasPassword: (await hasPasswordSet(ws)).has(id) };
}

// ---------- access: direct, Teleport tunnel, or a tunnel command ----------

/**
 * Make sure the tunnel behind `connection.access` is running and return the connection
 * the driver should actually dial (127.0.0.1 and the tunnel port). `user` keeps the tunnel open.
 */
export async function resolveAccess(connection: DbConnection, host: HostApi, user: string): Promise<DbConnection> {
  const { access } = connection;
  if (access.type === 'direct') return connection;
  const { tunnels } = getTeleport(host);
  if (access.type === 'teleport') {
    const tunnel = await tunnels.ensure({ kind: 'teleport', proxy: access.proxy, database: access.database, dbUser: access.dbUser }, user);
    // Teleport's local tunnel is plaintext and already authenticated as --db-user: no TLS, MySQL still
    // needs a handshake user, and Redis must not send AUTH at all.
    const dialUser = connection.kind === 'mysql' ? connection.user || access.dbUser : '';
    return { ...connection, host: '127.0.0.1', port: tunnel.port, ssl: false, user: dialUser };
  }
  const tunnel = await tunnels.ensure({ kind: 'command', command: access.command }, user);
  return { ...connection, host: '127.0.0.1', port: tunnel.port };
}

/** Let go of the tunnel a driver was using. */
export async function releaseAccess(connection: Pick<DbConnection, 'access'>, host: HostApi, user: string, immediate: boolean): Promise<void> {
  if (connection.access.type === 'direct') return;
  await getTeleport(host).tunnels.release(user, { immediate });
}

/**
 * Turn a driver error on a Teleport-backed connection into TELEPORT_LOGIN_REQUIRED when the
 * real cause is a missing or expired certificate, so the UI can offer "Log in again".
 */
export async function explainAccessError(host: HostApi, connection: Pick<DbConnection, 'access'>, err: unknown): Promise<unknown> {
  if (connection.access.type !== 'teleport') return err;
  if (err instanceof QuiverError && err.code === 'TELEPORT_LOGIN_REQUIRED') return err;
  const { session, tunnels } = getTeleport(host);
  const { proxy, database, dbUser } = connection.access;
  const cause = err instanceof Error ? err.message : String(err);
  const tunnel = tunnels.find({ kind: 'teleport', proxy, database, dbUser });
  if (tunnel && isLoginRequiredMessage(tunnel.output.join('\n'))) {
    return new QuiverError('TELEPORT_LOGIN_REQUIRED', `Teleport rejected the tunnel for ${database}: ${cause}`, { output: tunnel.output, proxy: tunnel.proxy });
  }
  const status = await session.refresh().catch(() => null);
  const cluster = status ? findCluster(status.clusters, proxy) : undefined;
  if (status && (!cluster || cluster.state === 'expired' || cluster.state === 'logged-out')) {
    const label = cluster ? clusterLabel(cluster) : proxy || 'the current tsh profile';
    return new QuiverError(
      'TELEPORT_LOGIN_REQUIRED',
      `Your Teleport certificate for ${label} ${cluster?.state === 'expired' ? 'has expired' : 'is missing'}; the query failed with: ${cause}`,
      { cause, proxy: cluster?.proxy ?? proxy },
    );
  }
  return err;
}

// ---------- live drivers ----------

interface PooledDriver {
  driver: Driver;
  /** Config revision the driver was opened with; a newer save reopens it. */
  updatedAt: string;
  /** Tunnel user key, when the connection goes through one. */
  accessUser: string | null;
  access: DbConnection['access'];
}

/**
 * Keeps one open driver per (workspace, connection). Drivers open lazily on first use,
 * reopen after a config change or a dropped connection, and close with the workspace.
 */
export class DriverPool {
  private readonly pools = new Map<string, Map<string, PooledDriver>>();
  private readonly opening = new Map<string, Promise<PooledDriver>>();

  async acquire(ws: WorkspaceApi, host: HostApi, connectionId: string): Promise<{ connection: DbConnectionSummary; driver: Driver }> {
    const connection = await getConnection(ws, connectionId);
    const pool = this.poolFor(ws.id);
    const existing = pool.get(connectionId);
    if (existing && existing.updatedAt === connection.updatedAt && existing.driver.isAlive()) {
      return { connection, driver: existing.driver };
    }
    if (existing) {
      pool.delete(connectionId);
      await existing.driver.close().catch(() => {});
      if (existing.accessUser) await releaseAccess(existing, host, existing.accessUser, false);
    }
    const key = `${ws.id}/${connectionId}`;
    let pending = this.opening.get(key);
    if (!pending) {
      pending = (async () => {
        const password = await readPassword(ws, host, connectionId);
        const accessUser = connection.access.type === 'direct' ? null : key;
        const effective = await resolveAccess(connection, host, key);
        const driver = createDriver(effective, password, ws.path);
        try {
          await driver.connect();
        } catch (err) {
          if (accessUser) await releaseAccess(connection, host, accessUser, false);
          throw await explainAccessError(host, connection, err);
        }
        const pooled: PooledDriver = { driver, updatedAt: connection.updatedAt, accessUser, access: connection.access };
        pool.set(connectionId, pooled);
        return pooled;
      })().finally(() => this.opening.delete(key));
      this.opening.set(key, pending);
    }
    const pooled = await pending;
    return { connection, driver: pooled.driver };
  }

  /** Close the live driver. `immediate` also stops its tunnel now instead of after the grace period. */
  async close(workspaceId: string, connectionId: string, host?: HostApi, options: { immediate?: boolean } = {}): Promise<boolean> {
    const pool = this.pools.get(workspaceId);
    const entry = pool?.get(connectionId);
    if (!pool || !entry) return false;
    pool.delete(connectionId);
    await entry.driver.close().catch(() => {});
    if (entry.accessUser && host) await releaseAccess(entry, host, entry.accessUser, options.immediate ?? true);
    return true;
  }

  async closeWorkspace(workspaceId: string, host?: HostApi): Promise<void> {
    const pool = this.pools.get(workspaceId);
    if (!pool) return;
    this.pools.delete(workspaceId);
    await Promise.all(
      [...pool.values()].map(async (p) => {
        await p.driver.close().catch(() => {});
        if (p.accessUser && host) await releaseAccess(p, host, p.accessUser, true);
      }),
    );
  }

  isOpen(workspaceId: string, connectionId: string): boolean {
    const entry = this.pools.get(workspaceId)?.get(connectionId);
    return Boolean(entry?.driver.isAlive());
  }

  private poolFor(workspaceId: string): Map<string, PooledDriver> {
    let pool = this.pools.get(workspaceId);
    if (!pool) {
      pool = new Map();
      this.pools.set(workspaceId, pool);
    }
    return pool;
  }
}

/** Open a throwaway driver for an unsaved connection, e.g. the "Test" button in the editor. */
export async function withTemporaryDriver<T>(connection: DbConnection, password: string, workspacePath: string, host: HostApi, fn: (driver: Driver) => Promise<T>): Promise<T> {
  const user = `temp/${newId()}`;
  const effective = await resolveAccess(connection, host, user);
  const driver = createDriver(effective, password, workspacePath);
  try {
    await driver.connect();
    return await fn(driver);
  } catch (err) {
    throw await explainAccessError(host, connection, err);
  } finally {
    await driver.close().catch(() => {});
    // Keep the tunnel around briefly: Test is usually followed by Save and a first query.
    await releaseAccess(connection, host, user, false);
  }
}
