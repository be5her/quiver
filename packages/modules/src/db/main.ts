import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  DbConnectionDraftSchema,
  DbConnectionSchema,
  DbKindSchema,
  DbTableEditSchema,
  EXPORT_EXTENSIONS,
  QuiverError,
  SavedQueryDraftSchema,
  SavedQuerySchema,
  buildTableEdits,
  dbAccessProblem,
  dbDataCollection,
  defineCommand,
  defineModule,
  formatRows,
  isSqlKind,
  newDbConnection,
  newId,
  newSavedQuery,
  normalizeGrafanaUrl,
  nowIso,
  redisCommandIsReadOnly,
  redisScriptIsReadOnly,
  scriptIsReadOnly,
  type CommandContext,
  type DbConnection,
  type DbConnectionSummary,
  type DbConnectionTest,
  type DbExportFormat,
  type DbExportResult,
  type DbHistoryEntry,
  type DbQueryResult,
  type DbSchemaMatch,
  type DbTableApplyResult,
  type DbTableColumns,
  type DbTableEdit,
  type GrafanaRedisDatasource,
  type LogsSession,
  type SavedQuery,
  type WorkspaceApi,
} from '@quiver/core';
import { z } from 'zod';
import { COLLECTIONS, DriverPool, HISTORY_LOG, explainAccessError, getConnection, listConnections, readPassword, withTemporaryDriver, writePassword } from './connections';
import { grafanaSessions } from '../grafana/sessions';
import { grafanaRedisDatasources, type Driver, type RedisDriverApi } from './drivers';

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

function requireSql(connection: DbConnectionSummary): void {
  if (!isSqlKind(connection.kind)) throw new QuiverError('INVALID_INPUT', 'This command needs a SQL connection (MySQL, PostgreSQL or SQLite)');
}

function beginStatement(kind: DbConnection['kind']): string {
  return kind === 'mysql' ? 'START TRANSACTION' : 'BEGIN';
}

async function recordHistory(ctx: CommandContext, entry: DbHistoryEntry): Promise<void> {
  const w = ws(ctx);
  await w.store.appendLog(HISTORY_LOG, entry);
  ctx.host.emit('store.changed', { workspaceId: w.id, collection: HISTORY_LOG });
}

function announceData(ctx: CommandContext, connectionId: string): void {
  ctx.host.emit('store.changed', { workspaceId: ws(ctx).id, collection: dbDataCollection(connectionId) });
}

/**
 * A connection whose access fits its kind, with the Grafana address normalised (unless it holds
 * {{variables}}, which resolve when the connection opens).
 */
function checkedAccess<T extends DbConnection>(connection: T): T {
  const problem = dbAccessProblem(connection);
  if (problem) throw new QuiverError('INVALID_INPUT', problem);
  const { access } = connection;
  if (access.type !== 'grafana' || access.grafanaUrl.includes('{{') || !access.grafanaUrl.trim()) return connection;
  const grafanaUrl = normalizeGrafanaUrl(access.grafanaUrl);
  if (!grafanaUrl) throw new QuiverError('INVALID_INPUT', `"${access.grafanaUrl}" is not an http(s) address`);
  return { ...connection, access: { ...access, grafanaUrl } };
}

const ConnectionIdInput = z.object({ connectionId: z.string().describe('Id of a saved connection (see db.connection.list)') });

// ---------- connections ----------

