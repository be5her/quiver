import { z } from 'zod';
import { newId, nowIso } from '../ids';
import { resolveTemplate } from '../variables';

export const DbKindSchema = z.enum(['mysql', 'postgres', 'sqlite', 'redis']);
/** The kinds that speak SQL. */
export type SqlKind = 'mysql' | 'postgres' | 'sqlite';
export type DbKind = z.infer<typeof DbKindSchema>;

/**
 * The `store.changed` collection the host announces after a query that can write runs on a
 * connection: its tables, rows or keys may have changed, so views of them reload.
 */
export function dbDataCollection(connectionId: string): string {
  return `db-data:${connectionId}`;
}

export const DB_KIND_LABELS: Record<DbKind, string> = { mysql: 'MySQL', postgres: 'PostgreSQL', sqlite: 'SQLite', redis: 'Redis' };

export function isSqlKind(kind: DbKind): kind is SqlKind {
  return kind !== 'redis';
}

export function defaultPort(kind: DbKind): number {
  switch (kind) {
    case 'mysql':
      return 3306;
    case 'postgres':
      return 5432;
    case 'redis':
      return 6379;
    default:
      return 0;
  }
}

/**
 * How the driver reaches the server. `direct` uses host and port as saved. `teleport` starts
 * `tsh proxy db --tunnel` (app-wide, shared by every workspace) and connects to its local port.
 * `command` runs any tunnel command with a `{port}` placeholder, e.g. `ssh -N -L {port}:db:3306 bastion`.
 * `grafana` (Redis only) sends every command through a Grafana Redis data source's CLI mode, with the
 * Grafana session of this machine: nothing is dialled and no credential is stored, so it is committable.
 */
export const DbAccessSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('direct') }),
  z.object({
    type: z.literal('teleport'),
    /** Proxy address of the cluster; empty means tsh's current profile. */
    proxy: z.string().default(''),
    /** Teleport database resource name (see teleport.db.list). */
    database: z.string(),
    /** Database user the tunnel authenticates as. */
    dbUser: z.string(),
  }),
  z.object({
    type: z.literal('command'),
    /** Shell-like command line; `{port}` is replaced by a free local port. Run without a shell. */
    command: z.string(),
  }),
  z.object({
    type: z.literal('grafana'),
    /** The Grafana that holds the data source; may hold {{variables}}. */
    grafanaUrl: z.string().default(''),
    /** The data source's uid, which commands are sent to. */
    datasourceUid: z.string().default(''),
    /** Its name when picked: an admin who reprovisions a data source can change the uid, and the name finds it again. */
    datasourceName: z.string().default(''),
  }),
]);
export type DbAccess = z.infer<typeof DbAccessSchema>;

/** Why a connection's access does not fit its kind, or null. */
export function dbAccessProblem(connection: Pick<DbConnection, 'kind' | 'access' | 'dbIndex'>): string | null {
  if (connection.access.type !== 'grafana') return null;
  if (connection.kind !== 'redis') return `A Grafana data source can only reach Redis, not ${DB_KIND_LABELS[connection.kind]}`;
  if (connection.dbIndex !== 0) return 'Through Grafana the data source address picks the Redis database: leave the database index at 0 (Quiver cannot SELECT on the connections Grafana shares with dashboards)';
  return null;
}

/**
 * One saved connection. Kind-specific fields are all present with defaults so the
 * editor can switch kinds without losing input. The password is never stored here;
 * it lives encrypted in `.quiver/local/db-secrets.json`.
 */
export const DbConnectionSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: DbKindSchema,
  /** MySQL, PostgreSQL and Redis. */
  host: z.string().default('127.0.0.1'),
  /** 0 means the kind's default port. */
  port: z.number().int().min(0).max(65535).default(0),
  /** MySQL or PostgreSQL user, or Redis ACL username. */
  user: z.string().default(''),
  /** MySQL default schema, or the PostgreSQL database to connect to (its schemas are the tree's second level). */
  database: z.string().default(''),
  /** TLS for MySQL, PostgreSQL and Redis. */
  ssl: z.boolean().default(false),
  /** SQLite file, absolute or relative to the workspace folder. */
  file: z.string().default(''),
  /** SQLite: open without write access. */
  readOnly: z.boolean().default(false),
  /** Redis logical database index. */
  dbIndex: z.number().int().min(0).default(0),
  access: DbAccessSchema.default({ type: 'direct' }),
  /** A production system: the UI asks before every write and marks the connection's tabs. Committed, so the whole team gets the guard. */
  production: z.boolean().default(false),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DbConnection = z.infer<typeof DbConnectionSchema>;

