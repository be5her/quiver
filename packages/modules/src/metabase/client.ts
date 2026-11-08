import {
  QuiverError,
  datasetError,
  datasetToResult,
  mbqlTableQuery,
  type DbQueryResult,
  type HostApi,
  type MetabaseCard,
  type MetabaseCollection,
  type MetabaseConnection,
  type MetabaseDashboard,
  type MetabaseDatabase,
  type MetabaseDataset,
  type MetabaseExportFormat,
  type MetabaseItem,
  type MetabaseItemModel,
  type MetabaseParameter,
  type MetabaseParameterValue,
  type MetabaseTable,
  type MetabaseTableQuery,
  type MetabaseUser,
  type WorkspaceApi,
} from '@quiver/core';
import { readApiKey } from './secrets';
import { hostOf, metabaseSessions as sessions, metabaseUser, requireBase } from './sessions';

/** Queries and exports may take a while on Metabase's side; who-am-I answers quickly or not at all. */
export const QUERY_TIMEOUT_MS = 60_000;
export const WHOAMI_TIMEOUT_MS = 15_000;

export function isAuthError(err: unknown): boolean {
  return err instanceof QuiverError && ['SIGN_IN_REQUIRED', 'AUTH_REQUIRED', 'AUTH_FAILED'].includes(err.code);
}

export interface MetabaseRequestInit {
  method?: string;
  /** Sent as JSON. */
  json?: unknown;
  /** Sent as `application/x-www-form-urlencoded`, the way Metabase's export endpoints take it. */
  form?: Record<string, string>;
  timeoutMs?: number;
  /** The answer is binary (an xlsx export): kept as bytes rather than decoded as text. */
  binary?: boolean;
}

export interface MetabaseRawResponse {
  status: number;
  contentType: string;
  bytes: Buffer;
}

/** Metabase's own message for a failed answer, as one line. */
function answerMessage(text: string): string {
  try {
    const body = JSON.parse(text) as unknown;
    if (typeof body === 'string' && body.trim()) return body.trim();
    if (body && typeof body === 'object') {
      const b = body as { message?: unknown; errors?: unknown; error?: unknown };
      if (typeof b.message === 'string' && b.message.trim()) return b.message.trim();
      if (typeof b.error === 'string' && b.error.trim()) return b.error.trim();
      if (b.errors && typeof b.errors === 'object') {
        return Object.entries(b.errors as Record<string, unknown>)
          .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
          .join('; ');
      }
    }
  } catch {
    // Not JSON: plain text such as "Not found." or an HTML error page.
  }
  return text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
}

