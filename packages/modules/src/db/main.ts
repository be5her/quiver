import {
  DbConnectionDraftSchema,
  DbConnectionSchema,
  DbKindSchema,
  QuiverError,
  SavedQueryDraftSchema,
  SavedQuerySchema,
  defineCommand,
  defineModule,
  newDbConnection,
  newId,
  newSavedQuery,
  nowIso,
  redisScriptIsReadOnly,
  scriptIsReadOnly,
  type CommandContext,
  type DbConnection,
  type DbConnectionSummary,
  type DbConnectionTest,
  type DbHistoryEntry,
  type DbQueryResult,
  type SavedQuery,
  type WorkspaceApi,
} from '@quiver/core';
import { z } from 'zod';
import { COLLECTIONS, DriverPool, HISTORY_LOG, explainAccessError, getConnection, listConnections, readPassword, withTemporaryDriver, writePassword } from './connections';
import type { Driver, RedisDriverApi } from './drivers';

const pool = new DriverPool();

function ws(ctx: CommandContext): WorkspaceApi {
  return ctx.workspace!;
}

/** Acquire the pooled driver and translate tunnel/certificate failures into TELEPORT_LOGIN_REQUIRED. */
async function withDriver<T>(ctx: CommandContext, connectionId: string, fn: (driver: Driver, connection: DbConnectionSummary) => Promise<T>): Promise<T> {
  const { connection, driver } = await pool.acquire(ws(ctx), ctx.host, connectionId);
  try {
    return await fn(driver, connection);
  } catch (err) {
    throw await explainAccessError(ctx.host, connection, err);
  }
}

function requireRedis(driver: { kind: string }): RedisDriverApi {
  if (driver.kind !== 'redis') throw new QuiverError('INVALID_INPUT', 'This command needs a Redis connection');
  return driver as RedisDriverApi;
}

const ConnectionIdInput = z.object({ connectionId: z.string().describe('Id of a saved connection (see db.connection.list)') });

// ---------- connections ----------

const connectionList = defineCommand({
  id: 'db.connection.list',
  title: 'List database connections',
  description: 'Lists saved MySQL, SQLite and Redis connections. Passwords are never returned; hasPassword says whether one is stored on this machine.',
  scope: 'workspace',
  input: z.object({ kind: DbKindSchema.optional() }),
  handler: async ({ kind }, ctx) => {
    const all = await listConnections(ws(ctx));
    return (kind ? all.filter((c) => c.kind === kind) : all).map((c) => ({ ...c, connected: pool.isOpen(ws(ctx).id, c.id) }));
  },
});

const connectionGet = defineCommand({
  id: 'db.connection.get',
  title: 'Get database connection',
  description: 'Returns one saved connection by id.',
  scope: 'workspace',
  input: z.object({ id: z.string() }),
  handler: async ({ id }, ctx) => getConnection(ws(ctx), id),
});

const connectionSave = defineCommand({
  id: 'db.connection.save',
  title: 'Save database connection',
  description:
    'Creates or updates a connection. Omit id to create. A password given here is encrypted with the OS keychain and stored only on this machine; omit it to keep the stored one, pass clearPassword to remove it.',
  scope: 'workspace',
  input: z.object({
    connection: DbConnectionDraftSchema,
    password: z.string().optional(),
    clearPassword: z.boolean().optional(),
  }),
  handler: async ({ connection, password, clearPassword }, ctx): Promise<DbConnectionSummary> => {
    const w = ws(ctx);
    const existing = connection.id ? await w.store.get<DbConnection>(COLLECTIONS.connections, connection.id) : undefined;
    const ts = nowIso();
    const merged: DbConnection = DbConnectionSchema.parse({
      ...(existing ?? newDbConnection(connection.kind)),
      ...connection,
      id: connection.id ?? newId(),
      createdAt: existing?.createdAt ?? connection.createdAt ?? ts,
      updatedAt: ts,
    });
    if (!merged.name.trim()) merged.name = `${merged.kind} connection`;
    await w.store.put(COLLECTIONS.connections, merged);
    if (clearPassword) await writePassword(w, ctx.host, merged.id, null);
    else if (password !== undefined) await writePassword(w, ctx.host, merged.id, password);
    await pool.close(w.id, merged.id, ctx.host, { immediate: false });
    return getConnection(w, merged.id);
  },
});