export const DbConnectionDraftSchema = DbConnectionSchema.partial({ id: true, createdAt: true, updatedAt: true });
export type DbConnectionDraft = z.infer<typeof DbConnectionDraftSchema>;

/** What the UI and agents see: the connection plus whether a password is stored on this machine. */
export interface DbConnectionSummary extends DbConnection {
  hasPassword: boolean;
}

export const SavedQuerySchema = z.object({
  id: z.string(),
  name: z.string(),
  connectionId: z.string().nullable().default(null),
  database: z.string().nullable().default(null),
  text: z.string().default(''),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SavedQuery = z.infer<typeof SavedQuerySchema>;

export const SavedQueryDraftSchema = SavedQuerySchema.partial({ id: true, createdAt: true, updatedAt: true });

export interface DbColumn {
  name: string;
  type: string;
  nullable: boolean;
  /** PRI, UNI, MUL or null. */
  key: string | null;
  default: string | null;
  extra: string | null;
}

export interface DbIndex {
  name: string;
  unique: boolean;
  columns: string[];
}

export interface DbTable {
  name: string;
  type: 'table' | 'view';
  /** Estimated row count when the engine offers one cheaply. */
  rows: number | null;
  engine: string | null;
}

/** A foreign key: `table.columns` reference `refTable.refColumns`. */
export interface DbForeignKey {
  name: string;
  table: string;
  database: string | null;
  columns: string[];
  refTable: string;
  refDatabase: string | null;
  refColumns: string[];
}

export interface DbTableDetail {
  name: string;
  database: string | null;
  columns: DbColumn[];
  /** The primary key's columns, in key order; empty for views and keyless tables, which the grid keeps read-only. */
  primaryKey: string[];
  indexes: DbIndex[];
  /** Keys of this table pointing at other tables. */
  foreignKeys: DbForeignKey[];
  /** Keys of other tables pointing at this one. */
  referencedBy: DbForeignKey[];
  ddl: string | null;
}

/** Every table of a database with its columns, in one call: completion and schema search. */
export interface DbTableColumns {
  name: string;
  type: 'table' | 'view';
  columns: { name: string; type: string }[];
}

/** One hit of the schema search: a table, or a column of one. */
export interface DbSchemaMatch {
  connectionId: string;
  connectionName: string;
  kind: DbKind;
  database: string | null;
  table: string;
  column: string | null;
  type: string | null;
}

/** A change to one row of a table, as the grid collects them. Keys identify the row by its primary key. */
export const DbTableEditSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('insert'), values: z.record(z.string(), z.unknown()) }),
  z.object({ kind: z.literal('update'), key: z.record(z.string(), z.unknown()), values: z.record(z.string(), z.unknown()) }),
  z.object({ kind: z.literal('delete'), key: z.record(z.string(), z.unknown()) }),
]);
export type DbTableEdit = z.infer<typeof DbTableEditSchema>;

export interface DbTableApplyResult {
  /** The statements, in order. */
  statements: string[];
  /** False for a preview. */
  applied: boolean;
  affectedRows: number;
  durationMs: number;
}

export type DbExportFormat = 'csv' | 'json' | 'markdown' | 'sql';

export interface DbExportResult {
  format: DbExportFormat;
  rows: number;
  /** Set when nothing was written to disk. */
  text: string | null;
  /** The file written, when `path` was given. */
  path: string | null;
  bytes: number;
  truncated: boolean;
}

export interface DbResultColumn {
  name: string;
  type: string | null;
}

