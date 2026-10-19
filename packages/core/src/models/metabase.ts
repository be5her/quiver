import { z } from 'zod';
import { newId, nowIso } from '../ids';
import type { DbQueryResult, DbResultColumn } from './db';
import { normalizeServiceUrl } from './logs';

/** How a connection authenticates: an API key kept on this machine, or a sign-in in a Quiver window. */
export const MetabaseAuthSchema = z.enum(['browser', 'apikey']);
export type MetabaseAuth = z.infer<typeof MetabaseAuthSchema>;

/** A Metabase server, saved with the project. The API key and the browser session are per machine. */
export const MetabaseConnectionSchema = z.object({
  id: z.string(),
  name: z.string().default('Metabase'),
  /** Metabase's address, e.g. `https://metabase.example.com`; a sub-path is kept. */
  url: z.string().default(''),
  auth: MetabaseAuthSchema.default('browser'),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type MetabaseConnection = z.infer<typeof MetabaseConnectionSchema>;

/** Every field optional and without defaults, so a partial update only touches what it names. */
export const MetabaseConnectionDraftSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  url: z.string().optional(),
  auth: MetabaseAuthSchema.optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});
export type MetabaseConnectionDraft = z.infer<typeof MetabaseConnectionDraftSchema>;

export type MetabaseSignInState = 'unknown' | 'signed-out' | 'signing-in' | 'signed-in';

export interface MetabaseUser {
  id: number;
  email: string;
  name: string;
}

/** Whether this machine can reach the server as someone: a browser session for `browser`, a working key for `apikey`. */
export interface MetabaseSession {
  state: MetabaseSignInState;
  user: MetabaseUser | null;
  error: string | null;
  checkedAt: string | null;
}

export interface MetabaseConnectionSummary extends MetabaseConnection {
  session: MetabaseSession;
  /** An API key is stored on this machine for this connection; the key itself is never returned. */
  hasApiKey: boolean;
}

/** What `metabase.connection.test` answers. */
export interface MetabaseTestResult {
  user: MetabaseUser;
  /** Metabase's version tag, e.g. `v0.52.3`, when it says. */
  version: string | null;
}

export interface MetabaseDatabase {
  id: number;
  name: string;
  /** Metabase's driver name: `postgres`, `mysql`, `h2`… */
  engine: string;
}

export interface MetabaseField {
  id: number;
  name: string;
  displayName: string;
  /** Metabase's `base_type`, e.g. `type/Integer`. */
  baseType: string;
  /** The column type the database reports, when Metabase knows it. */
  databaseType: string | null;
}

export interface MetabaseTable {
  id: number;
  name: string;
  displayName: string;
  schema: string | null;
  fields: MetabaseField[];
}

/** A node of the collection tree. */
export interface MetabaseCollection {
  /** Metabase's id, or `root` for the top level. */
  id: string;
  name: string;
  children: MetabaseCollection[];
}

export type MetabaseItemModel = 'card' | 'dashboard' | 'collection';

/** One entry of a collection, or a search hit. */
export interface MetabaseItem {
  id: number;
  model: MetabaseItemModel;
  name: string;
  description: string | null;
  /** The collection it is in, when known. */
  collectionId: string | null;
}

/** A parameter a saved question takes. */
export interface MetabaseParameter {
  id: string;
  name: string;
  slug: string;
  /** Metabase's parameter type, e.g. `category`, `number/=`, `date/single`, `string/=`. */
  type: string;
  /** Metabase's target, passed back as is when the parameter is given a value. */
  target: unknown;
  default: unknown;
}

/** A saved question. */
export interface MetabaseCard {
  id: number;
  name: string;
  description: string | null;
  databaseId: number | null;
  /** `native` or `query` (MBQL). */
  queryType: 'native' | 'query' | null;
  /** The SQL of a native question. */
  sql: string | null;
  /** The visualisation Metabase shows it as: `table`, `bar`… */
  display: string;
  parameters: MetabaseParameter[];
  collectionId: string | null;
}

