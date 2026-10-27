import {
  LogsConnectionDraftSchema,
  LogsConnectionSchema,
  LogsFilterSchema,
  QuiverError,
  VICTORIA_LOGS_TYPES,
  compact,
  composeLogsQuery,
  defineCommand,
  defineModule,
  logsHitsStep,
  newId,
  newLogsConnection,
  normalizeGrafanaUrl,
  normalizeVictoriaLogsUrl,
  nowIso,
  resolveLogsTime,
  type CommandContext,
  type LogsConnection,
  type LogsConnectionDraft,
  type LogsConnectionSummary,
  type LogsConnectionTest,
  type LogsDatasource,
  type LogsFieldCount,
  type LogsHistoryEntry,
  type LogsHits,
  type LogsQueryResult,
  type LogsSession,
  type WorkspaceApi,
} from '@quiver/core';
import { z } from 'zod';
import { grafanaSessions as sessions } from '../grafana/sessions';
import { GrafanaLogsBackend, VictoriaLogsBackend, type LogsBackend, type LogsRange } from './backends';
import { connectionsWithSecret, readLogsSecret, writeLogsSecret } from './secrets';

export const LOGS_COLLECTION = 'logs-connections';
const HISTORY_LOG = 'logs-history';

const UNCHECKED: LogsSession = { state: 'unknown', user: null, error: null, checkedAt: null };

/** The last check of each direct connection on this machine, by workspace and connection id; they need no sign-in, so this is all their "session" is. */
const directChecks = new Map<string, LogsSession>();

function ws(ctx: CommandContext): WorkspaceApi {
  return ctx.workspace!;
}

function directKey(w: WorkspaceApi, id: string): string {
  return `${w.id}\u0000${id}`;
}

function sessionOf(w: WorkspaceApi, conn: LogsConnection): LogsSession {
  return conn.kind === 'victorialogs' ? (directChecks.get(directKey(w, conn.id)) ?? UNCHECKED) : sessions.session(conn.grafanaUrl);
}

/** Remember how a direct connection's last check or query went, and tell the views when that changed. */
function noteDirect(ctx: CommandContext, conn: LogsConnection, outcome: { ok: boolean; error?: string } | null): LogsSession {
  const w = ws(ctx);
  const key = directKey(w, conn.id);
  const before = directChecks.get(key);
  const after: LogsSession = outcome ? { state: outcome.ok ? 'signed-in' : 'signed-out', user: null, error: outcome.ok ? null : (outcome.error ?? null), checkedAt: nowIso() } : UNCHECKED;
  if (outcome) directChecks.set(key, after);
  else directChecks.delete(key);
  if ((before?.state ?? 'unknown') !== after.state || (before?.error ?? null) !== after.error) ctx.host.emit('logs.changed', { reason: 'session', workspaceId: w.id });
  return after;
}

async function summaries(w: WorkspaceApi, conns: LogsConnection[]): Promise<LogsConnectionSummary[]> {
  const withSecret = await connectionsWithSecret(w);
  return conns.map((conn) => ({ ...conn, session: sessionOf(w, conn), hasSecret: withSecret.has(conn.id) }));
}

async function summary(w: WorkspaceApi, conn: LogsConnection): Promise<LogsConnectionSummary> {
  return (await summaries(w, [conn]))[0]!;
}