/** One statement's outcome. `rows` are arrays in `columns` order to keep large results compact over IPC. */
export interface DbQueryResult {
  statement: string;
  kind: 'rows' | 'affected' | 'value';
  columns: DbResultColumn[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
  affectedRows: number | null;
  insertId: string | null;
  /** Redis replies and other scalar results. */
  value: unknown;
  durationMs: number;
  message: string | null;
}

export interface DbTableRows {
  columns: DbResultColumn[];
  rows: unknown[][];
  total: number | null;
  approximate: boolean;
  limit: number;
  offset: number;
  durationMs: number;
}

export interface DbHistoryEntry {
  id: string;
  at: string;
  connectionId: string;
  connectionName: string;
  database: string | null;
  text: string;
  ok: boolean;
  error: string | null;
  durationMs: number;
  rowCount: number | null;
}

export interface DbConnectionTest {
  ok: true;
  serverVersion: string;
  latencyMs: number;
}

export interface RedisKeyInfo {
  key: string;
  type: string;
  /** Seconds, -1 without expiry, -2 when gone. */
  ttl: number;
}

export interface RedisScanResult {
  cursor: string;
  done: boolean;
  keys: RedisKeyInfo[];
}

export interface RedisKeyDetail {
  key: string;
  type: string;
  ttl: number;
  length: number | null;
  encoding: string | null;
  memory: number | null;
  /** string: text; hash: record; list/set: string[]; zset: [member, score][]; stream: entries. */
  value: unknown;
  truncated: boolean;
}

/** What `INFO` and `DBSIZE` say about a Redis server, for the key browser's strip. */
export interface RedisInfo {
  version: string | null;
  mode: string | null;
  uptimeSeconds: number | null;
  connectedClients: number | null;
  usedMemory: number | null;
  usedMemoryHuman: string | null;
  maxMemoryHuman: string | null;
  keys: number | null;
  opsPerSecond: number | null;
  /** keyspace_hits / (hits + misses), 0..1, null before any lookup. */
  hitRate: number | null;
  role: string | null;
}

/** A query the UI stopped with `db.query.cancel`, or one the server rejected after it was cancelled. */
export const DB_QUERY_CANCELLED = 'QUERY_CANCELLED' as const;

/**
 * `{{name}}` in the fields that name a server or a file, resolved with the variables in effect
 * (API globals, the active environment, the workspace `.env`), so a committed connection can say
 * `{{DB_HOST}}` and every teammate dials their own. Unknown names stay as written.
 */
export function resolveConnectionTemplate(connection: DbConnection, vars: Record<string, string>): DbConnection {
  const r = (s: string) => resolveTemplate(s, vars);
  const access: DbAccess =
    connection.access.type === 'teleport'
      ? { ...connection.access, proxy: r(connection.access.proxy), database: r(connection.access.database), dbUser: r(connection.access.dbUser) }
      : connection.access.type === 'command'
        ? { ...connection.access, command: r(connection.access.command) }
        : connection.access.type === 'grafana'
          ? { ...connection.access, grafanaUrl: r(connection.access.grafanaUrl) }
          : connection.access;
  return { ...connection, host: r(connection.host), user: r(connection.user), database: r(connection.database), file: r(connection.file), access };
}

export function newDbConnection(kind: DbKind, partial: Partial<DbConnection> = {}): DbConnection {
  const ts = nowIso();
  return DbConnectionSchema.parse({
    id: newId(),
    name: partial.name ?? `${DB_KIND_LABELS[kind]} connection`,
    kind,
    createdAt: ts,
    updatedAt: ts,
    ...partial,
  });
}

// ---------- the order connections are listed in ----------

/** How the connections are listed: your manual order, by name, grouped by type, or by last query run here. */
export const DB_CONNECTION_SORTS = ['manual', 'name', 'kind', 'recent'] as const;
export type DbConnectionSort = (typeof DB_CONNECTION_SORTS)[number];
export const DB_CONNECTION_SORT_LABELS: Record<DbConnectionSort, string> = { manual: 'Manual order', name: 'Name', kind: 'Type', recent: 'Recently used' };

/** Workspace state keys (per machine): the manual order, an array of connection ids, and the sort picked in the sidebar. */
export const DB_CONNECTION_ORDER_KEY = 'db.connectionOrder';
export const DB_CONNECTION_SORT_KEY = 'db.connectionSort';

export function isDbConnectionSort(value: unknown): value is DbConnectionSort {
  return typeof value === 'string' && (DB_CONNECTION_SORTS as readonly string[]).includes(value);
}

/** A stored manual order as it is read back: the strings of an array; anything else is no order. */
export function dbConnectionOrderOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
}

