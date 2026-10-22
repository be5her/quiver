import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  METABASE_EXPORT_FORMATS,
  MetabaseConnectionDraftSchema,
  MetabaseConnectionSchema,
  MetabaseParameterValueSchema,
  MetabaseTableFilterSchema,
  MetabaseTableOrderSchema,
  QuiverError,
  compact,
  defineCommand,
  defineModule,
  newId,
  newMetabaseConnection,
  normalizeMetabaseUrl,
  nowIso,
  scriptIsReadOnly,
  type CommandContext,
  type DbQueryResult,
  type HostApi,
  type MetabaseConnection,
  type MetabaseConnectionDraft,
  type MetabaseConnectionSummary,
  type MetabaseExportResult,
  type MetabaseHistoryEntry,
  type MetabaseSession,
  type MetabaseTestResult,
  type WorkspaceApi,
} from '@quiver/core';
import { z } from 'zod';
import {
  collectionItems,
  collectionTree,
  currentUser,
  exportRows,
  getCard,
  getDashboard,
  isAuthError,
  listDatabases,
  listTables,
  runCard,
  runNative,
  runTableQuery,
  search,
  serverVersion,
} from './client';
import { connectionsWithApiKey, hasApiKey, writeApiKey } from './secrets';
import { metabaseSessions as sessions } from './sessions';

export const METABASE_COLLECTION = 'metabase-connections';
const HISTORY_LOG = 'metabase-history';

function ws(ctx: CommandContext): WorkspaceApi {
  return ctx.workspace!;
}

// ---------- API key sessions ----------

/** What the last check of each API key connection found, per connection: a key belongs to a connection, not an address. */
const keySessions = new Map<string, MetabaseSession>();

function keySession(conn: MetabaseConnection, withKey: boolean): MetabaseSession {
  if (!withKey) return { state: 'signed-out', user: null, error: null, checkedAt: null };
  return keySessions.get(conn.id) ?? { state: 'unknown', user: null, error: null, checkedAt: null };
}

function setKeySession(host: HostApi, conn: MetabaseConnection, session: MetabaseSession | null): MetabaseSession | null {
  const before = keySessions.get(conn.id);
  if (session) keySessions.set(conn.id, session);
  else keySessions.delete(conn.id);
  if (before?.state !== session?.state || before?.user?.id !== session?.user?.id || before?.error !== session?.error) {
    host.emit('metabase.changed', { reason: 'session', url: conn.url || undefined, connectionId: conn.id });
  }
  return session;
}

/** Ask Metabase who the key is. No key, or a refused one, is signed out with the reason. */
async function checkKey(ctx: CommandContext, conn: MetabaseConnection): Promise<MetabaseSession> {
  const checkedAt = nowIso();
  if (!(await hasApiKey(ws(ctx), conn.id))) {
    return setKeySession(ctx.host, conn, { state: 'signed-out', user: null, error: 'No API key on this machine', checkedAt })!;
  }
  try {
    const user = await currentUser(ctx.host, ws(ctx), conn);
    return setKeySession(ctx.host, conn, { state: 'signed-in', user, error: null, checkedAt })!;
  } catch (err) {
    const refused = err instanceof QuiverError && err.code === 'AUTH_FAILED';
    return setKeySession(ctx.host, conn, { state: refused ? 'signed-out' : 'unknown', user: null, error: (err as Error).message, checkedAt })!;
  }
}

// ---------- connections ----------

function summary(conn: MetabaseConnection, withKey: boolean): MetabaseConnectionSummary {
  const session = conn.auth === 'apikey' ? keySession(conn, withKey) : sessions.session(conn.url);
  return { ...conn, session, hasApiKey: withKey };
}

async function summaryOf(w: WorkspaceApi, conn: MetabaseConnection): Promise<MetabaseConnectionSummary> {
  return summary(conn, await hasApiKey(w, conn.id));
}

