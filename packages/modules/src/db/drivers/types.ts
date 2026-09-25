import type { DbKind, DbQueryResult, DbTable, DbTableDetail, DbTableRows, RedisKeyDetail, RedisScanResult } from '@quiver/core';

export interface RunOptions {
  /** MySQL: schema to `USE` before running. SQLite: attached database name for schema queries. */
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
  run(query: string, options: RunOptions): Promise<DbQueryResult[]>;
  tableRows(name: string, options: TableRowsOptions): Promise<DbTableRows>;
}

export interface RedisDriverApi extends Driver {
  scanKeys(pattern: string, cursor: string, count: number): Promise<RedisScanResult>;
  keyDetail(key: string, limit: number): Promise<RedisKeyDetail>;
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
