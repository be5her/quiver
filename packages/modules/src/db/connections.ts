import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  DbConnectionSchema,
  QuiverError,
  clusterLabel,
  dotenvToMap,
  findCluster,
  isLoginRequiredMessage,
  newId,
  parseDotenv,
  resolveConnectionTemplate,
  type DbConnection,
  type DbConnectionSummary,
  type HostApi,
  type TeleportTunnel,
  type WorkspaceApi,
} from '@quiver/core';
import { resolveVariableMap } from '../api/env';
import { getTeleport } from '../teleport/runtime';
import type { TunnelSpec } from '../teleport/tunnels';
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
  } catch (err) {
    // A host that cannot read this machine's secrets (the headless CLI) says so, rather than connecting without one.
    if (err instanceof QuiverError && err.code === 'SECRET_UNAVAILABLE') throw err;
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

export async function hasPassword(ws: WorkspaceApi, connectionId: string): Promise<boolean> {
  return (await hasPasswordSet(ws)).has(connectionId);
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

// ---------- {{variables}} in connection fields ----------

/**
 * The values `{{name}}` in a connection resolves with: the workspace's root `.env` underneath,
 * then the API module's global variables and its active environment on top. Missing files and
 * unreadable env files count as empty.
 */
export async function connectionVariables(ws: WorkspaceApi, host: HostApi): Promise<Record<string, string>> {
  let fromEnvFile: Record<string, string> = {};
  try {
    fromEnvFile = dotenvToMap(parseDotenv(await fs.readFile(path.join(ws.path, '.env'), 'utf8')));
  } catch {
    fromEnvFile = {};
  }
  const api = await resolveVariableMap(ws, host).catch(() => ({}) as Record<string, string>);
  return { ...fromEnvFile, ...api };
}

/** A connection with its `{{variables}}` filled in, as the driver should dial it. */
export async function resolvedConnection<T extends DbConnection>(connection: T, ws: WorkspaceApi, host: HostApi): Promise<T> {
  return { ...connection, ...resolveConnectionTemplate(connection, await connectionVariables(ws, host)) };
}

// ---------- access: direct, Teleport tunnel, or a tunnel command ----------

/**
 * The tunnel a Teleport-backed connection needs. PostgreSQL goes through `tsh proxy db` with the
 * database name (`--db-name`), which tsh requires; that is the connection's Database field.
 */
export function teleportSpec(connection: Pick<DbConnection, 'kind' | 'database' | 'access'>): Extract<TunnelSpec, { kind: 'teleport' }> {
  const { access } = connection;
  if (access.type !== 'teleport') throw new QuiverError('INVALID_INPUT', 'Not a Teleport connection');
  const dbName = connection.kind === 'postgres' ? connection.database.trim() : '';
  if (connection.kind === 'postgres' && !dbName) {
    throw new QuiverError('INVALID_INPUT', `PostgreSQL through Teleport needs the database name: fill in the Database field of the connection (tsh proxy db passes it as --db-name).`, { needs: 'dbName' });
  }
  return { kind: 'teleport', proxy: access.proxy, database: access.database, dbUser: access.dbUser, dbName: dbName || null };
}

/**
 * Make sure the tunnel behind `connection.access` is running and return the connection
 * the driver should actually dial (127.0.0.1 and the tunnel port). `user` keeps the tunnel open.
 */
export async function resolveAccess(connection: DbConnection, host: HostApi, user: string): Promise<DbConnection> {
  const { access } = connection;
  // A Grafana data source is no tunnel: the driver talks to Grafana itself.
  if (access.type === 'direct' || access.type === 'grafana') return connection;
  const { tunnels } = getTeleport(host);
  if (access.type === 'teleport') {
    const tunnel = await tunnels.ensure(teleportSpec(connection), user);
    // Teleport's local tunnel is plaintext and already authenticated as --db-user: no TLS, MySQL and
    // PostgreSQL still need a handshake user, and Redis must not send AUTH at all.
    const dialUser = connection.kind === 'redis' ? '' : connection.user || access.dbUser;
    return { ...connection, host: '127.0.0.1', port: tunnel.port, ssl: false, user: dialUser };
  }
  const tunnel = await tunnels.ensure({ kind: 'command', command: access.command }, user);
  return { ...connection, host: '127.0.0.1', port: tunnel.port };
}

/** Let go of the tunnel a driver was using. */
export async function releaseAccess(connection: Pick<DbConnection, 'access'>, host: HostApi, user: string, immediate: boolean): Promise<void> {
  if (connection.access.type === 'direct' || connection.access.type === 'grafana') return;
  await getTeleport(host).tunnels.release(user, { immediate });
}

/**
 * Turn a driver error on a Teleport-backed connection into TELEPORT_LOGIN_REQUIRED when the
 * real cause is a missing or expired certificate, so the UI can offer "Log in again".
 */
export async function explainAccessError(host: HostApi, connection: Pick<DbConnection, 'kind' | 'database' | 'access'>, err: unknown): Promise<unknown> {
  if (connection.access.type !== 'teleport') return err;
  if (err instanceof QuiverError && err.code === 'TELEPORT_LOGIN_REQUIRED') return err;
  const { session, tunnels } = getTeleport(host);
  const { proxy, database, dbUser } = connection.access;
  const cause = err instanceof Error ? err.message : String(err);
  let tunnel: TeleportTunnel | null = null;
  try {
    tunnel = tunnels.find(teleportSpec(connection));
  } catch {
    tunnel = null;
  }
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
  /** Set by `db.transaction begin`, cleared by commit, rollback or a reopen. */
  inTransaction: boolean;
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
        const accessUser = connection.access.type === 'direct' || connection.access.type === 'grafana' ? null : key;
        const effective = await resolveAccess(await resolvedConnection(connection, ws, host), host, key);
        const driver = createDriver(effective, password, ws.path, host);
        try {
          await driver.connect();
        } catch (err) {
          if (accessUser) await releaseAccess(connection, host, accessUser, false);
          throw await explainAccessError(host, connection, err);
        }
        const pooled: PooledDriver = { driver, updatedAt: connection.updatedAt, accessUser, access: connection.access, inTransaction: false };
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

  /** The open driver, without opening one: for cancelling a statement that is running on it. */
  peek(workspaceId: string, connectionId: string): Driver | null {
    const entry = this.pools.get(workspaceId)?.get(connectionId);
    return entry?.driver.isAlive() ? entry.driver : null;
  }

  isInTransaction(workspaceId: string, connectionId: string): boolean {
    const entry = this.pools.get(workspaceId)?.get(connectionId);
    return Boolean(entry?.driver.isAlive() && entry.inTransaction);
  }

  setTransaction(workspaceId: string, connectionId: string, open: boolean): void {
    const entry = this.pools.get(workspaceId)?.get(connectionId);
    if (entry) entry.inTransaction = open;
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
export async function withTemporaryDriver<T>(connection: DbConnection, password: string, ws: WorkspaceApi, host: HostApi, fn: (driver: Driver) => Promise<T>): Promise<T> {
  const user = `temp/${newId()}`;
  const workspacePath = ws.path;
  const effective = await resolveAccess(await resolvedConnection(connection, ws, host), host, user);
  const driver = createDriver(effective, password, workspacePath, host);
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