const connectionList = defineCommand({
  id: 'db.connection.list',
  title: 'List database connections',
  description:
    'Lists saved MySQL, PostgreSQL, SQLite and Redis connections. Passwords are never returned; hasPassword says whether one is stored on this machine, connected whether a driver is open, inTransaction whether db.transaction began one. access says how the server is reached; a Redis connection with access.type grafana goes through a Grafana Redis data source, and its commands run with the permissions of the Grafana user signed in on this machine.',
  scope: 'workspace',
  input: z.object({ kind: DbKindSchema.optional() }),
  handler: async ({ kind }, ctx) => {
    const w = ws(ctx);
    const all = await listConnections(w);
    return (kind ? all.filter((c) => c.kind === kind) : all).map((c) => ({ ...c, connected: pool.isOpen(w.id, c.id), inTransaction: pool.isInTransaction(w.id, c.id) }));
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
    'Creates or updates a connection. Omit id to create. A password given here is encrypted with the OS keychain and stored only on this machine; omit it to keep the stored one, pass clearPassword to remove it. Host, user, database, file and tunnel fields may hold {{variables}} resolved from the API variables and the workspace .env when the connection opens. access is direct, teleport (tsh proxy db), command (a tunnel command with {port}) or, for Redis only, grafana: { type: "grafana", grafanaUrl, datasourceUid, datasourceName } sends every command through that Grafana Redis data source with the Grafana user signed in on this machine (db.grafana.redis.datasources lists them; no password, database index 0).',
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
    const merged: DbConnection = checkedAccess(
      DbConnectionSchema.parse({
        ...(existing ?? newDbConnection(connection.kind)),
        ...connection,
        id: connection.id ?? newId(),
        createdAt: existing?.createdAt ?? connection.createdAt ?? ts,
        updatedAt: ts,
      }),
    );
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
      const draft = checkedAccess(DbConnectionSchema.parse({ ...newDbConnection(input.connection.kind), ...input.connection, id: input.connection.id ?? 'draft' }));
      // Reuse the stored password when editing an existing connection and the field was left untouched.
      const password = input.password ?? (input.connection.id ? await readPassword(w, ctx.host, input.connection.id) : '');
      serverVersion = (await withTemporaryDriver(draft, password, w, ctx.host, (d) => d.ping())).serverVersion;
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
  description: 'Closes the live connection and stops its tunnel; both reopen on the next query. An open transaction is rolled back by the server.',
  scope: 'workspace',
  input: z.object({ id: z.string() }),
  handler: async ({ id }, ctx) => {
    const closed = await pool.close(ws(ctx).id, id, ctx.host);
    ctx.host.emit('store.changed', { workspaceId: ws(ctx).id, collection: COLLECTIONS.connections });
    return { closed };
  },
});

// ---------- Redis through Grafana ----------

const GrafanaUrlInput = z.object({ grafanaUrl: z.string().min(1).describe('The Grafana address, e.g. https://grafana.example.com') });

const grafanaSession = defineCommand({
  id: 'db.grafana.session',
  title: 'Check Grafana sign-in for Redis',
  description:
    "Asks a Grafana whether this machine is signed in, and as whom. The session is the one the Logs module uses: one per Grafana, shared. Agents cannot sign in; when state is signed-out, ask the user to sign in from Quiver (the connection's Access section, or the Logs view).",
  scope: 'workspace',
  input: GrafanaUrlInput,
  handler: async ({ grafanaUrl }, ctx): Promise<LogsSession> => grafanaSessions.check(ctx.host, grafanaUrl),
});

const grafanaSignIn = defineCommand({
  id: 'db.grafana.signin',
  title: 'Sign in to Grafana for Redis',
  description: "Opens Grafana's login page in a window and resolves once the user is signed in or closes it.",
  scope: 'workspace',
  // A window on the user's screen that only the user can complete: the UI's to open, not an agent's.
  hidden: true,
  input: GrafanaUrlInput,
  handler: async ({ grafanaUrl }, ctx): Promise<LogsSession> => grafanaSessions.signIn(ctx.host, grafanaUrl),
});

const grafanaRedisSources = defineCommand({
  id: 'db.grafana.redis.datasources',
  title: 'List Grafana Redis data sources',
  description:
    'The Redis data sources (redis-datasource plugin) the signed-in Grafana user can query, with uid and name for a connection whose access is grafana. cliDisabled means the admin turned the CLI off: such a connection only reads (key browser, info).',
  scope: 'workspace',
  input: GrafanaUrlInput,
  handler: async ({ grafanaUrl }, ctx): Promise<GrafanaRedisDatasource[]> => grafanaRedisDatasources(ctx.host, grafanaUrl),
});

// ---------- schema ----------

const schemaDatabases = defineCommand({
  id: 'db.schema.databases',
  title: 'List databases',
  description: 'Lists schemas on a MySQL server, schemas of the connected PostgreSQL database, or attached databases in SQLite.',
  scope: 'workspace',
  input: ConnectionIdInput,
  handler: async ({ connectionId }, ctx) => withDriver(ctx, connectionId, (d) => d.databases()),
});

const schemaTables = defineCommand({
  id: 'db.schema.tables',
  title: 'List tables',
  description: 'Lists tables and views. For MySQL and PostgreSQL pass database to pick a schema other than the connection default (PostgreSQL: public).',
  scope: 'workspace',
  input: ConnectionIdInput.extend({ database: z.string().nullable().optional() }),
  handler: async ({ connectionId, database }, ctx) => withDriver(ctx, connectionId, (d) => d.tables(database)),
});

const schemaTable = defineCommand({
  id: 'db.schema.table',
  title: 'Describe table',
  description: 'Columns, primary key, indexes, foreign keys (both directions) and the CREATE statement of a table or view.',
  scope: 'workspace',
  input: ConnectionIdInput.extend({ table: z.string(), database: z.string().nullable().optional() }),
  handler: async ({ connectionId, table, database }, ctx) => withDriver(ctx, connectionId, (d) => d.table(table, database)),
});

const schemaColumns = defineCommand({
  id: 'db.schema.columns',
  title: 'List all columns',
  description: 'Every table and view of a database with its columns and their types, in one call. Feeds the SQL editor completion and the schema search.',
  scope: 'workspace',
  input: ConnectionIdInput.extend({ database: z.string().nullable().optional() }),
  handler: async ({ connectionId, database }, ctx): Promise<DbTableColumns[]> => withDriver(ctx, connectionId, (d) => d.columns(database)),
});

const SEARCH_LIMIT = 200;

/** Schemas every MySQL server has; nobody searches them for their own tables. */
const MYSQL_SYSTEM_SCHEMAS = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);