export interface MetabaseDashboard {
  id: number;
  name: string;
  description: string | null;
  /** The questions on it, in order; filters of the dashboard are not applied when they run. */
  cards: { id: number; name: string }[];
}

/** A value for a parameter when running a question. */
export const MetabaseParameterValueSchema = z.object({
  /** The parameter's id as `metabase.card.get` lists it. */
  id: z.string(),
  value: z.unknown(),
});
export type MetabaseParameterValue = z.infer<typeof MetabaseParameterValueSchema>;

export const METABASE_EXPORT_FORMATS = ['csv', 'json', 'xlsx'] as const;
export type MetabaseExportFormat = (typeof METABASE_EXPORT_FORMATS)[number];
export const METABASE_EXPORT_LABELS: Record<MetabaseExportFormat, string> = { csv: 'CSV', json: 'JSON', xlsx: 'Excel' };

/** What `metabase.export` answers: the file written, or the text when no path was given (CSV and JSON only). */
export interface MetabaseExportResult {
  format: MetabaseExportFormat;
  path: string | null;
  text: string | null;
  bytes: number;
}

// ---------- table browsing through the query builder (MBQL) ----------

/**
 * The filters a table view offers, as Metabase's query builder names them. They run with the
 * query-builder permission, which users without native SQL access usually have.
 */
export const METABASE_FILTER_OPS = ['=', '!=', '>', '>=', '<', '<=', 'contains', 'does-not-contain', 'starts-with', 'ends-with', 'is-null', 'not-null', 'is-empty', 'not-empty'] as const;
export type MetabaseFilterOp = (typeof METABASE_FILTER_OPS)[number];
export const METABASE_FILTER_LABELS: Record<MetabaseFilterOp, string> = {
  '=': 'is',
  '!=': 'is not',
  '>': '>',
  '>=': '≥',
  '<': '<',
  '<=': '≤',
  contains: 'contains',
  'does-not-contain': 'does not contain',
  'starts-with': 'starts with',
  'ends-with': 'ends with',
  'is-null': 'is null',
  'not-null': 'is not null',
  'is-empty': 'is empty',
  'not-empty': 'is not empty',
};
/** Operators that take no value. */
export const METABASE_UNARY_OPS: ReadonlySet<MetabaseFilterOp> = new Set(['is-null', 'not-null', 'is-empty', 'not-empty']);

export const MetabaseTableFilterSchema = z.object({
  /** A field id from `metabase.tables`. */
  fieldId: z.number().int(),
  op: z.enum(METABASE_FILTER_OPS),
  /** A string, number or boolean; left out for the operators that take none. Numbers in text are sent as numbers for numeric fields by the UI. */
  value: z.union([z.string(), z.number(), z.boolean()]).optional(),
});
export type MetabaseTableFilter = z.infer<typeof MetabaseTableFilterSchema>;

export const MetabaseTableOrderSchema = z.object({
  fieldId: z.number().int(),
  direction: z.enum(['asc', 'desc']).default('asc'),
});
export type MetabaseTableOrder = z.infer<typeof MetabaseTableOrderSchema>;

/** The rows asked of a table: a page, in an order, through filters. */
export interface MetabaseTableQuery {
  databaseId: number;
  tableId: number;
  /** Rows per page, 1 to 2000. */
  limit: number;
  /** Page number from 1; Metabase pages by `limit` rows. */
  page: number;
  orderBy: MetabaseTableOrder | null;
  filters: MetabaseTableFilter[];
}

/** One MBQL filter clause as `/api/dataset` takes it. */
export function mbqlFilter(filter: MetabaseTableFilter): unknown[] {
  const field = ['field', filter.fieldId, null];
  if (METABASE_UNARY_OPS.has(filter.op)) return [filter.op, field];
  return [filter.op, field, filter.value ?? ''];
}

/**
 * The query-builder (MBQL) dataset query for a table page: `source-table`, the filters ANDed, the
 * order, and `page` for the rows past the first page. Metabase runs it with the user's query-builder
 * permission, so it works where native SQL is not allowed.
 */
