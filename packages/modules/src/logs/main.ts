import {
  LogsConnectionDraftSchema,
  LogsConnectionSchema,
  LogsFilterSchema,
  QuiverError,
  VICTORIA_LOGS_TYPES,
  cleanGrafanaError,
  compact,
  composeLogsQuery,
  defineCommand,
  defineModule,
  logsFieldName,
  logsHitsStep,
  newId,
  newLogsConnection,
  normalizeGrafanaUrl,
  nowIso,
  parseHitsFrames,
  parseLogFrames,
  resolveLogsTime,
  type CommandContext,
  type GrafanaFrame,
  type HostApi,
  type LogsConnection,
  type LogsConnectionDraft,
  type LogsConnectionSummary,
  type LogsDatasource,
  type LogsFieldCount,
  type LogsHistoryEntry,
  type LogsHits,
  type LogsQueryResult,
  type WorkspaceApi,
} from '@quiver/core';
import { z } from 'zod';
import { grafanaSessions as sessions } from '../grafana/sessions';

export const LOGS_COLLECTION = 'logs-connections';
const HISTORY_LOG = 'logs-history';

function ws(ctx: CommandContext): WorkspaceApi {
  return ctx.workspace!;
}

function summary(conn: LogsConnection): LogsConnectionSummary {
  return { ...conn, session: sessions.session(conn.grafanaUrl) };
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

async function saveConnection(w: WorkspaceApi, draft: LogsConnectionDraft): Promise<LogsConnectionSummary> {
  const existing = draft.id ? await w.store.get<LogsConnection>(LOGS_COLLECTION, draft.id) : undefined;
  if (draft.grafanaUrl !== undefined && draft.grafanaUrl.trim() && !normalizeGrafanaUrl(draft.grafanaUrl)) {
    throw new QuiverError('INVALID_INPUT', `"${draft.grafanaUrl}" is not an http(s) address`);
  }
  const merged = LogsConnectionSchema.parse({
    ...(existing ?? newLogsConnection()),
    ...compact(draft),
    id: draft.id ?? newId(),
    createdAt: existing?.createdAt ?? draft.createdAt ?? nowIso(),
    updatedAt: nowIso(),
  });
  merged.grafanaUrl = normalizeGrafanaUrl(merged.grafanaUrl);
  if (!merged.name.trim()) merged.name = merged.datasourceName || 'Logs';
  await w.store.put(LOGS_COLLECTION, merged);
  return summary(merged);
}

/** A connection that can be queried: an address and a data source. */
function queryable(conn: LogsConnection): LogsConnection {
  if (!conn.grafanaUrl) throw new QuiverError('INVALID_INPUT', `"${conn.name}" has no Grafana address yet`);
  if (!conn.datasourceUid) throw new QuiverError('INVALID_INPUT', `"${conn.name}" has no data source yet; pick one (logs.datasources lists them)`);
  return conn;
}

interface Range {
  fromMs: number;
  toMs: number;
}

function range(from: string, to: string): Range {
  const now = Date.now();
  const fromMs = resolveLogsTime(from, now);
  const toMs = resolveLogsTime(to, now);
  if (fromMs >= toMs) throw new QuiverError('INVALID_INPUT', `The range ends before it starts (${new Date(fromMs).toISOString()} to ${new Date(toMs).toISOString()})`);
  return { fromMs, toMs };
}

interface DsQueryBody {
  results?: Record<string, { error?: string; status?: number; frames?: GrafanaFrame[] }>;
  message?: string;
}

/** One query through Grafana's `/api/ds/query`, the way Explore runs it, so the data source's tenant and auth apply. */
async function dsQuery(host: HostApi, conn: LogsConnection, expr: string, r: Range, extra: Record<string, unknown>): Promise<GrafanaFrame[]> {
  const { status, body } = await sessions.request<DsQueryBody>(host, conn.grafanaUrl, '/api/ds/query', {
    method: 'POST',
    body: {
      from: String(r.fromMs),
      to: String(r.toMs),
      queries: [{ refId: 'A', datasource: { uid: conn.datasourceUid, type: conn.datasourceType }, expr, ...extra }],
    },
  });
  const result = typeof body === 'object' && body ? body.results?.['A'] : undefined;
  if (result?.error) throw new QuiverError('REQUEST_FAILED', cleanGrafanaError(result.error), { query: expr });
  if (status < 200 || status >= 300) {
    const message = typeof body === 'object' && body?.message ? body.message : String(body).slice(0, 300);
    throw new QuiverError('REQUEST_FAILED', `Grafana answered ${status}: ${message}`, { query: expr });
  }
  return result?.frames ?? [];
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
  description: 'Lists the VictoriaLogs connections of this workspace (each a Grafana address and a data source) with what is known about the Grafana sign-in on this machine.',
  scope: 'workspace',
  input: z.object({}),
  handler: async (_input, ctx) => (await listConnections(ws(ctx))).map(summary),
});

const connectionGet = defineCommand({
  id: 'logs.connection.get',
  title: 'Get logs connection',
  description: 'Returns one logs connection with its sign-in state.',
  scope: 'workspace',
  input: ConnectionIdInput,
  handler: async ({ id }, ctx) => summary(await getConnection(ws(ctx), id)),
});

const connectionSave = defineCommand({
  id: 'logs.connection.save',
  title: 'Save logs connection',
  description:
    'Creates or updates a logs connection; omit id to create. `grafanaUrl` is the Grafana that holds the VictoriaLogs data source, `datasourceUid` and `datasourceName` pick it (logs.datasources lists them once signed in). Only the fields given are changed.',
  scope: 'workspace',
  input: z.object({ connection: LogsConnectionDraftSchema }),
  handler: async ({ connection }, ctx) => saveConnection(ws(ctx), connection),
});