const schemaSearch = defineCommand({
  id: 'db.schema.search',
  title: 'Search tables and columns',
  description:
    'Finds tables and columns whose name contains the text, across every database of every SQL connection of the workspace (MySQL system schemas left out) or one connection. Connections that cannot be reached are reported under errors, not thrown.',
  scope: 'workspace',
  input: z.object({ query: z.string().min(1), connectionId: z.string().optional(), limit: z.number().int().min(1).max(1000).default(SEARCH_LIMIT) }),
  handler: async ({ query, connectionId, limit }, ctx): Promise<{ matches: DbSchemaMatch[]; errors: { connectionId: string; connectionName: string; message: string }[] }> => {
    const needle = query.trim().toLowerCase();
    const connections = (await listConnections(ws(ctx))).filter((c) => isSqlKind(c.kind) && (!connectionId || c.id === connectionId));
    const matches: DbSchemaMatch[] = [];
    const errors: { connectionId: string; connectionName: string; message: string }[] = [];
    for (const conn of connections) {
      try {
        // Every database of the connection: MySQL schemas (minus the server's own), PostgreSQL schemas, SQLite's attached databases.
        const databases = (await withDriver(ctx, conn.id, (d) => d.databases())).filter((name) => conn.kind !== 'mysql' || !MYSQL_SYSTEM_SCHEMAS.has(name.toLowerCase()));
        for (const database of databases.length ? databases : [null]) {
          const tables = await withDriver(ctx, conn.id, (d) => d.columns(database));
          for (const t of tables) {
            if (t.name.toLowerCase().includes(needle)) matches.push({ connectionId: conn.id, connectionName: conn.name, kind: conn.kind, database, table: t.name, column: null, type: t.type });
            for (const c of t.columns) {
              if (c.name.toLowerCase().includes(needle)) matches.push({ connectionId: conn.id, connectionName: conn.name, kind: conn.kind, database, table: t.name, column: c.name, type: c.type });
            }
            if (matches.length >= limit) break;
          }
          if (matches.length >= limit) break;
        }
      } catch (err) {
        errors.push({ connectionId: conn.id, connectionName: conn.name, message: err instanceof Error ? err.message : String(err) });
      }
      if (matches.length >= limit) break;
    }
    return { matches: matches.slice(0, limit), errors };
  },
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

const tableApply = defineCommand({
  id: 'db.table.apply',
  title: 'Apply row edits',
  description:
    'Inserts, updates and deletes rows of a table, each edit keyed by the primary key, inside one transaction. Pass preview to get the statements without running them. An update or delete that matches anything but exactly one row rolls everything back.',
  scope: 'workspace',
  mutating: ({ preview }) => !preview,
  input: ConnectionIdInput.extend({
    table: z.string(),
    database: z.string().nullable().optional(),
    edits: z.array(DbTableEditSchema).min(1),
    preview: z.boolean().default(false),
  }),
  handler: async ({ connectionId, table, database, edits, preview }, ctx): Promise<DbTableApplyResult> => {
    const { connection, driver } = await pool.acquire(ws(ctx), ctx.host, connectionId);
    requireSql(connection);
    const kind = connection.kind as 'mysql' | 'postgres' | 'sqlite';
    const planned = edits.map((edit) => ({ edit, statement: buildTableEdits(kind, table, database, [edit])[0] ?? null })).filter((p): p is { edit: DbTableEdit; statement: string } => p.statement !== null);
    const statements = planned.map((p) => p.statement);
    if (preview || !statements.length) return { statements, applied: false, affectedRows: 0, durationMs: 0 };

    const started = performance.now();
    const entry: DbHistoryEntry = {
      id: newId(),
      at: nowIso(),
      connectionId: connection.id,
      connectionName: connection.name,
      database: database ?? (connection.database || null),
      text: statements.map((s) => `${s};`).join('\n'),
      ok: false,
      error: null,
      durationMs: 0,
      rowCount: null,
    };
    let affectedRows = 0;
    const options = { database, maxRows: 1 };
    try {
      await driver.run(beginStatement(kind), options);
      try {
        for (const { edit, statement } of planned) {
          const [result] = await driver.run(statement, options);
          const affected = result?.affectedRows ?? 0;
          if (edit.kind !== 'insert' && affected !== 1) {
            throw new QuiverError('CONFLICT', `${edit.kind === 'update' ? 'Update' : 'Delete'} matched ${affected} rows instead of one; nothing was changed. The row may have been changed elsewhere, reload and try again.`, { statement, affected });
          }
          affectedRows += affected;
        }
        await driver.run('COMMIT', options);
      } catch (err) {
        await driver.run('ROLLBACK', options).catch(() => {});
        throw err;
      }
      entry.ok = true;
      entry.rowCount = affectedRows;
    } catch (err) {
      const explained = await explainAccessError(ctx.host, connection, err);
      entry.error = explained instanceof Error ? explained.message : String(explained);
      throw explained;
    } finally {
      entry.durationMs = Math.round(performance.now() - started);
      await recordHistory(ctx, entry);
      announceData(ctx, connection.id);
    }
    return { statements, applied: true, affectedRows, durationMs: entry.durationMs };
  },
});

// ---------- queries ----------

const RunInput = ConnectionIdInput.extend({
  query: z.string().min(1).describe('SQL statements separated by semicolons, or Redis commands one per line'),
  database: z.string().nullable().optional().describe('MySQL schema to USE first, or the PostgreSQL schema to put on search_path'),
  maxRows: z.number().int().min(1).max(50_000).default(500),
  /** Record in workspace query history. Defaults to true. */
  record: z.boolean().optional(),
});

const queryRun = defineCommand({
  id: 'db.query.run',
  title: 'Run query',
  description:
    'Runs SQL against a MySQL, PostgreSQL or SQLite connection, or commands against Redis. Returns one result per statement: rows (as arrays with columns), affected row counts, or the raw Redis reply. Result sets are capped at maxRows. db.query.cancel stops a statement that is still running.',
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
      if (input.record !== false) await recordHistory(ctx, entry);
      // Classified as for agents; a failed script may still have run its first statements.
      const wrote = connection.kind === 'redis' ? !redisScriptIsReadOnly(input.query) : !scriptIsReadOnly(input.query);
      if (wrote) announceData(ctx, connection.id);
      // A COMMIT or ROLLBACK typed by hand ends the transaction the toggle began.
      if (connection.kind !== 'redis' && /^\s*(COMMIT|ROLLBACK)\b/i.test(input.query) && pool.isInTransaction(w.id, connection.id)) {
        pool.setTransaction(w.id, connection.id, false);
        ctx.host.emit('store.changed', { workspaceId: w.id, collection: COLLECTIONS.connections });
      }
    }
  },
});