async function listConnections(w: WorkspaceApi): Promise<LogsConnection[]> {
  const out: LogsConnection[] = [];
  for (const item of await w.store.list<LogsConnection>(LOGS_COLLECTION)) {
    const parsed = LogsConnectionSchema.safeParse(item);
    if (parsed.success) out.push(parsed.data);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function getConnection(w: WorkspaceApi, id: string): Promise<LogsConnection> {
  const item = await w.store.get<LogsConnection>(LOGS_COLLECTION, id);
  if (!item) throw new QuiverError('NOT_FOUND', `Logs connection ${id} not found`);
  return LogsConnectionSchema.parse(item);
}

/** Fields of a direct connection whose change makes its last check stale. */
const DIRECT_FIELDS = ['kind', 'url', 'tenant', 'auth', 'authUsername'] as const;

async function saveConnection(ctx: CommandContext, draft: LogsConnectionDraft, secret: string | undefined): Promise<LogsConnectionSummary> {
  const w = ws(ctx);
  const existing = draft.id ? await w.store.get<LogsConnection>(LOGS_COLLECTION, draft.id) : undefined;
  if (draft.grafanaUrl !== undefined && draft.grafanaUrl.trim() && !normalizeGrafanaUrl(draft.grafanaUrl)) {
    throw new QuiverError('INVALID_INPUT', `"${draft.grafanaUrl}" is not an http(s) address`);
  }
  if (draft.url !== undefined && draft.url.trim() && !normalizeVictoriaLogsUrl(draft.url)) {
    throw new QuiverError('INVALID_INPUT', `"${draft.url}" is not an http(s) address`);
  }
  const { tenant, ...rest } = draft;
  const base: Record<string, unknown> = {
    ...(existing ?? newLogsConnection()),
    ...compact(rest),
    ...(tenant ? { tenant } : {}),
    id: draft.id ?? newId(),
    createdAt: existing?.createdAt ?? draft.createdAt ?? nowIso(),
    updatedAt: nowIso(),
  };
  if (tenant === null) delete base['tenant'];
  const merged = LogsConnectionSchema.parse(base);
  merged.grafanaUrl = normalizeGrafanaUrl(merged.grafanaUrl);
  merged.url = normalizeVictoriaLogsUrl(merged.url);
  if (!merged.name.trim()) merged.name = merged.kind === 'victorialogs' ? 'VictoriaLogs' : merged.datasourceName || 'Logs';
  await w.store.put(LOGS_COLLECTION, merged);
  if (secret !== undefined) {
    // Per machine and encrypted; writeLocal does not announce itself, so the views are told here.
    await writeLogsSecret(w, ctx.host, merged.id, secret || null);
    ctx.host.emit('logs.changed', { reason: 'session', workspaceId: w.id });
  }
  if (secret !== undefined || DIRECT_FIELDS.some((k) => draft[k] !== undefined)) noteDirect(ctx, merged, null);
  return summary(w, merged);
}

/**
 * Whether a save points an existing connection that has a stored password or token at another VictoriaLogs
 * address without giving a new secret: the next query would send the stored one there.
 */
async function movesStoredSecret(w: WorkspaceApi, draft: LogsConnectionDraft, secret: string | undefined): Promise<boolean> {
  if (!draft.id || secret !== undefined || draft.url === undefined) return false;
  const existing = await w.store.get<LogsConnection>(LOGS_COLLECTION, draft.id);
  if (!existing || !(await connectionsWithSecret(w)).has(draft.id)) return false;
  return normalizeVictoriaLogsUrl(draft.url) !== normalizeVictoriaLogsUrl(LogsConnectionSchema.parse(existing).url);
}

/** A connection that can be queried: an address and a data source, or a VictoriaLogs address. */
function queryable(conn: LogsConnection): LogsConnection {
  if (conn.kind === 'victorialogs') {
    if (!conn.url) throw new QuiverError('INVALID_INPUT', `"${conn.name}" has no VictoriaLogs address yet`);
    return conn;
  }
  if (!conn.grafanaUrl) throw new QuiverError('INVALID_INPUT', `"${conn.name}" has no Grafana address yet`);
  if (!conn.datasourceUid) throw new QuiverError('INVALID_INPUT', `"${conn.name}" has no data source yet; pick one (logs.datasources lists them)`);
  return conn;
}

async function backendFor(ctx: CommandContext, conn: LogsConnection): Promise<LogsBackend> {
  if (conn.kind === 'victorialogs') return new VictoriaLogsBackend(conn, await readLogsSecret(ws(ctx), ctx.host, conn.id));
  return new GrafanaLogsBackend(ctx.host, conn);
}

/** Sign-in belongs to Grafana connections; a direct one is refused with a message saying so. */
async function grafanaConnection(ctx: CommandContext, id: string, what: string): Promise<LogsConnection> {
  const conn = await getConnection(ws(ctx), id);
  if (conn.kind === 'victorialogs') throw new QuiverError('NOT_SUPPORTED', `"${conn.name}" talks to VictoriaLogs directly and needs no ${what}; logs.connection.test checks it.`);
  return conn;
}

function range(from: string, to: string): LogsRange {
  const now = Date.now();
  const fromMs = resolveLogsTime(from, now);
  const toMs = resolveLogsTime(to, now);
  if (fromMs >= toMs) throw new QuiverError('INVALID_INPUT', `The range ends before it starts (${new Date(fromMs).toISOString()} to ${new Date(toMs).toISOString()})`);
  return { fromMs, toMs };
}

async function record(ctx: CommandContext, entry: LogsHistoryEntry): Promise<void> {
  const w = ws(ctx);
  await w.store.appendLog(HISTORY_LOG, entry);
  ctx.host.emit('logs.changed', { reason: 'history', workspaceId: w.id });
}

const ConnectionIdInput = z.object({ id: z.string().describe('Id of a logs connection (see logs.connection.list)') });

const QueryInput = ConnectionIdInput.extend({
  query: z.string().default('*').describe('LogsQL, e.g. `error`, `app:="api" timeout`, `* | stats by (level) count()`'),
  filters: z.array(LogsFilterSchema).default([]).describe('Exact field matches ANDed in front of the query'),
  from: z.string().default('now-15m').describe('now-15m, 15m, epoch ms or an ISO date'),
  to: z.string().default('now'),
});

// ---------- connections ----------

const connectionList = defineCommand({
  id: 'logs.connection.list',
  title: 'List logs connections',
  description:
    'Lists the VictoriaLogs connections of this workspace: `kind` grafana (a Grafana address and a data source, with what is known about the Grafana sign-in on this machine) or victorialogs (a VictoriaLogs server queried directly, with its last check as `session` and `hasSecret` saying whether a password or token is stored on this machine; the value is never returned).',
  scope: 'workspace',
  input: z.object({}),
  handler: async (_input, ctx) => {
    const w = ws(ctx);
    return summaries(w, await listConnections(w));
  },
});

const connectionGet = defineCommand({
  id: 'logs.connection.get',
  title: 'Get logs connection',
  description: 'Returns one logs connection with its sign-in state (or, for a direct connection, its last check and `hasSecret`).',
  scope: 'workspace',
  input: ConnectionIdInput,
  handler: async ({ id }, ctx) => summary(ws(ctx), await getConnection(ws(ctx), id)),
});

const connectionSave = defineCommand({
  id: 'logs.connection.save',
  title: 'Save logs connection',
  description:
    'Creates or updates a logs connection; omit id to create. Only the fields given are changed. `kind` is grafana (the default) or victorialogs. For grafana: `grafanaUrl` is the Grafana that holds the VictoriaLogs data source, `datasourceUid` and `datasourceName` pick it (logs.datasources lists them once signed in). For victorialogs: `url` is the server (e.g. http://localhost:9428), `tenant` `{ accountId, projectId }` is sent as the AccountID and ProjectID headers (null removes it), `auth` is none, basic (with `authUsername`) or bearer. `secret` is the password or token: encrypted and stored on this machine only, never in the committed file; an empty string removes it, and leaving it out keeps the stored one (moving a connection that has one to another `url` without a new secret counts as a mutation, since the stored one would be sent there).',
  scope: 'workspace',
  input: z.object({
    connection: LogsConnectionDraftSchema,
    secret: z
      .string()
      // Sent as a header: a line break or control character would be refused by the HTTP client with the value in its message.
      .refine((v) => !/[\u0000-\u001f\u007f]/.test(v), 'The password or token cannot hold line breaks or control characters')
      .optional()
      .describe('Password (basic) or token (bearer) of a direct connection; stored on this machine only. "" removes it.'),
  }),
  // Pointing a connection with a stored password or token at another address would send that secret there: an agent needs mutations for that.
  mutating: async ({ connection, secret }, ctx) => movesStoredSecret(ws(ctx), connection, secret),
  handler: async ({ connection, secret }, ctx) => saveConnection(ctx, connection, secret),
});

const connectionDelete = defineCommand({
  id: 'logs.connection.delete',
  title: 'Delete logs connection',
  description: 'Deletes a logs connection and the password or token stored for it on this machine. The Grafana sign-in on this machine stays for other connections to the same address.',
  scope: 'workspace',
  mutating: true,
  input: ConnectionIdInput,
  handler: async ({ id }, ctx) => {
    const w = ws(ctx);
    const deleted = await w.store.remove(LOGS_COLLECTION, id);
    await writeLogsSecret(w, ctx.host, id, null);
    directChecks.delete(directKey(w, id));
    return { deleted };
  },
});

const connectionTest = defineCommand({
  id: 'logs.connection.test',
  title: 'Test logs connection',
  description:
    'Checks that the connection answers: for a direct VictoriaLogs connection, a field-names request over the last minute with its tenant and credentials (and the server version from /metrics when it serves it); for a Grafana one, whether this machine is signed in. Returns `{ ok, version?, error?, code? }` and does not throw for a refusal.',
  scope: 'workspace',
  input: ConnectionIdInput,
  handler: async ({ id }, ctx): Promise<LogsConnectionTest> => {
    const conn = await getConnection(ws(ctx), id);
    const result = await (await backendFor(ctx, conn)).check({ version: true });
    if (conn.kind === 'victorialogs') noteDirect(ctx, conn, result);
    return result;
  },
});

// ---------- sign-in ----------

const session = defineCommand({
  id: 'logs.session',
  title: 'Check Grafana sign-in',
  description:
    "Asks Grafana whether this machine is signed in for the connection's address, and as whom. Agents cannot sign in; when `state` is signed-out, ask the user to sign in from Quiver's Logs view. For a direct VictoriaLogs connection it checks the server instead: `signed-in` with no user when it answers, `signed-out` with the error when it does not.",
  scope: 'workspace',
  input: ConnectionIdInput,
  handler: async ({ id }, ctx): Promise<LogsSession> => {
    const conn = await getConnection(ws(ctx), id);
    if (conn.kind !== 'victorialogs') return sessions.check(ctx.host, conn.grafanaUrl);
    if (!conn.url) return noteDirect(ctx, conn, null);
    return noteDirect(ctx, conn, await (await backendFor(ctx, conn)).check());
  },
});

const signIn = defineCommand({
  id: 'logs.signin',
  title: 'Sign in to Grafana',
  description: "Opens Grafana's login page in a window and resolves once the user is signed in or closes it.",
  scope: 'workspace',
  // A window on the user's screen that only the user can complete: the UI's to open, not an agent's.
  hidden: true,
  input: ConnectionIdInput,
  handler: async ({ id }, ctx) => sessions.signIn(ctx.host, (await grafanaConnection(ctx, id, 'sign-in')).grafanaUrl),
});

const signOut = defineCommand({
  id: 'logs.signout',
  title: 'Sign out of Grafana',
  description: "Ends the Grafana session for the connection's address and forgets it on this machine, for every connection to that address.",
  scope: 'workspace',
  mutating: true,
  input: ConnectionIdInput,
  handler: async ({ id }, ctx) => sessions.signOut(ctx.host, (await grafanaConnection(ctx, id, 'sign-out')).grafanaUrl),
});

const datasources = defineCommand({
  id: 'logs.datasources',
  title: 'List VictoriaLogs data sources',
  description: "The VictoriaLogs data sources the signed-in user can query in the connection's Grafana.",
  scope: 'workspace',
  input: ConnectionIdInput,
  handler: async ({ id }, ctx): Promise<LogsDatasource[]> => {
    const conn = await grafanaConnection(ctx, id, 'Grafana data source');
    const { status, body } = await sessions.request<{ datasources?: Record<string, LogsDatasource> }>(ctx.host, conn.grafanaUrl, '/api/frontend/settings');
    if (status !== 200 || typeof body !== 'object' || !body) throw new QuiverError('REQUEST_FAILED', `Grafana answered ${status} for its data sources`);
    return Object.values(body.datasources ?? {})
      .filter((d) => VICTORIA_LOGS_TYPES.includes(d.type))
      .map((d) => ({ uid: d.uid, name: d.name, type: d.type }))
      .sort((a, b) => a.name.localeCompare(b.name));
  },
});

// ---------- queries ----------

const query = defineCommand({
  id: 'logs.query',
  title: 'Query logs',
  description:
    'Runs LogsQL against the connection (its VictoriaLogs data source through Grafana, or the VictoriaLogs server directly) and returns the entries newest first: time, message, level and the other fields. `filters` are exact matches ANDed in front of the query. Narrow wide results with pipes, e.g. `| fields _time, _msg, level` or `| stats by (app) count()`; pipe results come back as entries whose fields are the columns.',
  scope: 'workspace',
  input: QueryInput.extend({ limit: z.number().int().min(1).max(5000).default(100) }),
  handler: async (input, ctx): Promise<LogsQueryResult> => {
    const conn = queryable(await getConnection(ws(ctx), input.id));
    const r = range(input.from, input.to);
    const expr = composeLogsQuery(input.query, input.filters);
    const started = Date.now();
    const entry: LogsHistoryEntry = { id: newId(), connectionId: conn.id, query: input.query, filters: input.filters, range: `${input.from}..${input.to}`, at: nowIso(), count: null, error: null };
    const direct = conn.kind === 'victorialogs';
    try {
      const entries = await (await backendFor(ctx, conn)).query(expr, r, input.limit);
      if (direct) noteDirect(ctx, conn, { ok: true });
      await record(ctx, { ...entry, count: entries.length });
      return { entries, query: expr, from: new Date(r.fromMs).toISOString(), to: new Date(r.toMs).toISOString(), limited: entries.length >= input.limit, tookMs: Date.now() - started };
    } catch (err) {
      const code = err instanceof QuiverError ? err.code : null;
      if (direct && (code === 'LOGS_AUTH_FAILED' || code === 'LOGS_UNREACHABLE')) noteDirect(ctx, conn, { ok: false, error: (err as Error).message });
      if (code !== 'SIGN_IN_REQUIRED') await record(ctx, { ...entry, error: (err as Error).message });
      throw err;
    }
  },
});

const hits = defineCommand({
  id: 'logs.hits',
  title: 'Count logs over time',
  description: 'How many entries match the query (pipes aside) in each step of the range, for a histogram. `stepMs` defaults to about 60 buckets.',
  scope: 'workspace',
  input: QueryInput.extend({ stepMs: z.number().int().min(1000).optional() }),
  handler: async (input, ctx): Promise<LogsHits> => {
    const conn = queryable(await getConnection(ws(ctx), input.id));
    const r = range(input.from, input.to);
    const stepMs = input.stepMs ?? logsHitsStep(r.fromMs, r.toMs);
    const counted = await (await backendFor(ctx, conn)).hits(composeLogsQuery(input.query, input.filters, { pipes: false }), r, stepMs);
    return { ...counted, stepMs, from: new Date(r.fromMs).toISOString(), to: new Date(r.toMs).toISOString() };
  },
});

/** Field names inside the range that the value picker should not offer. */
const INTERNAL_FIELDS = new Set(['_time', '_msg', '_stream', '_stream_id']);

const fields = defineCommand({
  id: 'logs.fields',
  title: 'List log fields',
  description: 'The field names of the entries that match the query (pipes aside) in the range, with how many entries have each, most common first.',
  scope: 'workspace',
  input: QueryInput,
  handler: async (input, ctx): Promise<LogsFieldCount[]> => {
    const conn = queryable(await getConnection(ws(ctx), input.id));
    const names = await (await backendFor(ctx, conn)).fieldNames(composeLogsQuery(input.query, input.filters, { pipes: false }), range(input.from, input.to));
    return names.filter((f) => f.name && !INTERNAL_FIELDS.has(f.name)).sort((a, b) => b.hits - a.hits || a.name.localeCompare(b.name));
  },
});

const values = defineCommand({
  id: 'logs.values',
  title: 'List values of a log field',
  description: 'The most common values of one field among the entries that match the query (pipes aside) in the range, with their counts. An empty value stands for entries without the field.',
  scope: 'workspace',
  input: QueryInput.extend({ field: z.string().min(1), limit: z.number().int().min(1).max(1000).default(50) }),
  handler: async (input, ctx): Promise<LogsFieldCount[]> => {
    const conn = queryable(await getConnection(ws(ctx), input.id));
    const found = await (await backendFor(ctx, conn)).fieldValues(composeLogsQuery(input.query, input.filters, { pipes: false }), input.field, range(input.from, input.to), input.limit);
    return found.sort((a, b) => b.hits - a.hits || a.name.localeCompare(b.name));
  },
});

// ---------- history ----------

const historyList = defineCommand({
  id: 'logs.history.list',
  title: 'Logs query history',
  description: 'Queries run in this workspace, newest first, with their filters, range and how many entries came back or the error. Narrow to one connection with `id`.',
  scope: 'workspace',
  input: z.object({ id: z.string().optional(), limit: z.number().int().min(1).max(500).default(50) }),
  handler: async ({ id, limit }, ctx) => {
    const entries = await ws(ctx).store.readLog<LogsHistoryEntry>(HISTORY_LOG, id ? 2000 : limit);
    return (id ? entries.filter((e) => e.connectionId === id) : entries).slice(0, limit);
  },
});

const historyClear = defineCommand({
  id: 'logs.history.clear',
  title: 'Clear logs query history',
  description: 'Clears the logs query history of this workspace.',
  scope: 'workspace',
  mutating: true,
  input: z.object({}),
  handler: async (_input, ctx) => {
    const w = ws(ctx);
    await w.store.clearLog(HISTORY_LOG);
    ctx.host.emit('logs.changed', { reason: 'history', workspaceId: w.id });
    return { cleared: true };
  },
});

export const logsModule = defineModule({
  id: 'logs',
  collections: { [LOGS_COLLECTION]: LogsConnectionSchema },
  commands: [connectionList, connectionGet, connectionSave, connectionDelete, connectionTest, session, signIn, signOut, datasources, query, hits, fields, values, historyList, historyClear],
});
