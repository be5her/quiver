import { z } from 'zod';
import { newId, nowIso } from '../ids';

export const DbKindSchema = z.enum(['mysql', 'sqlite', 'redis']);
export type DbKind = z.infer<typeof DbKindSchema>;

export const DB_KIND_LABELS: Record<DbKind, string> = { mysql: 'MySQL', sqlite: 'SQLite', redis: 'Redis' };

export function defaultPort(kind: DbKind): number {
  switch (kind) {
    case 'mysql':
      return 3306;
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
]);
export type DbAccess = z.infer<typeof DbAccessSchema>;

/**
 * One saved connection. Kind-specific fields are all present with defaults so the
 * editor can switch kinds without losing input. The password is never stored here;
 * it lives encrypted in `.quiver/local/db-secrets.json`.
 */
export const DbConnectionSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: DbKindSchema,
  /** MySQL and Redis. */
  host: z.string().default('127.0.0.1'),
  /** 0 means the kind's default port. */
  port: z.number().int().min(0).max(65535).default(0),
  /** MySQL user or Redis ACL username. */
  user: z.string().default(''),
  /** MySQL default schema. */
  database: z.string().default(''),
  /** TLS for MySQL and Redis. */
  ssl: z.boolean().default(false),
  /** SQLite file, absolute or relative to the workspace folder. */
  file: z.string().default(''),
  /** SQLite: open without write access. */
  readOnly: z.boolean().default(false),
  /** Redis logical database index. */
  dbIndex: z.number().int().min(0).default(0),
  access: DbAccessSchema.default({ type: 'direct' }),
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

export interface DbTableDetail {
  name: string;
  database: string | null;
  columns: DbColumn[];
  indexes: DbIndex[];
  ddl: string | null;
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

export function newSavedQuery(partial: Partial<SavedQuery> = {}): SavedQuery {
  const ts = nowIso();
  return SavedQuerySchema.parse({ id: newId(), name: 'New query', createdAt: ts, updatedAt: ts, ...partial });
}
