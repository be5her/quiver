import type { DbKind, DbQueryResult, DbTable, DbTableColumns, DbTableDetail, DbTableRows, RedisInfo, RedisKeyDetail, RedisScanResult } from '@quiver/core';

export interface RunOptions {
  /** MySQL: schema to `USE` before running. PostgreSQL: schema put first on `search_path`. SQLite: attached database name for schema queries. */
  database?: string | null;
  /** Rows kept per result set; extra rows flag `truncated`. */
  maxRows: number;
}

export interface TableRowsOptions {
  database?: string | null;
  limit: number;
  offset: number;
  orderBy?: string | null;
  direction?: 'asc' | 'desc';
  /** Raw SQL appended after WHERE. */
  where?: string | null;
}

/** What every database kind implements. SQL-only methods throw INVALID_INPUT on Redis. */
export interface Driver {
  readonly kind: DbKind;
  connect(): Promise<void>;
  close(): Promise<void>;
  isAlive(): boolean;
  ping(): Promise<{ serverVersion: string }>;
  databases(): Promise<string[]>;
  tables(database?: string | null): Promise<DbTable[]>;
  table(name: string, database?: string | null): Promise<DbTableDetail>;
  /** Every table of the database with its columns, in one round trip. */
  columns(database?: string | null): Promise<DbTableColumns[]>;
  run(query: string, options: RunOptions): Promise<DbQueryResult[]>;
  tableRows(name: string, options: TableRowsOptions): Promise<DbTableRows>;
  /**
   * Stop the statement running right now, from a second connection to the same server. Resolves
   * true when a cancel was sent. Absent when the engine cannot be interrupted (SQLite, Redis).
   */
  cancel?(): Promise<boolean>;
}

export interface RedisDriverApi extends Driver {
  scanKeys(pattern: string, cursor: string, count: number): Promise<RedisScanResult>;
  keyDetail(key: string, limit: number): Promise<RedisKeyDetail>;
  info(): Promise<RedisInfo>;
  /** Commands as argument lists; see `run` for the console syntax. */
  exec(commands: string[][]): Promise<DbQueryResult[]>;
}

/** Make driver values safe for JSON over IPC and readable in a grid. */
export function normalizeValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const buf = Buffer.from(value);
    return { $bytes: buf.length, hex: buf.subarray(0, 64).toString('hex') };
  }
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = normalizeValue(v);
    return out;
  }
  return value;
}

export function emptyResult(statement: string, durationMs: number): DbQueryResult {
  return {
    statement,
    kind: 'affected',
    columns: [],
    rows: [],
    rowCount: 0,
    truncated: false,
    affectedRows: null,
    insertId: null,
    value: null,
    durationMs,
    message: null,
  };
}

/** The columns of a table as the completion namespace wants them. */
export function columnsEntry(name: string, type: 'table' | 'view', columns: { name: string; type: string }[]): DbTableColumns {
  return { name, type, columns };
}