export function mbqlTableQuery(q: MetabaseTableQuery): Record<string, unknown> {
  const query: Record<string, unknown> = { 'source-table': q.tableId, limit: q.limit };
  if (q.filters.length === 1) query['filter'] = mbqlFilter(q.filters[0]!);
  else if (q.filters.length > 1) query['filter'] = ['and', ...q.filters.map(mbqlFilter)];
  if (q.orderBy) query['order-by'] = [[q.orderBy.direction, ['field', q.orderBy.fieldId, null]]];
  if (q.page > 1) query['page'] = { page: q.page, items: q.limit };
  return { database: q.databaseId, type: 'query', query };
}

/** One native query run from the editor, recorded per machine. */
export interface MetabaseHistoryEntry {
  id: string;
  connectionId: string;
  databaseId: number;
  sql: string;
  at: string;
  durationMs: number;
  rowCount: number | null;
  error: string | null;
}

export function newMetabaseConnection(partial: Partial<MetabaseConnection> = {}): MetabaseConnection {
  const ts = nowIso();
  return MetabaseConnectionSchema.parse({ id: newId(), createdAt: ts, updatedAt: ts, ...partial });
}

// ---------- address and session ----------

/** `metabase.example.com/` becomes `https://metabase.example.com`; a sub-path stays, query and hash go. Empty when it is no http(s) address. */
export function normalizeMetabaseUrl(raw: string): string {
  return normalizeServiceUrl(raw);
}

/** The browser session a Metabase address signs in to: one per origin, shared by every connection and workspace on this machine. */
export function metabasePartition(url: string): string {
  const origin = new URL(normalizeMetabaseUrl(url)).origin.toLowerCase();
  return `persist:quiver-metabase-${origin.replace(/[^a-z0-9]+/g, '-')}`;
}

/** Host and auth mode, for lists. */
export function describeMetabaseConnection(conn: Pick<MetabaseConnection, 'url' | 'auth'>): string {
  const host = conn.url.replace(/^[a-z]+:\/\//i, '').split(/[/?#]/)[0] ?? '';
  return [host, conn.auth === 'apikey' ? 'API key' : 'browser sign-in'].filter(Boolean).join(' · ');
}

// ---------- query results ----------

/** The part of Metabase's dataset answer (`/api/dataset`, `/api/card/:id/query`) that is read. */
export interface MetabaseDataset {
  status?: string;
  error?: unknown;
  error_type?: string;
  row_count?: number;
  running_time?: number;
  data?: {
    cols?: { name?: string; display_name?: string; base_type?: string }[];
    rows?: unknown[][];
    rows_truncated?: number;
  };
}

/** Metabase's error for a failed dataset, as one line. */
export function datasetError(dataset: MetabaseDataset): string | null {
  if (dataset.status === 'failed' || dataset.error !== undefined) {
    const error = dataset.error;
    if (typeof error === 'string' && error.trim()) return error.trim();
    if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') return (error as { message: string }).message;
    return 'Metabase could not run the query';
  }
  return null;
}

/**
 * A dataset as one rows result: the columns named as Metabase shows them (`display_name`, else `name`) with
 * their base type, the rows as they came. `truncated` when Metabase cut the rows (`rows_truncated`).
 * Throws nothing: check `datasetError` first.
 */
export function datasetToResult(dataset: MetabaseDataset, statement: string): DbQueryResult {
  const data = dataset.data ?? {};
  const columns: DbResultColumn[] = (data.cols ?? []).map((c) => ({ name: c.display_name || c.name || '', type: c.base_type ?? null }));
  const rows = data.rows ?? [];
  return {
    statement,
    kind: 'rows',
    columns,
    rows,
    rowCount: dataset.row_count ?? rows.length,
    truncated: typeof data.rows_truncated === 'number' && data.rows_truncated > 0,
    affectedRows: null,
    insertId: null,
    value: undefined,
    durationMs: dataset.running_time ?? 0,
    message: null,
  };
}