const queryCancel = defineCommand({
  id: 'db.query.cancel',
  title: 'Cancel running query',
  description:
    'Stops the statement running on a connection, from a second connection to the same server (MySQL KILL QUERY, PostgreSQL pg_cancel_backend). The running db.query.run then fails with QUERY_CANCELLED. SQLite and Redis cannot be interrupted: supported is false.',
  scope: 'workspace',
  input: ConnectionIdInput,
  handler: async ({ connectionId }, ctx): Promise<{ supported: boolean; cancelled: boolean }> => {
    const driver = pool.peek(ws(ctx).id, connectionId);
    if (!driver?.cancel) return { supported: false, cancelled: false };
    return { supported: true, cancelled: await driver.cancel() };
  },
});

const transaction = defineCommand({
  id: 'db.transaction',
  title: 'Begin, commit or roll back a transaction',
  description:
    'Runs BEGIN, COMMIT or ROLLBACK on the pooled connection, so every statement sent to that connection until commit or rollback is part of the transaction, from any tab or agent. Commit is the mutating step.',
  scope: 'workspace',
  mutating: ({ action }) => action === 'commit',
  input: ConnectionIdInput.extend({ action: z.enum(['begin', 'commit', 'rollback']) }),
  handler: async ({ connectionId, action }, ctx): Promise<{ inTransaction: boolean }> => {
    const w = ws(ctx);
    const { connection, driver } = await pool.acquire(w, ctx.host, connectionId);
    requireSql(connection);
    const inTransaction = pool.isInTransaction(w.id, connection.id);
    if (action === 'begin' && inTransaction) return { inTransaction: true };
    if (action !== 'begin' && !inTransaction) throw new QuiverError('INVALID_INPUT', 'No transaction is open on this connection');
    try {
      await driver.run(action === 'begin' ? beginStatement(connection.kind) : action === 'commit' ? 'COMMIT' : 'ROLLBACK', { maxRows: 1 });
    } catch (err) {
      throw await explainAccessError(ctx.host, connection, err);
    }
    pool.setTransaction(w.id, connection.id, action === 'begin');
    ctx.host.emit('store.changed', { workspaceId: w.id, collection: COLLECTIONS.connections });
    if (action !== 'begin') announceData(ctx, connection.id);
    return { inTransaction: action === 'begin' };
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
  description: 'Creates or updates a saved query (omit id to create). The text may hold {{parameters}}; the UI asks for their values when it runs the query.',
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

// ---------- export ----------

const EXPORT_MAX_ROWS = 1_000_000;

const exportRows = defineCommand({
  id: 'db.export',
  title: 'Export rows',
  description:
    'Runs a query or reads a table (with optional filter and ordering) and renders the rows as csv, json, markdown or sql (INSERT statements). Returns the text, or writes it to path (relative to the workspace) and returns the file. Writing a file, or a query that writes, is mutating.',
  scope: 'workspace',
  mutating: async ({ path: target, query, connectionId }, ctx) => {
    if (target) return true;
    if (!query) return false;
    const conn = await ws(ctx).store.get<DbConnection>(COLLECTIONS.connections, connectionId);
    return conn ? !scriptIsReadOnly(query) : false;
  },
  input: ConnectionIdInput.extend({
    format: z.enum(['csv', 'json', 'markdown', 'sql']),
    query: z.string().optional().describe('A SELECT; its first result set is exported'),
    table: z.string().optional().describe('Instead of query: the table to read'),
    database: z.string().nullable().optional(),
    where: z.string().nullable().optional(),
    orderBy: z.string().nullable().optional(),
    direction: z.enum(['asc', 'desc']).optional(),
    maxRows: z.number().int().min(1).max(EXPORT_MAX_ROWS).default(10_000),
    path: z.string().optional().describe('Write to this file instead of returning the text'),
  }),
  handler: async (input, ctx): Promise<DbExportResult> => {
    const w = ws(ctx);
    const { connection, driver } = await pool.acquire(w, ctx.host, input.connectionId);
    requireSql(connection);
    const kind = connection.kind as 'mysql' | 'postgres' | 'sqlite';
    let columns: { name: string }[];
    let rows: unknown[][];
    let truncated = false;
    try {
      if (input.query) {
        const results = await driver.run(input.query, { database: input.database, maxRows: input.maxRows });
        const set = results.find((r) => r.kind === 'rows');
        if (!set) throw new QuiverError('INVALID_INPUT', 'The query returned no rows to export');
        columns = set.columns;
        rows = set.rows;
        truncated = set.truncated;
      } else if (input.table) {
        const page = await driver.tableRows(input.table, { database: input.database, limit: input.maxRows, offset: 0, where: input.where, orderBy: input.orderBy, direction: input.direction });
        columns = page.columns;
        rows = page.rows;
        truncated = page.total !== null && page.total > rows.length;
      } else {
        throw new QuiverError('INVALID_INPUT', 'Pass query or table');
      }
    } catch (err) {
      throw await explainAccessError(ctx.host, connection, err);
    }
    const format = input.format as DbExportFormat;
    const text = formatRows({ format, columns, rows, kind, table: input.table ?? 'export', database: input.table ? input.database : null });
    if (!input.path) return { format, rows: rows.length, text, path: null, bytes: Buffer.byteLength(text), truncated };
    const target = path.isAbsolute(input.path) ? input.path : path.resolve(w.path, input.path);
    const named = path.extname(target) ? target : `${target}.${EXPORT_EXTENSIONS[format]}`;
    await fs.mkdir(path.dirname(named), { recursive: true });
    await fs.writeFile(named, text, 'utf8');
    return { format, rows: rows.length, text: null, path: named, bytes: Buffer.byteLength(text), truncated };
  },
});

// ---------- history ----------

const historyList = defineCommand({
  id: 'db.history.list',
  title: 'Query history',
  description: 'Most recent queries run in this workspace with timing and outcome. search matches the query text and connection name; ok keeps only successes (true) or failures (false).',
  scope: 'workspace',
  input: z.object({
    limit: z.number().int().min(1).max(2000).default(50),
    connectionId: z.string().optional(),
    search: z.string().optional(),
    ok: z.boolean().optional(),
  }),
  handler: async ({ limit, connectionId, search, ok }, ctx) => {
    const filtered = Boolean(connectionId || search || ok !== undefined);
    const entries = await ws(ctx).store.readLog<DbHistoryEntry>(HISTORY_LOG, filtered ? Math.max(limit * 4, 2000) : limit);
    const needle = search?.trim().toLowerCase();
    return entries
      .filter((e) => !connectionId || e.connectionId === connectionId)
      .filter((e) => ok === undefined || e.ok === ok)
      .filter((e) => !needle || e.text.toLowerCase().includes(needle) || e.connectionName.toLowerCase().includes(needle))
      .slice(0, limit);
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

const redisCommand = defineCommand({
  id: 'db.redis.command',
  title: 'Run Redis commands',
  description:
    'Runs Redis commands given as argument lists (no quoting rules: a value may hold spaces, quotes or line breaks), e.g. [["SET", "k", "v", "KEEPTTL"]]. Read-only commands always work; anything that writes is gated. The key browser uses it for its edits.',
  scope: 'workspace',
  mutating: ({ commands }) => !commands.every(redisCommandIsReadOnly),
  input: ConnectionIdInput.extend({ commands: z.array(z.array(z.string()).min(1)).min(1).max(100) }),
  handler: async ({ connectionId, commands }, ctx): Promise<DbQueryResult[]> => {
    const results = await withDriver(ctx, connectionId, (d) => requireRedis(d).exec(commands));
    if (!commands.every(redisCommandIsReadOnly)) announceData(ctx, connectionId);
    return results;
  },
});

const redisInfo = defineCommand({
  id: 'db.redis.info',
  title: 'Redis server info',
  description: 'Version, uptime, connected clients, memory, key count, ops per second and the keyspace hit rate, from INFO and DBSIZE.',
  scope: 'workspace',
  input: ConnectionIdInput,
  handler: async ({ connectionId }, ctx) => withDriver(ctx, connectionId, (d) => requireRedis(d).info()),
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
    schemaColumns,
    schemaSearch,
    tableRows,
    tableApply,
    queryRun,
    queryCancel,
    transaction,
    queryList,
    queryGet,
    querySave,
    queryDelete,
    exportRows,
    historyList,
    historyClear,
    redisKeys,
    redisKey,
    redisCommand,
    redisInfo,
    grafanaSession,
    grafanaSignIn,
    grafanaRedisSources,
  ],
  onWorkspaceClose: (workspace, host) => pool.closeWorkspace(workspace.id, host),
});