const connectionDelete = defineCommand({
  id: 'logs.connection.delete',
  title: 'Delete logs connection',
  description: 'Deletes a logs connection. The Grafana sign-in on this machine stays for other connections to the same address.',
  scope: 'workspace',
  mutating: true,
  input: ConnectionIdInput,
  handler: async ({ id }, ctx) => ({ deleted: await ws(ctx).store.remove(LOGS_COLLECTION, id) }),
});

// ---------- sign-in ----------

const session = defineCommand({
  id: 'logs.session',
  title: 'Check Grafana sign-in',
  description: "Asks Grafana whether this machine is signed in for the connection's address, and as whom. Agents cannot sign in; when `state` is signed-out, ask the user to sign in from Quiver's Logs view.",
  scope: 'workspace',
  input: ConnectionIdInput,
  handler: async ({ id }, ctx) => sessions.check(ctx.host, (await getConnection(ws(ctx), id)).grafanaUrl),
});

const signIn = defineCommand({
  id: 'logs.signin',
  title: 'Sign in to Grafana',
  description: "Opens Grafana's login page in a window and resolves once the user is signed in or closes it.",
  scope: 'workspace',
  // A window on the user's screen that only the user can complete: the UI's to open, not an agent's.
  hidden: true,
  input: ConnectionIdInput,
  handler: async ({ id }, ctx) => sessions.signIn(ctx.host, (await getConnection(ws(ctx), id)).grafanaUrl),
});

const signOut = defineCommand({
  id: 'logs.signout',
  title: 'Sign out of Grafana',
  description: "Ends the Grafana session for the connection's address and forgets it on this machine, for every connection to that address.",
  scope: 'workspace',
  mutating: true,
  input: ConnectionIdInput,
  handler: async ({ id }, ctx) => sessions.signOut(ctx.host, (await getConnection(ws(ctx), id)).grafanaUrl),
});

const datasources = defineCommand({
  id: 'logs.datasources',
  title: 'List VictoriaLogs data sources',
  description: "The VictoriaLogs data sources the signed-in user can query in the connection's Grafana.",
  scope: 'workspace',
  input: ConnectionIdInput,
  handler: async ({ id }, ctx): Promise<LogsDatasource[]> => {
    const conn = await getConnection(ws(ctx), id);
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
    'Runs LogsQL against the connection\'s VictoriaLogs data source through Grafana and returns the entries newest first: time, message, level and the other fields. `filters` are exact matches ANDed in front of the query. Narrow wide results with pipes, e.g. `| fields _time, _msg, level` or `| stats by (app) count()`; pipe results come back as entries whose fields are the columns.',
  scope: 'workspace',
  input: QueryInput.extend({ limit: z.number().int().min(1).max(5000).default(100) }),
  handler: async (input, ctx): Promise<LogsQueryResult> => {
    const conn = queryable(await getConnection(ws(ctx), input.id));
    const r = range(input.from, input.to);
    const expr = composeLogsQuery(input.query, input.filters);
    const started = Date.now();
    const entry: LogsHistoryEntry = { id: newId(), connectionId: conn.id, query: input.query, filters: input.filters, range: `${input.from}..${input.to}`, at: nowIso(), count: null, error: null };
    try {
      const entries = parseLogFrames(await dsQuery(ctx.host, conn, expr, r, { queryType: 'instant', maxLines: input.limit })).slice(0, input.limit);
      await record(ctx, { ...entry, count: entries.length });
      return { entries, query: expr, from: new Date(r.fromMs).toISOString(), to: new Date(r.toMs).toISOString(), limited: entries.length >= input.limit, tookMs: Date.now() - started };
    } catch (err) {
      if (!(err instanceof QuiverError && err.code === 'SIGN_IN_REQUIRED')) await record(ctx, { ...entry, error: (err as Error).message });
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
    const frames = await dsQuery(ctx.host, conn, composeLogsQuery(input.query, input.filters, { pipes: false }), r, { queryType: 'hits', step: `${stepMs / 1000}s`, intervalMs: stepMs });
    return { ...parseHitsFrames(frames), stepMs, from: new Date(r.fromMs).toISOString(), to: new Date(r.toMs).toISOString() };
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
    const expr = `${composeLogsQuery(input.query, input.filters, { pipes: false })} | field_names`;
    const rows = parseLogFrames(await dsQuery(ctx.host, conn, expr, range(input.from, input.to), { queryType: 'instant', maxLines: 1000 }));
    return rows
      .map((row) => ({ name: row.fields['name'] ?? '', hits: Number(row.fields['hits'] ?? 0) }))
      .filter((f) => f.name && !INTERNAL_FIELDS.has(f.name))
      .sort((a, b) => b.hits - a.hits || a.name.localeCompare(b.name));
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
    const name = logsFieldName(input.field);
    const expr = `${composeLogsQuery(input.query, input.filters, { pipes: false })} | stats by (${name}) count() hits | sort by (hits desc) | limit ${input.limit}`;
    const rows = parseLogFrames(await dsQuery(ctx.host, conn, expr, range(input.from, input.to), { queryType: 'instant', maxLines: input.limit }));
    return rows
      .map((row) => ({ name: row.fields[input.field] ?? '', hits: Number(row.fields['hits'] ?? 0) }))
      .sort((a, b) => b.hits - a.hits || a.name.localeCompare(b.name));
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
  commands: [connectionList, connectionGet, connectionSave, connectionDelete, session, signIn, signOut, datasources, query, hits, fields, values, historyList, historyClear],
});