const connectionDelete = defineCommand({
  id: 'db.connection.delete',
  title: 'Delete database connection',
  description: 'Deletes a saved connection and its stored password.',
  scope: 'workspace',
  mutating: true,
  input: z.object({ id: z.string() }),
  handler: async ({ id }, ctx) => {
    const w = ws(ctx);
    await pool.close(w.id, id, ctx.host);
    await writePassword(w, ctx.host, id, null);
    return { deleted: await w.store.remove(COLLECTIONS.connections, id) };
  },
});

const connectionTest = defineCommand({
  id: 'db.connection.test',
  title: 'Test database connection',
  description: 'Opens a connection and reports the server version and latency. Pass a saved id, or an inline connection (with optional password) to test before saving.',
  scope: 'workspace',
  input: z.object({
    id: z.string().optional(),
    connection: DbConnectionDraftSchema.optional(),
    password: z.string().optional(),
  }),
  handler: async (input, ctx): Promise<DbConnectionTest> => {
    const w = ws(ctx);
    const started = performance.now();
    let serverVersion: string;
    if (input.connection) {
      const draft = DbConnectionSchema.parse({ ...newDbConnection(input.connection.kind), ...input.connection, id: input.connection.id ?? 'draft' });
      // Reuse the stored password when editing an existing connection and the field was left untouched.
      const password = input.password ?? (input.connection.id ? await readPassword(w, ctx.host, input.connection.id) : '');
      serverVersion = (await withTemporaryDriver(draft, password, w.path, ctx.host, (d) => d.ping())).serverVersion;
    } else if (input.id) {
      serverVersion = (await withDriver(ctx, input.id, (d) => d.ping())).serverVersion;
    } else {
      throw new QuiverError('INVALID_INPUT', 'Provide id or connection');
    }
    return { ok: true, serverVersion, latencyMs: Math.round(performance.now() - started) };
  },
});

const connectionDisconnect = defineCommand({
  id: 'db.connection.disconnect',
  title: 'Disconnect database',
  description: 'Closes the live connection and stops its tunnel; both reopen on the next query.',
  scope: 'workspace',
  input: z.object({ id: z.string() }),
  handler: async ({ id }, ctx) => ({ closed: await pool.close(ws(ctx).id, id, ctx.host) }),
});

// ---------- schema ----------

const schemaDatabases = defineCommand({
  id: 'db.schema.databases',
  title: 'List databases',
  description: 'Lists schemas on a MySQL server or attached databases in SQLite.',
  scope: 'workspace',
  input: ConnectionIdInput,
  handler: async ({ connectionId }, ctx) => withDriver(ctx, connectionId, (d) => d.databases()),
});

const schemaTables = defineCommand({
  id: 'db.schema.tables',
  title: 'List tables',
  description: 'Lists tables and views. For MySQL pass database to pick a schema other than the connection default.',
  scope: 'workspace',
  input: ConnectionIdInput.extend({ database: z.string().nullable().optional() }),
  handler: async ({ connectionId, database }, ctx) => withDriver(ctx, connectionId, (d) => d.tables(database)),
});

const schemaTable = defineCommand({
  id: 'db.schema.table',
  title: 'Describe table',
  description: 'Columns, indexes and the CREATE statement of a table or view.',
  scope: 'workspace',
  input: ConnectionIdInput.extend({ table: z.string(), database: z.string().nullable().optional() }),
  handler: async ({ connectionId, table, database }, ctx) => withDriver(ctx, connectionId, (d) => d.table(table, database)),
});