type Sortable = Pick<DbConnection, 'id' | 'name' | 'kind'>;

const byName = (a: Sortable, b: Sortable) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) || a.id.localeCompare(b.id);

/** The manual order as a comparator: the ids in `order` first, by their place, then the rest (never placed) by name. */
function manualComparator(order: readonly string[]): (a: Sortable, b: Sortable) => number {
  const at = new Map(order.map((id, i) => [id, i]));
  return (a, b) => {
    const ai = at.get(a.id) ?? Number.POSITIVE_INFINITY;
    const bi = at.get(b.id) ?? Number.POSITIVE_INFINITY;
    if (ai !== bi) return ai < bi ? -1 : 1;
    return byName(a, b);
  };
}

/**
 * The connections in the order `sort` lists them. `order` is the manual order (connection ids, see
 * `DB_CONNECTION_ORDER_KEY`) and `lastUsed` maps an id to the time of its latest query (see `dbConnectionsLastUsed`).
 * `name` is by name alone; `kind` groups by type (by its label) and `recent` puts the latest used first, each keeping
 * the manual order within a group and for connections never used.
 */
export function sortDbConnections<C extends Sortable>(
  connections: readonly C[],
  sort: DbConnectionSort,
  { order = [], lastUsed = {} }: { order?: readonly string[]; lastUsed?: Readonly<Record<string, string>> } = {},
): C[] {
  const manual = manualComparator(order);
  const list = [...connections];
  switch (sort) {
    case 'name':
      return list.sort(byName);
    case 'kind':
      return list.sort((a, b) => DB_KIND_LABELS[a.kind].localeCompare(DB_KIND_LABELS[b.kind]) || manual(a, b));
    case 'recent':
      return list.sort((a, b) => {
        const at = lastUsed[a.id] ?? '';
        const bt = lastUsed[b.id] ?? '';
        if (at !== bt) return at > bt ? -1 : 1;
        return manual(a, b);
      });
    default:
      return list.sort(manual);
  }
}

/** When each connection last ran a query, from the query history (any order): id to the newest `at`. */
export function dbConnectionsLastUsed(history: readonly Pick<DbHistoryEntry, 'connectionId' | 'at'>[]): Record<string, string> {
  const last: Record<string, string> = {};
  for (const entry of history) if (!last[entry.connectionId] || entry.at > last[entry.connectionId]) last[entry.connectionId] = entry.at;
  return last;
}

/**
 * The connection ids, given in their manual order, after moving `id` to index `to` among the others (where a drag
 * drops it, or one step up or down), for `db.connection.reorder`. An unknown id leaves the order as it is.
 */
export function moveDbConnection(ids: readonly string[], id: string, to: number): string[] {
  if (!ids.includes(id)) return [...ids];
  const others = ids.filter((other) => other !== id);
  others.splice(Math.max(0, Math.min(to, others.length)), 0, id);
  return others;
}

/**
 * The manual order after `db.connection.reorder` with `ids`: those first, in that order, then the ones placed before
 * and not named, in the order they had. Ids not among `existing` (deleted connections) are dropped.
 */
export function reorderDbConnections(stored: readonly string[], ids: readonly string[], existing: readonly string[]): string[] {
  const known = new Set(existing);
  const named = [...new Set(ids)].filter((id) => known.has(id));
  return [...named, ...[...new Set(stored)].filter((id) => known.has(id) && !named.includes(id))];
}

export function newSavedQuery(partial: Partial<SavedQuery> = {}): SavedQuery {
  const ts = nowIso();
  return SavedQuerySchema.parse({ id: newId(), name: 'New query', createdAt: ts, updatedAt: ts, ...partial });
}