/** One request with Node's fetch, answered as bytes. Network failures and timeouts are REQUEST_FAILED. */
async function nodeFetch(url: string, init: { method: string; headers: Record<string, string>; body?: string; timeoutMs: number }): Promise<MetabaseRawResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs);
  try {
    const res = await fetch(url, { method: init.method, headers: init.headers, body: init.body, signal: controller.signal });
    return { status: res.status, contentType: res.headers.get('content-type') ?? '', bytes: Buffer.from(await res.arrayBuffer()) };
  } catch (err) {
    const host = new URL(url).host;
    if (controller.signal.aborted) throw new QuiverError('REQUEST_FAILED', `Metabase at ${host} did not answer within ${Math.round(init.timeoutMs / 1000)} s`);
    throw new QuiverError('REQUEST_FAILED', `Metabase at ${host} did not answer: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A request to the connection's Metabase, with its API key or its browser session, answered as bytes on
 * success. Without credentials it fails with SIGN_IN_REQUIRED, AUTH_REQUIRED or AUTH_FAILED; 404 is
 * NOT_FOUND; any other failure is REQUEST_FAILED with Metabase's message.
 */
export async function metabaseRaw(host: HostApi, ws: WorkspaceApi, conn: MetabaseConnection, path: string, init: MetabaseRequestInit = {}): Promise<MetabaseRawResponse> {
  const base = requireBase(conn.url);
  const method = init.method ?? (init.json !== undefined || init.form ? 'POST' : 'GET');
  const timeoutMs = init.timeoutMs ?? QUERY_TIMEOUT_MS;
  const body = init.form ? new URLSearchParams(init.form).toString() : init.json !== undefined ? JSON.stringify(init.json) : undefined;
  const contentType = init.form ? 'application/x-www-form-urlencoded' : init.json !== undefined ? 'application/json' : undefined;
  const headers: Record<string, string> = { Accept: 'application/json', ...(contentType ? { 'Content-Type': contentType } : {}) };

  let res: MetabaseRawResponse;
  if (conn.auth === 'apikey') {
    const apiKey = await readApiKey(ws, host, conn.id);
    if (!apiKey) throw new QuiverError('AUTH_REQUIRED', `"${conn.name}" has no API key on this machine. Ask the user to add one in the connection's tab in Quiver's Metabase view.`, { connectionId: conn.id });
    res = await nodeFetch(`${base}${path}`, { method, headers: { ...headers, 'x-api-key': apiKey }, body, timeoutMs });
    if (res.status === 401 || res.status === 403) {
      throw new QuiverError('AUTH_FAILED', `Metabase at ${hostOf(base)} refused the API key of "${conn.name}" (${res.status}): ${answerMessage(res.bytes.toString('utf8')) || 'revoked or mistyped'}`, { connectionId: conn.id });
    }
  } else {
    const web = await sessions.fetch(host, base, path, { method, body, contentType, timeoutMs, binary: init.binary, connectionId: conn.id });
    res = { status: web.status, contentType: web.headers['content-type'] ?? '', bytes: web.bytes ? Buffer.from(web.bytes) : Buffer.from(web.text, 'utf8') };
  }

  if (res.status >= 200 && res.status < 300) return res;
  const message = answerMessage(res.bytes.toString('utf8'));
  if (res.status === 404) throw new QuiverError('NOT_FOUND', `Metabase at ${hostOf(base)} has no ${path.split('?')[0]}${message ? `: ${message}` : ''}`);
  throw new QuiverError('REQUEST_FAILED', `Metabase answered ${res.status}${message ? `: ${message}` : ''}`, { status: res.status });
}

/** A request answered with JSON. */
export async function metabaseRequest<T = unknown>(host: HostApi, ws: WorkspaceApi, conn: MetabaseConnection, path: string, init: MetabaseRequestInit = {}): Promise<T> {
  const res = await metabaseRaw(host, ws, conn, path, init);
  const text = res.bytes.toString('utf8');
  if (!text.trim()) return null as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new QuiverError('REQUEST_FAILED', `Metabase at ${hostOf(requireBase(conn.url))} answered ${path.split('?')[0]} with something other than JSON; is the address Metabase's?`);
  }
}

// ---------- typed reads ----------