const tableRows = defineCommand({
  id: 'db.table.rows',
  title: 'Browse table rows',
  description: 'Pages through a table with optional WHERE filter and ordering. Returns rows as arrays in column order plus the total count.',
  scope: 'workspace',
  input: ConnectionIdInput.extend({
    table: z.string(),
    database: z.string().nullable().optional(),
    limit: z.number().int().min(1).max(5000).default(100),
    offset: z.number().int().min(0).default(0),
    orderBy: z.string().nullable().optional(),
    direction: z.enum(['asc', 'desc']).optional(),
    where: z.string().nullable().optional().describe('Raw SQL placed after WHERE'),
  }),
  handler: async (input, ctx) => withDriver(ctx, input.connectionId, (d) => d.tableRows(input.table, input)),
});

// ---------- queries ----------

const RunInput = ConnectionIdInput.extend({
  query: z.string().min(1).describe('SQL statements separated by semicolons, or Redis commands one per line'),
  database: z.string().nullable().optional().describe('MySQL schema to USE first'),
  maxRows: z.number().int().min(1).max(50_000).default(500),
  /** Record in workspace query history. Defaults to true. */
  record: z.boolean().optional(),
});

const queryRun = defineCommand({
  id: 'db.query.run',
  title: 'Run query',
  description:
    'Runs SQL against a MySQL or SQLite connection, or commands against Redis. Returns one result per statement: rows (as arrays with columns), affected row counts, or the raw Redis reply. Result sets are capped at maxRows.',
  scope: 'workspace',
  mutating: async ({ connectionId, query }, ctx) => {
    const conn = await ws(ctx).store.get<DbConnection>(COLLECTIONS.connections, connectionId);
    if (!conn) return false;
    return conn.kind === 'redis' ? !redisScriptIsReadOnly(query) : !scriptIsReadOnly(query);
  },
  input: RunInput,
  handler: async (input, ctx): Promise<DbQueryResult[]> => {
    const w = ws(ctx);
    const { connection, driver } = await pool.acquire(w, ctx.host, input.connectionId);
    const started = performance.now();
    const entry: DbHistoryEntry = {
      id: newId(),
      at: nowIso(),
      connectionId: connection.id,
      connectionName: connection.name,
      database: input.database ?? (connection.database || null),
      text: input.query,
      ok: false,
      error: null,
      durationMs: 0,
      rowCount: null,
    };
    try {
      const results = await driver.run(input.query, { database: input.database, maxRows: input.maxRows });
      entry.ok = true;
      entry.rowCount = results.reduce((n, r) => n + (r.kind === 'rows' ? r.rowCount : (r.affectedRows ?? 0)), 0);
      return results;
    } catch (err) {
      const explained = await explainAccessError(ctx.host, connection, err);
      entry.error = explained instanceof Error ? explained.message : String(explained);
      throw explained;
    } finally {
      entry.durationMs = Math.round(performance.now() - started);
      if (input.record !== false) {
        await w.store.appendLog(HISTORY_LOG, entry);
        ctx.host.emit('store.changed', { workspaceId: w.id, collection: HISTORY_LOG });
      }
    }
  },
});

const queryList = defineCommand({
  id: 'db.query.list',
  title: 'List saved queries',
  description: 'Lists saved SQL and Redis queries in the workspace.',
  scope: 'workspace',
  input: z.object({ connectionId: z.string().optional() }),
  handler: async ({ connectionId }, ctx) => {
    const all = (await ws(ctx).store.list<SavedQuery>(COLLECTIONS.queries)).map((q) => SavedQuerySchema.parse(q));
    return (connectionId ? all.filter((q) => q.connectionId === connectionId) : all).sort((a, b) => a.name.localeCompare(b.name));
  },
});

const queryGet = defineCommand({
  id: 'db.query.get',
  title: 'Get saved query',
  description: 'Returns one saved query by id.',
  scope: 'workspace',
  input: z.object({ id: z.string() }),
  handler: async ({ id }, ctx) => {
    const q = await ws(ctx).store.get<SavedQuery>(COLLECTIONS.queries, id);
    if (!q) throw new QuiverError('NOT_FOUND', `Query ${id} not found`);
    return SavedQuerySchema.parse(q);
  },
});