async function listConnections(w: WorkspaceApi): Promise<MetabaseConnection[]> {
  const out: MetabaseConnection[] = [];
  for (const item of await w.store.list<MetabaseConnection>(METABASE_COLLECTION)) {
    const parsed = MetabaseConnectionSchema.safeParse(item);
    if (parsed.success) out.push(parsed.data);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function getConnection(w: WorkspaceApi, id: string): Promise<MetabaseConnection> {
  const item = await w.store.get<MetabaseConnection>(METABASE_COLLECTION, id);
  if (!item) throw new QuiverError('NOT_FOUND', `Metabase connection ${id} not found`);
  return MetabaseConnectionSchema.parse(item);
}

/** A connection that can be asked something: it has an address. */
async function reachable(w: WorkspaceApi, id: string): Promise<MetabaseConnection> {
  const conn = await getConnection(w, id);
  if (!conn.url) throw new QuiverError('INVALID_INPUT', `"${conn.name}" has no Metabase address yet`);
  return conn;
}

async function saveConnection(w: WorkspaceApi, draft: MetabaseConnectionDraft): Promise<MetabaseConnectionSummary> {
  const existing = draft.id ? await w.store.get<MetabaseConnection>(METABASE_COLLECTION, draft.id) : undefined;
  if (draft.url !== undefined && draft.url.trim() && !normalizeMetabaseUrl(draft.url)) {
    throw new QuiverError('INVALID_INPUT', `"${draft.url}" is not an http(s) address`);
  }
  const merged = MetabaseConnectionSchema.parse({
    ...(existing ?? newMetabaseConnection()),
    ...compact(draft),
    id: draft.id ?? newId(),
    createdAt: existing?.createdAt ?? draft.createdAt ?? nowIso(),
    updatedAt: nowIso(),
  });
  merged.url = normalizeMetabaseUrl(merged.url);
  if (!merged.name.trim()) merged.name = 'Metabase';
  await w.store.put(METABASE_COLLECTION, merged);
  return summaryOf(w, merged);
}

/** Note on the API key session what a request found out about the key. */
function noteAuth(ctx: CommandContext, conn: MetabaseConnection, err: unknown): void {
  if (conn.auth !== 'apikey' || !(err instanceof QuiverError)) return;
  if (err.code === 'AUTH_FAILED' || err.code === 'AUTH_REQUIRED') setKeySession(ctx.host, conn, { state: 'signed-out', user: null, error: err.message, checkedAt: nowIso() });
}

/** Run a request for a connection, keeping the API key session in step with what Metabase answered. */
async function withConnection<T>(ctx: CommandContext, id: string, fn: (conn: MetabaseConnection) => Promise<T>): Promise<T> {
  const conn = await reachable(ws(ctx), id);
  try {
    return await fn(conn);
  } catch (err) {
    noteAuth(ctx, conn, err);
    throw err;
  }
}

const ConnectionId = z.string().describe('Id of a Metabase connection (see metabase.connection.list)');
const ConnectionInput = z.object({ connectionId: ConnectionId });
const ParametersInput = z.array(MetabaseParameterValueSchema).default([]).describe('Values for the question\'s parameters, by the ids metabase.card.get lists');

const connectionList = defineCommand({
  id: 'metabase.connection.list',
  title: 'List Metabase connections',
  description: 'Lists the Metabase connections of this workspace with how each signs in (browser or API key), whether a key is stored on this machine, and what is known about the session.',
  scope: 'workspace',
  input: z.object({}),
  handler: async (_input, ctx): Promise<MetabaseConnectionSummary[]> => {
    const w = ws(ctx);
    const [conns, withKey] = await Promise.all([listConnections(w), connectionsWithApiKey(w)]);
    return conns.map((c) => summary(c, withKey.has(c.id)));
  },
});

const connectionGet = defineCommand({
  id: 'metabase.connection.get',
  title: 'Get Metabase connection',
  description: 'Returns one Metabase connection with its session state and whether an API key is stored on this machine (never the key).',
  scope: 'workspace',
  input: z.object({ id: ConnectionId }),
  handler: async ({ id }, ctx) => summaryOf(ws(ctx), await getConnection(ws(ctx), id)),
});

const connectionSave = defineCommand({
  id: 'metabase.connection.save',
  title: 'Save Metabase connection',
  description:
    'Creates or updates a Metabase connection; omit id to create. `url` is Metabase\'s address (a sub-path is kept), `auth` is `browser` (the user signs in in a Quiver window) or `apikey` (set the key with metabase.apikey.set). Only the fields given are changed.',
  scope: 'workspace',
  input: z.object({ connection: MetabaseConnectionDraftSchema }),
  handler: async ({ connection }, ctx) => saveConnection(ws(ctx), connection),
});

const connectionDelete = defineCommand({
  id: 'metabase.connection.delete',
  title: 'Delete Metabase connection',
  description: 'Deletes a Metabase connection and its API key on this machine. A browser sign-in stays for other connections to the same address.',
  scope: 'workspace',
  mutating: true,
  input: z.object({ id: ConnectionId }),
  handler: async ({ id }, ctx): Promise<{ deleted: true }> => {
    const w = ws(ctx);
    await getConnection(w, id);
    await w.store.remove(METABASE_COLLECTION, id);
    if (await hasApiKey(w, id)) {
      await writeApiKey(w, ctx.host, id, null);
      ctx.host.emit('metabase.changed', { reason: 'secret', connectionId: id, workspaceId: w.id });
    }
    keySessions.delete(id);
    return { deleted: true };
  },
});

const connectionTest = defineCommand({
  id: 'metabase.connection.test',
  title: 'Test Metabase connection',
  description: 'Asks Metabase who the connection is and which version it runs. Fails with SIGN_IN_REQUIRED, AUTH_REQUIRED or AUTH_FAILED when it cannot authenticate.',
  scope: 'workspace',
  input: ConnectionInput,
  handler: async ({ connectionId }, ctx): Promise<MetabaseTestResult> =>
    withConnection(ctx, connectionId, async (conn) => {
      const user = await currentUser(ctx.host, ws(ctx), conn);
      if (conn.auth === 'apikey') setKeySession(ctx.host, conn, { state: 'signed-in', user, error: null, checkedAt: nowIso() });
      else await sessions.check(ctx.host, conn.url);
      return { user, version: await serverVersion(ctx.host, ws(ctx), conn) };
    }),
});

// ---------- sign-in and keys ----------

const session = defineCommand({
  id: 'metabase.session',
  title: 'Check Metabase sign-in',
  description:
    "Says whether this machine can reach the connection's Metabase, and as whom: the browser session for a browser connection, the stored key for an API key connection. Agents cannot sign in; when `state` is signed-out, ask the user to sign in (or add a key) from Quiver's Metabase view.",
  scope: 'workspace',
  input: ConnectionInput,
  handler: async ({ connectionId }, ctx): Promise<MetabaseSession> => {
    const conn = await reachable(ws(ctx), connectionId);
    return conn.auth === 'apikey' ? checkKey(ctx, conn) : sessions.check(ctx.host, conn.url);
  },
});

const signIn = defineCommand({
  id: 'metabase.signin',
  title: 'Sign in to Metabase',
  description: "Opens Metabase's login page in a window and resolves once the user is signed in or closes it.",
  scope: 'workspace',
  // A window on the user's screen that only the user can complete: the UI's to open, not an agent's.
  hidden: true,
  input: ConnectionInput,
  handler: async ({ connectionId }, ctx): Promise<MetabaseSession> => {
    const conn = await reachable(ws(ctx), connectionId);
    if (conn.auth === 'apikey') throw new QuiverError('INVALID_INPUT', `"${conn.name}" signs in with an API key; set it with metabase.apikey.set`);
    return sessions.signIn(ctx.host, conn.url);
  },
});

const signOut = defineCommand({
  id: 'metabase.signout',
  title: 'Sign out of Metabase',
  description: "Ends the Metabase session for the connection's address and forgets it on this machine, for every connection to that address. An API key connection keeps its key (metabase.apikey.clear removes it).",
  scope: 'workspace',
  mutating: true,
  input: ConnectionInput,
  handler: async ({ connectionId }, ctx): Promise<MetabaseSession> => {
    const conn = await reachable(ws(ctx), connectionId);
    if (conn.auth === 'apikey') return keySession(conn, await hasApiKey(ws(ctx), conn.id));
    return sessions.signOut(ctx.host, conn.url);
  },
});

const apiKeySet = defineCommand({
  id: 'metabase.apikey.set',
  title: 'Set Metabase API key',
  description: 'Stores an API key for the connection, encrypted on this machine and never committed. Answers with the connection summary, never the key; metabase.session checks it.',
  scope: 'workspace',
  mutating: true,
  input: z.object({ connectionId: ConnectionId, apiKey: z.string().min(1) }),
  handler: async ({ connectionId, apiKey }, ctx): Promise<MetabaseConnectionSummary> => {
    const w = ws(ctx);
    const conn = await getConnection(w, connectionId);
    await writeApiKey(w, ctx.host, conn.id, apiKey.trim());
    ctx.host.emit('metabase.changed', { reason: 'secret', connectionId: conn.id, workspaceId: w.id });
    setKeySession(ctx.host, conn, null);
    return summary(conn, true);
  },
});

const apiKeyClear = defineCommand({
  id: 'metabase.apikey.clear',
  title: 'Clear Metabase API key',
  description: "Removes the connection's API key from this machine.",
  scope: 'workspace',
  mutating: true,
  input: ConnectionInput,
  handler: async ({ connectionId }, ctx): Promise<MetabaseConnectionSummary> => {
    const w = ws(ctx);
    const conn = await getConnection(w, connectionId);
    await writeApiKey(w, ctx.host, conn.id, null);
    ctx.host.emit('metabase.changed', { reason: 'secret', connectionId: conn.id, workspaceId: w.id });
    setKeySession(ctx.host, conn, null);
    return summary(conn, false);
  },
});

// ---------- browsing ----------

const databases = defineCommand({
  id: 'metabase.databases',
  title: 'List Metabase databases',
  description: 'The databases Metabase connects to that the connection can see, with their engine (postgres, mysql…).',
  scope: 'workspace',
  input: ConnectionInput,
  handler: async ({ connectionId }, ctx) => withConnection(ctx, connectionId, (conn) => listDatabases(ctx.host, ws(ctx), conn)),
});

const tables = defineCommand({
  id: 'metabase.tables',
  title: 'List Metabase tables',
  description: "The tables of one of Metabase's databases (see metabase.databases) with their columns and types, as Metabase's metadata has them, sorted by schema then name.",
  scope: 'workspace',
  input: ConnectionInput.extend({ databaseId: z.number().int() }),
  handler: async ({ connectionId, databaseId }, ctx) => withConnection(ctx, connectionId, (conn) => listTables(ctx.host, ws(ctx), conn, databaseId)),
});

const collections = defineCommand({
  id: 'metabase.collections',
  title: 'Metabase collection tree',
  description: 'The collection tree, from the root ("Our analytics", id `root`) down. metabase.collection.items lists what a collection holds.',
  scope: 'workspace',
  input: ConnectionInput,
  handler: async ({ connectionId }, ctx) => withConnection(ctx, connectionId, (conn) => collectionTree(ctx.host, ws(ctx), conn)),
});

const collectionItemsCommand = defineCommand({
  id: 'metabase.collection.items',
  title: 'List a Metabase collection',
  description: 'The sub-collections, saved questions (`card`) and dashboards in one collection; `root` is the top level.',
  scope: 'workspace',
  input: ConnectionInput.extend({ collectionId: z.string().min(1).describe('A collection id from metabase.collections, or `root`') }),
  handler: async ({ connectionId, collectionId }, ctx) => withConnection(ctx, connectionId, (conn) => collectionItems(ctx.host, ws(ctx), conn, collectionId)),
});

const searchCommand = defineCommand({
  id: 'metabase.search',
  title: 'Search Metabase',
  description: 'Finds saved questions and dashboards by name and description.',
  scope: 'workspace',
  input: ConnectionInput.extend({ q: z.string().min(1) }),
  handler: async ({ connectionId, q }, ctx) => withConnection(ctx, connectionId, (conn) => search(ctx.host, ws(ctx), conn, q)),
});

const cardGet = defineCommand({
  id: 'metabase.card.get',
  title: 'Get Metabase question',
  description: 'One saved question: its database, whether it is native SQL (with the SQL) or a query-builder question, how Metabase shows it, its parameters with their ids and types, and its collection.',
  scope: 'workspace',
  input: ConnectionInput.extend({ cardId: z.number().int() }),
  handler: async ({ connectionId, cardId }, ctx) => withConnection(ctx, connectionId, (conn) => getCard(ctx.host, ws(ctx), conn, cardId)),
});

const cardRun = defineCommand({
  id: 'metabase.card.run',
  title: 'Run Metabase question',
  description:
    "Runs a saved question on Metabase with the user's permissions and returns its rows. `parameters` gives values by the parameter ids metabase.card.get lists; parameters left out use the question's defaults. Metabase returns at most 2000 rows here (`truncated` says when it cut); metabase.export gets them all.",
  scope: 'workspace',
  input: ConnectionInput.extend({ cardId: z.number().int(), parameters: ParametersInput }),
  handler: async ({ connectionId, cardId, parameters }, ctx): Promise<DbQueryResult> =>
    withConnection(ctx, connectionId, async (conn) => runCard(ctx.host, ws(ctx), conn, await getCard(ctx.host, ws(ctx), conn, cardId), parameters)),
});

const dashboardGet = defineCommand({
  id: 'metabase.dashboard.get',
  title: 'Get Metabase dashboard',
  description: "A dashboard and the saved questions on it, in order. Run them with metabase.card.run; the dashboard's filters are not applied.",
  scope: 'workspace',
  input: ConnectionInput.extend({ dashboardId: z.number().int() }),
  handler: async ({ connectionId, dashboardId }, ctx) => withConnection(ctx, connectionId, (conn) => getDashboard(ctx.host, ws(ctx), conn, dashboardId)),
});

// ---------- tables through the query builder ----------

const OrderByInput = MetabaseTableOrderSchema.optional().describe('Sort by one field id from metabase.tables, `asc` or `desc`');
const FiltersInput = z.array(MetabaseTableFilterSchema).default([]).describe('Filters on field ids from metabase.tables, ANDed; `is-null`, `not-null`, `is-empty` and `not-empty` take no value');

const tableRows = defineCommand({
  id: 'metabase.table.rows',
  title: 'Browse a Metabase table',
  description:
    "One page of a table's rows (see metabase.tables) through Metabase's query builder, so it works with query-builder permission where native SQL is refused. `limit` rows per page (at most 2000), `page` from 1, an optional `orderBy` and `filters` on field ids. metabase.export with `tableId` gets every row through the filters.",
  scope: 'workspace',
  input: ConnectionInput.extend({
    databaseId: z.number().int(),
    tableId: z.number().int(),
    limit: z.number().int().min(1).max(2000).default(100),
    page: z.number().int().min(1).default(1),
    orderBy: OrderByInput,
    filters: FiltersInput,
  }),
  handler: async ({ connectionId, databaseId, tableId, limit, page, orderBy, filters }, ctx): Promise<DbQueryResult> =>
    withConnection(ctx, connectionId, (conn) => runTableQuery(ctx.host, ws(ctx), conn, { databaseId, tableId, limit, page, orderBy: orderBy ?? null, filters })),
});

// ---------- native queries ----------

async function record(ctx: CommandContext, entry: MetabaseHistoryEntry): Promise<void> {
  const w = ws(ctx);
  await w.store.appendLog(HISTORY_LOG, entry);
  ctx.host.emit('metabase.changed', { reason: 'history', workspaceId: w.id });
}

const queryRun = defineCommand({
  id: 'metabase.query.run',
  title: 'Run SQL through Metabase',
  description:
    "Runs native SQL on one of Metabase's databases (see metabase.databases), as the database user Metabase connects with, and returns the rows. Metabase returns at most 2000 rows here (`truncated` says when it cut). A statement that writes is mutating.",
  scope: 'workspace',
  mutating: ({ sql }) => !scriptIsReadOnly(sql),
  input: ConnectionInput.extend({ databaseId: z.number().int(), sql: z.string().min(1) }),
  handler: async ({ connectionId, databaseId, sql }, ctx): Promise<DbQueryResult> =>
    withConnection(ctx, connectionId, async (conn) => {
      const started = Date.now();
      const entry: MetabaseHistoryEntry = { id: newId(), connectionId: conn.id, databaseId, sql, at: nowIso(), durationMs: 0, rowCount: null, error: null };
      try {
        const result = await runNative(ctx.host, ws(ctx), conn, databaseId, sql);
        await record(ctx, { ...entry, durationMs: Date.now() - started, rowCount: result.rowCount });
        return result;
      } catch (err) {
        if (!isAuthError(err)) await record(ctx, { ...entry, durationMs: Date.now() - started, error: (err as Error).message });
        throw err;
      }
    }),
});

const EXPORT_EXTENSIONS = { csv: 'csv', json: 'json', xlsx: 'xlsx' } as const;

const exportCommand = defineCommand({
  id: 'metabase.export',
  title: 'Export from Metabase',
  description:
    "Exports every row of a saved question (`cardId`, with `parameters`), of native SQL (`databaseId` and `sql`) or of a table through the query builder (`tableId` and `databaseId`, with optional `orderBy` and `filters` as metabase.table.rows takes them) through Metabase's export, formatted as Metabase formats them. Pass exactly one of cardId, sql or tableId. Returns CSV or JSON as text, or writes the file to `path` (relative to the workspace); xlsx needs a path. Writing a file, or SQL that writes, is mutating.",
  scope: 'workspace',
  mutating: (i) => Boolean(i.path) || (i.sql ? !scriptIsReadOnly(i.sql) : false),
  input: ConnectionInput.extend({
    format: z.enum(METABASE_EXPORT_FORMATS),
    path: z.string().optional().describe('Write to this file instead of returning the text'),
    cardId: z.number().int().optional(),
    parameters: ParametersInput,
    databaseId: z.number().int().optional(),
    sql: z.string().optional(),
    tableId: z.number().int().optional().describe('Export a table through the query builder (with databaseId)'),
    orderBy: OrderByInput,
    filters: FiltersInput,
  }),
  handler: async (input, ctx): Promise<MetabaseExportResult> => {
    const hasCard = input.cardId !== undefined;
    const hasTable = input.tableId !== undefined;
    const hasSql = input.sql !== undefined;
    if ([hasCard, hasSql, hasTable].filter(Boolean).length !== 1) throw new QuiverError('INVALID_INPUT', 'Pass exactly one of cardId, sql (with databaseId) or tableId (with databaseId)');
    if (hasSql && (input.databaseId === undefined || !input.sql?.trim())) throw new QuiverError('INVALID_INPUT', 'Native SQL needs both databaseId and sql');
    if (hasTable && input.databaseId === undefined) throw new QuiverError('INVALID_INPUT', 'A table export needs databaseId');
    if (input.format === 'xlsx' && !input.path) throw new QuiverError('INVALID_INPUT', 'An xlsx export needs a path to write to');
    const w = ws(ctx);
    return withConnection(ctx, input.connectionId, async (conn) => {
      const bytes = await exportRows(
        ctx.host,
        w,
        conn,
        input.format,
        input.cardId !== undefined
          ? { card: await getCard(ctx.host, w, conn, input.cardId), values: input.parameters }
          : input.tableId !== undefined
            ? { table: { databaseId: input.databaseId!, tableId: input.tableId, limit: 1_000_000, page: 1, orderBy: input.orderBy ?? null, filters: input.filters } }
            : { databaseId: input.databaseId!, sql: input.sql! },
      );
      if (!input.path) return { format: input.format, path: null, text: bytes.toString('utf8'), bytes: bytes.length };
      const target = path.isAbsolute(input.path) ? input.path : path.resolve(w.path, input.path);
      const named = path.extname(target) ? target : `${target}.${EXPORT_EXTENSIONS[input.format]}`;
      await fs.mkdir(path.dirname(named), { recursive: true });
      await fs.writeFile(named, bytes);
      return { format: input.format, path: named, text: null, bytes: bytes.length };
    });
  },
});

// ---------- history ----------

const historyList = defineCommand({
  id: 'metabase.history.list',
  title: 'Metabase query history',
  description: 'Native queries run through Metabase in this workspace, newest first, with their database, duration and row count or error. Narrow to one connection with `connectionId`.',
  scope: 'workspace',
  input: z.object({ connectionId: z.string().optional(), limit: z.number().int().min(1).max(1000).default(100) }),
  handler: async ({ connectionId, limit }, ctx): Promise<MetabaseHistoryEntry[]> => {
    const entries = await ws(ctx).store.readLog<MetabaseHistoryEntry>(HISTORY_LOG, connectionId ? 5000 : limit);
    return (connectionId ? entries.filter((e) => e.connectionId === connectionId) : entries).slice(0, limit);
  },
});

const historyClear = defineCommand({
  id: 'metabase.history.clear',
  title: 'Clear Metabase query history',
  description: 'Clears the Metabase query history of this workspace.',
  scope: 'workspace',
  mutating: true,
  input: z.object({}),
  handler: async (_input, ctx): Promise<{ cleared: number }> => {
    const w = ws(ctx);
    const cleared = (await w.store.readLog(HISTORY_LOG, Number.MAX_SAFE_INTEGER)).length;
    await w.store.clearLog(HISTORY_LOG);
    ctx.host.emit('metabase.changed', { reason: 'history', workspaceId: w.id });
    return { cleared };
  },
});

export const metabaseModule = defineModule({
  id: 'metabase',
  collections: { [METABASE_COLLECTION]: MetabaseConnectionSchema },
  commands: [
    connectionList,
    connectionGet,
    connectionSave,
    connectionDelete,
    connectionTest,
    session,
    signIn,
    signOut,
    apiKeySet,
    apiKeyClear,
    databases,
    tables,
    collections,
    collectionItemsCommand,
    searchCommand,
    cardGet,
    cardRun,
    dashboardGet,
    tableRows,
    queryRun,
    exportCommand,
    historyList,
    historyClear,
  ],
});