type Json = Record<string, unknown>;

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function strOrNull(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function idOrNull(value: unknown): string | null {
  return value === null || value === undefined || value === '' ? null : String(value);
}

/** Metabase lists either as `{ data: [...] }` or, on older versions, as a bare array. */
function listOf(body: unknown): Json[] {
  const list = Array.isArray(body) ? body : body && typeof body === 'object' && Array.isArray((body as { data?: unknown }).data) ? (body as { data: unknown[] }).data : [];
  return list.filter((x): x is Json => Boolean(x) && typeof x === 'object');
}

export async function currentUser(host: HostApi, ws: WorkspaceApi, conn: MetabaseConnection): Promise<MetabaseUser> {
  const user = metabaseUser(await metabaseRequest(host, ws, conn, '/api/user/current', { timeoutMs: WHOAMI_TIMEOUT_MS }));
  if (!user) throw new QuiverError('REQUEST_FAILED', `Metabase at ${hostOf(requireBase(conn.url))} did not say who the connection is`);
  return user;
}

/** Metabase's version tag, e.g. `v0.52.3`; null when it does not say. */
export async function serverVersion(host: HostApi, ws: WorkspaceApi, conn: MetabaseConnection): Promise<string | null> {
  try {
    const props = await metabaseRequest<{ version?: { tag?: unknown } }>(host, ws, conn, '/api/session/properties', { timeoutMs: WHOAMI_TIMEOUT_MS });
    return strOrNull(props?.version?.tag);
  } catch {
    return null;
  }
}

export async function listDatabases(host: HostApi, ws: WorkspaceApi, conn: MetabaseConnection): Promise<MetabaseDatabase[]> {
  return listOf(await metabaseRequest(host, ws, conn, '/api/database'))
    .filter((d) => typeof d['id'] === 'number')
    .map((d) => ({ id: d['id'] as number, name: str(d['name']), engine: str(d['engine']) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function listTables(host: HostApi, ws: WorkspaceApi, conn: MetabaseConnection, databaseId: number): Promise<MetabaseTable[]> {
  const body = await metabaseRequest<{ tables?: unknown }>(host, ws, conn, `/api/database/${databaseId}/metadata`);
  const tables = Array.isArray(body?.tables) ? (body.tables as Json[]) : [];
  return tables
    .filter((t) => t && typeof t['id'] === 'number')
    .map((t) => ({
      id: t['id'] as number,
      name: str(t['name']),
      displayName: str(t['display_name']) || str(t['name']),
      schema: strOrNull(t['schema']),
      fields: (Array.isArray(t['fields']) ? (t['fields'] as Json[]) : [])
        .filter((f) => f && typeof f['id'] === 'number')
        .map((f) => ({ id: f['id'] as number, name: str(f['name']), displayName: str(f['display_name']) || str(f['name']), baseType: str(f['base_type']), databaseType: strOrNull(f['database_type']) })),
    }))
    .sort((a, b) => (a.schema ?? '').localeCompare(b.schema ?? '') || a.name.localeCompare(b.name));
}

function collectionNode(node: Json): MetabaseCollection {
  const children = Array.isArray(node['children']) ? (node['children'] as Json[]) : [];
  return {
    id: String(node['id']),
    name: str(node['name']),
    children: children.filter((c) => c && c['id'] !== undefined && !c['archived']).map(collectionNode),
  };
}

/** The collection tree under the root, "Our analytics". */
export async function collectionTree(host: HostApi, ws: WorkspaceApi, conn: MetabaseConnection): Promise<MetabaseCollection> {
  const nodes = listOf(await metabaseRequest(host, ws, conn, '/api/collection/tree'));
  return { id: 'root', name: 'Our analytics', children: nodes.filter((c) => c['id'] !== undefined && !c['archived']).map(collectionNode) };
}

const ITEM_MODELS: MetabaseItemModel[] = ['card', 'dashboard', 'collection'];

function item(raw: Json, collectionId: string | null): MetabaseItem | null {
  const model = raw['model'] as MetabaseItemModel;
  if (typeof raw['id'] !== 'number' || !ITEM_MODELS.includes(model)) return null;
  return { id: raw['id'], model, name: str(raw['name']), description: strOrNull(raw['description']), collectionId };
}

export async function collectionItems(host: HostApi, ws: WorkspaceApi, conn: MetabaseConnection, collectionId: string): Promise<MetabaseItem[]> {
  const body = await metabaseRequest(host, ws, conn, `/api/collection/${encodeURIComponent(collectionId)}/items?models=card&models=dashboard&models=collection`);
  return listOf(body)
    .map((raw) => item(raw, collectionId))
    .filter((i): i is MetabaseItem => i !== null);
}

export async function search(host: HostApi, ws: WorkspaceApi, conn: MetabaseConnection, q: string): Promise<MetabaseItem[]> {
  const body = await metabaseRequest(host, ws, conn, `/api/search?q=${encodeURIComponent(q)}&models=card&models=dashboard`);
  return listOf(body)
    .map((raw) => {
      const collection = raw['collection'] as Json | null | undefined;
      return item(raw, idOrNull(collection?.['id'] ?? raw['collection_id']));
    })
    .filter((i): i is MetabaseItem => i !== null);
}

/** Parameter types for template tags, for questions saved before Metabase listed `parameters` on the card. */
const TAG_TYPES: Record<string, string> = { text: 'category', number: 'number/=', date: 'date/single' };

function parametersOf(card: Json, native: Json | undefined): MetabaseParameter[] {
  const listed = Array.isArray(card['parameters']) ? (card['parameters'] as Json[]) : [];
  if (listed.length) {
    return listed
      .filter((p) => p && typeof p['id'] === 'string')
      .map((p) => ({ id: p['id'] as string, name: str(p['name']), slug: str(p['slug']), type: str(p['type']), target: p['target'] ?? null, default: p['default'] ?? null }));
  }
  const tags = native?.['template-tags'];
  if (!tags || typeof tags !== 'object') return [];
  return Object.values(tags as Record<string, Json>)
    .filter((t) => t && typeof t['id'] === 'string' && (t['type'] === 'dimension' || TAG_TYPES[str(t['type'])]))
    .map((t) => ({
      id: t['id'] as string,
      name: str(t['display-name']) || str(t['name']),
      slug: str(t['name']),
      type: t['type'] === 'dimension' ? str(t['widget-type']) || 'category' : TAG_TYPES[str(t['type'])]!,
      target: [t['type'] === 'dimension' ? 'dimension' : 'variable', ['template-tag', str(t['name'])]],
      default: t['default'] ?? null,
    }));
}

export async function getCard(host: HostApi, ws: WorkspaceApi, conn: MetabaseConnection, cardId: number): Promise<MetabaseCard> {
  const card = await metabaseRequest<Json>(host, ws, conn, `/api/card/${cardId}`);
  if (!card || typeof card !== 'object') throw new QuiverError('NOT_FOUND', `Metabase has no question ${cardId}`);
  const query = (card['dataset_query'] ?? {}) as Json;
  // The legacy shape keeps `native` at the top; the newer one (pMBQL) keeps it in the first stage.
  const stage = Array.isArray(query['stages']) ? ((query['stages'] as Json[])[0] ?? undefined) : undefined;
  const legacyNative = query['native'] as Json | undefined;
  const isNative = query['type'] === 'native' || stage?.['lib/type'] === 'mbql.stage/native';
  const isMbql = query['type'] === 'query' || stage?.['lib/type'] === 'mbql.stage/mbql';
  const sql = legacyNative ? str(legacyNative['query']) : stage && isNative ? str(stage['native']) : '';
  const databaseId = typeof card['database_id'] === 'number' ? card['database_id'] : typeof query['database'] === 'number' ? query['database'] : null;
  return {
    id: cardId,
    name: str(card['name']),
    description: strOrNull(card['description']),
    databaseId,
    queryType: isNative ? 'native' : isMbql ? 'query' : null,
    sql: isNative ? sql || null : null,
    display: str(card['display']) || 'table',
    parameters: parametersOf(card, legacyNative ?? stage),
    collectionId: idOrNull(card['collection_id']),
  };
}

/** The values for a run as Metabase takes them, with each parameter's type and target from the card. */
export function cardParameters(card: MetabaseCard, values: MetabaseParameterValue[]): { id: string; type: string; target: unknown; value: unknown }[] {
  return values.map(({ id, value }) => {
    const param = card.parameters.find((p) => p.id === id);
    if (!param) {
      const known = card.parameters.map((p) => `${p.id} (${p.slug || p.name})`).join(', ') || 'none';
      throw new QuiverError('INVALID_INPUT', `Question ${card.id} has no parameter "${id}"; its parameters are: ${known}`);
    }
    return { id, type: param.type, target: param.target, value };
  });
}

export async function getDashboard(host: HostApi, ws: WorkspaceApi, conn: MetabaseConnection, dashboardId: number): Promise<MetabaseDashboard> {
  const dash = await metabaseRequest<Json>(host, ws, conn, `/api/dashboard/${dashboardId}`);
  if (!dash || typeof dash !== 'object') throw new QuiverError('NOT_FOUND', `Metabase has no dashboard ${dashboardId}`);
  const dashcards = (Array.isArray(dash['dashcards']) ? dash['dashcards'] : Array.isArray(dash['ordered_cards']) ? dash['ordered_cards'] : []) as Json[];
  const ordered = [...dashcards].sort((a, b) => Number(a['row'] ?? 0) - Number(b['row'] ?? 0) || Number(a['col'] ?? 0) - Number(b['col'] ?? 0));
  const cards: { id: number; name: string }[] = [];
  for (const dc of ordered) {
    const card = dc?.['card'] as Json | null | undefined;
    // Text and heading cards carry no question.
    if (!card || typeof card['id'] !== 'number' || cards.some((c) => c.id === card['id'])) continue;
    cards.push({ id: card['id'], name: str(card['name']) });
  }
  return { id: dashboardId, name: str(dash['name']), description: strOrNull(dash['description']), cards };
}

// ---------- datasets ----------

/** A dataset answer as one rows result; a failed one is REQUEST_FAILED with Metabase's message. */
function datasetResult(dataset: MetabaseDataset | null, statement: string, sql: string | null): DbQueryResult {
  if (!dataset || typeof dataset !== 'object') throw new QuiverError('REQUEST_FAILED', 'Metabase answered without a result');
  const error = datasetError(dataset);
  if (error) throw new QuiverError('REQUEST_FAILED', error, sql ? { sql } : undefined);
  return datasetToResult(dataset, statement);
}

export function nativeQuery(databaseId: number, sql: string): Json {
  return { database: databaseId, type: 'native', native: { query: sql, 'template-tags': {} } };
}

export async function runNative(host: HostApi, ws: WorkspaceApi, conn: MetabaseConnection, databaseId: number, sql: string): Promise<DbQueryResult> {
  const dataset = await metabaseRequest<MetabaseDataset>(host, ws, conn, '/api/dataset', { json: nativeQuery(databaseId, sql), timeoutMs: QUERY_TIMEOUT_MS });
  return datasetResult(dataset, sql, sql);
}

export async function runCard(host: HostApi, ws: WorkspaceApi, conn: MetabaseConnection, card: MetabaseCard, values: MetabaseParameterValue[]): Promise<DbQueryResult> {
  const parameters = cardParameters(card, values);
  const dataset = await metabaseRequest<MetabaseDataset>(host, ws, conn, `/api/card/${card.id}/query`, { json: { parameters }, timeoutMs: QUERY_TIMEOUT_MS });
  return datasetResult(dataset, card.sql ?? card.name, card.sql);
}

/**
 * A page of a table through the query builder (MBQL), so it runs with the user's query-builder
 * permission where native SQL is refused. The statement names the table (or its id) and the page.
 */
export async function runTableQuery(host: HostApi, ws: WorkspaceApi, conn: MetabaseConnection, q: MetabaseTableQuery, tableName?: string): Promise<DbQueryResult> {
  const dataset = await metabaseRequest<MetabaseDataset>(host, ws, conn, '/api/dataset', { json: mbqlTableQuery(q), timeoutMs: QUERY_TIMEOUT_MS });
  return datasetResult(dataset, `${tableName || `table ${q.tableId}`} page ${q.page}`, null);
}

export type MetabaseExportSource = { card: MetabaseCard; values: MetabaseParameterValue[] } | { databaseId: number; sql: string } | { table: MetabaseTableQuery };

/** Every row of a question, a native query or a table (through its filters), formatted by Metabase's own export endpoint. */
export async function exportRows(host: HostApi, ws: WorkspaceApi, conn: MetabaseConnection, format: MetabaseExportFormat, source: MetabaseExportSource): Promise<Buffer> {
  const path = 'card' in source ? `/api/card/${source.card.id}/query/${format}` : `/api/dataset/${format}`;
  const form: Record<string, string> =
    'card' in source
      ? { parameters: JSON.stringify(cardParameters(source.card, source.values)), format_rows: 'true' }
      : 'table' in source
        ? { query: JSON.stringify(mbqlTableQuery(source.table)), format_rows: 'true' }
        : { query: JSON.stringify(nativeQuery(source.databaseId, source.sql)), format_rows: 'true' };
  const res = await metabaseRaw(host, ws, conn, path, { form, timeoutMs: QUERY_TIMEOUT_MS, binary: format === 'xlsx' });
  // Metabase answers a query that fails during an export with its dataset error as JSON, still 2xx.
  // A JSON export of rows is an array; an object is that error.
  const head = res.bytes.subarray(0, 64).toString('utf8').trimStart();
  if (res.contentType.includes('application/json') && head.startsWith('{')) {
    try {
      const error = datasetError(JSON.parse(res.bytes.toString('utf8')) as MetabaseDataset);
      if (error) throw new QuiverError('REQUEST_FAILED', error, 'sql' in source ? { sql: source.sql } : undefined);
    } catch (err) {
      if (err instanceof QuiverError) throw err;
    }
  }
  return res.bytes;
}