const querySave = defineCommand({
  id: 'db.query.save',
  title: 'Save query',
  description: 'Creates or updates a saved query (omit id to create).',
  scope: 'workspace',
  input: z.object({ query: SavedQueryDraftSchema }),
  handler: async ({ query }, ctx) => {
    const w = ws(ctx);
    const existing = query.id ? await w.store.get<SavedQuery>(COLLECTIONS.queries, query.id) : undefined;
    const merged = SavedQuerySchema.parse({ ...(existing ?? newSavedQuery()), ...query, id: query.id ?? newId(), updatedAt: nowIso() });
    return w.store.put(COLLECTIONS.queries, merged);
  },
});

const queryDelete = defineCommand({
  id: 'db.query.delete',
  title: 'Delete saved query',
  description: 'Deletes a saved query.',
  scope: 'workspace',
  mutating: true,
  input: z.object({ id: z.string() }),
  handler: async ({ id }, ctx) => ({ deleted: await ws(ctx).store.remove(COLLECTIONS.queries, id) }),
});

// ---------- history ----------

const historyList = defineCommand({
  id: 'db.history.list',
  title: 'Query history',
  description: 'Most recent queries run in this workspace with timing and outcome.',
  scope: 'workspace',
  input: z.object({ limit: z.number().int().min(1).max(500).default(50), connectionId: z.string().optional() }),
  handler: async ({ limit, connectionId }, ctx) => {
    const entries = await ws(ctx).store.readLog<DbHistoryEntry>(HISTORY_LOG, connectionId ? limit * 4 : limit);
    return (connectionId ? entries.filter((e) => e.connectionId === connectionId) : entries).slice(0, limit);
  },
});

const historyClear = defineCommand({
  id: 'db.history.clear',
  title: 'Clear query history',
  description: 'Clears the query history for this workspace.',
  scope: 'workspace',
  mutating: true,
  input: z.object({}),
  handler: async (_i, ctx) => {
    await ws(ctx).store.clearLog(HISTORY_LOG);
    ctx.host.emit('store.changed', { workspaceId: ws(ctx).id, collection: HISTORY_LOG });
    return { cleared: true };
  },
});

// ---------- redis ----------

const redisKeys = defineCommand({
  id: 'db.redis.keys',
  title: 'Scan Redis keys',
  description: 'Scans keys matching a glob pattern with SCAN (never KEYS). Returns type and TTL per key plus the cursor for the next page; done is true on the last page.',
  scope: 'workspace',
  input: ConnectionIdInput.extend({
    pattern: z.string().default('*'),
    cursor: z.string().default('0'),
    count: z.number().int().min(1).max(10_000).default(200),
  }),
  handler: async ({ connectionId, pattern, cursor, count }, ctx) => withDriver(ctx, connectionId, (d) => requireRedis(d).scanKeys(pattern, cursor, count)),
});

const redisKey = defineCommand({
  id: 'db.redis.key',
  title: 'Inspect Redis key',
  description: 'Returns a key with its type, TTL, encoding, memory usage and value (hash as object, list/set as arrays, zset as [member, score] pairs, stream as entries). Large collections are capped by limit.',
  scope: 'workspace',
  input: ConnectionIdInput.extend({ key: z.string(), limit: z.number().int().min(1).max(10_000).default(200) }),
  handler: async ({ connectionId, key, limit }, ctx) => withDriver(ctx, connectionId, (d) => requireRedis(d).keyDetail(key, limit)),
});

export const dbModule = defineModule({
  id: 'db',
  commands: [
    connectionList,
    connectionGet,
    connectionSave,
    connectionDelete,
    connectionTest,
    connectionDisconnect,
    schemaDatabases,
    schemaTables,
    schemaTable,
    tableRows,
    queryRun,
    queryList,
    queryGet,
    querySave,
    queryDelete,
    historyList,
    historyClear,
    redisKeys,
    redisKey,
  ],
  onWorkspaceClose: (workspace, host) => pool.closeWorkspace(workspace.id, host),
});
