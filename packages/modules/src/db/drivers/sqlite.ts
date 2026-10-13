import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { QuiverError, qualifiedName, quoteIdentifier, splitStatements, type DbColumn, type DbConnection, type DbForeignKey, type DbIndex, type DbQueryResult, type DbTable, type DbTableColumns, type DbTableDetail, type DbTableRows } from '@quiver/core';
import { columnsEntry, emptyResult, normalizeValue, type Driver, type RunOptions, type TableRowsOptions } from './types';

interface ColumnMeta {
  name: string;
  type: string | null;
}

/**
 * SQLite through Node's built-in `node:sqlite`, so there is nothing to compile per platform.
 * Calls are synchronous inside the main process; fine for local files, keep queries sane.
 */
export class SqliteDriver implements Driver {
  readonly kind = 'sqlite' as const;
  private db: DatabaseSync | null = null;
  readonly file: string;

  constructor(
    private readonly config: DbConnection,
    workspacePath: string,
  ) {
    const file = config.file.trim();
    if (!file) throw new QuiverError('INVALID_INPUT', 'SQLite connection needs a file path');
    this.file = file === ':memory:' ? file : path.isAbsolute(file) ? file : path.resolve(workspacePath, file);
  }

  async connect(): Promise<void> {
    // SQLite creates the file but not its folder; do that for relative project paths like data/app.db.
    if (this.file !== ':memory:' && !this.config.readOnly) await fs.mkdir(path.dirname(this.file), { recursive: true }).catch(() => {});
    try {
      this.db = new DatabaseSync(this.file, { readOnly: this.config.readOnly });
    } catch (err) {
      throw wrapError(err);
    }
  }

  async close(): Promise<void> {
    const db = this.db;
    this.db = null;
    try {
      db?.close();
    } catch {
      // already closed
    }
  }

  isAlive(): boolean {
    return this.db !== null;
  }

  private d(): DatabaseSync {
    if (!this.db) throw new QuiverError('REQUEST_FAILED', 'SQLite database is closed');
    return this.db;
  }

  private prepare(sql: string): StatementSync {
    try {
      return this.d().prepare(sql);
    } catch (err) {
      throw wrapError(err);
    }
  }

  private all(sql: string, ...params: (string | number)[]): Record<string, unknown>[] {
    try {
      return this.prepare(sql).all(...params) as Record<string, unknown>[];
    } catch (err) {
      throw wrapError(err);
    }
  }

  async ping(): Promise<{ serverVersion: string }> {
    const row = this.all('SELECT sqlite_version() AS v')[0];
    return { serverVersion: `SQLite ${String(row?.v ?? '')}`.trim() };
  }

  async databases(): Promise<string[]> {
    return this.all('PRAGMA database_list').map((r) => String(r.name));
  }

  async tables(database?: string | null): Promise<DbTable[]> {
    const master = database && database !== 'main' ? `${quoteIdentifier('sqlite', database)}.sqlite_master` : 'sqlite_master';
    return this.all(`SELECT name, type FROM ${master} WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name`).map((r) => ({
      name: String(r.name),
      type: r.type === 'view' ? 'view' : 'table',
      rows: null,
      engine: null,
    }));
  }

  async table(name: string, database?: string | null): Promise<DbTableDetail> {
    const schema = database && database !== 'main' ? `${quoteIdentifier('sqlite', database)}.` : '';
    const info = this.all(`PRAGMA ${schema}table_info(${quoteIdentifier('sqlite', name)})`);
    if (!info.length) throw new QuiverError('NOT_FOUND', `Table ${name} not found`);
    const columns: DbColumn[] = info.map((r) => ({
      name: String(r.name),
      type: String(r.type ?? ''),
      nullable: Number(r.notnull) === 0,
      key: Number(r.pk) > 0 ? 'PRI' : null,
      default: r.dflt_value === null || r.dflt_value === undefined ? null : String(r.dflt_value),
      extra: null,
    }));
    const indexes: DbIndex[] = this.all(`PRAGMA ${schema}index_list(${quoteIdentifier('sqlite', name)})`).map((idx) => ({
      name: String(idx.name),
      unique: Number(idx.unique) === 1,
      columns: this.all(`PRAGMA ${schema}index_info(${quoteIdentifier('sqlite', String(idx.name))})`).map((c) => String(c.name)),
    }));
    const master = schema ? `${schema}sqlite_master` : 'sqlite_master';
    const ddl = this.all(`SELECT sql FROM ${master} WHERE name = ?`, name)[0]?.sql;
    const primaryKey = info
      .filter((r) => Number(r.pk) > 0)
      .sort((a, b) => Number(a.pk) - Number(b.pk))
      .map((r) => String(r.name));
    const dbName = database ?? 'main';
    const foreignKeys = this.foreignKeysOf(name, schema, dbName);
    const referencedBy: DbForeignKey[] = [];
    for (const other of await this.tables(database)) {
      if (other.type !== 'table') continue;
      referencedBy.push(...this.foreignKeysOf(other.name, schema, dbName).filter((k) => k.refTable === name));
    }
    return { name, database: dbName, columns, primaryKey, indexes, foreignKeys, referencedBy, ddl: ddl ? String(ddl) : null };
  }

  /** `PRAGMA foreign_key_list`, grouped by key id; the referenced table is in the same file. */
  private foreignKeysOf(table: string, schema: string, dbName: string): DbForeignKey[] {
    const keys = new Map<number, DbForeignKey>();
    let rows: Record<string, unknown>[];
    try {
      rows = this.all(`PRAGMA ${schema}foreign_key_list(${quoteIdentifier('sqlite', table)})`);
    } catch {
      return [];
    }
    for (const r of rows) {
      const id = Number(r.id);
      const key = keys.get(id) ?? { name: `fk_${table}_${id}`, database: dbName, table, columns: [], refDatabase: dbName, refTable: String(r.table), refColumns: [] };
      key.columns.push(String(r.from));
      key.refColumns.push(r.to === null || r.to === undefined ? 'rowid' : String(r.to));
      keys.set(id, key);
    }
    return [...keys.values()];
  }

  async columns(database?: string | null): Promise<DbTableColumns[]> {
    const schema = database && database !== 'main' ? `${quoteIdentifier('sqlite', database)}.` : '';
    return (await this.tables(database)).map((t) =>
      columnsEntry(
        t.name,
        t.type,
        this.all(`PRAGMA ${schema}table_info(${quoteIdentifier('sqlite', t.name)})`).map((r) => ({ name: String(r.name), type: String(r.type ?? '') })),
      ),
    );
  }

  async run(query: string, options: RunOptions): Promise<DbQueryResult[]> {
    const results: DbQueryResult[] = [];
    for (const statement of splitStatements(query)) {
      const started = performance.now();
      const stmt = this.prepare(statement);
      const columns = columnsOf(stmt);
      try {
        if (columns.length > 0) {
          const rows = collectRows(stmt, columns, options.maxRows + 1);
          const truncated = rows.length > options.maxRows;
          results.push({
            statement,
            kind: 'rows',
            columns,
            rows: rows.slice(0, options.maxRows),
            rowCount: Math.min(rows.length, options.maxRows),
            truncated,
            affectedRows: null,
            insertId: null,
            value: null,
            durationMs: performance.now() - started,
            message: null,
          });
        } else {
          const info = stmt.run();
          const result = emptyResult(statement, performance.now() - started);
          result.affectedRows = Number(info.changes);
          result.insertId = info.lastInsertRowid && Number(info.lastInsertRowid) > 0 ? String(info.lastInsertRowid) : null;
          results.push(result);
        }
      } catch (err) {
        throw wrapError(err);
      }
    }
    return results;
  }

  async tableRows(name: string, options: TableRowsOptions): Promise<DbTableRows> {
    const target = qualifiedName('sqlite', name, options.database && options.database !== 'main' ? options.database : null);
    const where = options.where?.trim() ? ` WHERE ${options.where.trim()}` : '';
    const order = options.orderBy ? ` ORDER BY ${quoteIdentifier('sqlite', options.orderBy)} ${options.direction === 'desc' ? 'DESC' : 'ASC'}` : '';
    const started = performance.now();
    const stmt = this.prepare(`SELECT * FROM ${target}${where}${order} LIMIT ${options.limit} OFFSET ${options.offset}`);
    const columns = columnsOf(stmt);
    let rows: unknown[][];
    let total: number;
    try {
      rows = collectRows(stmt, columns, options.limit);
      total = Number(this.all(`SELECT COUNT(*) AS n FROM ${target}${where}`)[0]?.n ?? 0);
    } catch (err) {
      throw wrapError(err);
    }
    return { columns, rows, total, approximate: false, limit: options.limit, offset: options.offset, durationMs: performance.now() - started };
  }
}

function columnsOf(stmt: StatementSync): ColumnMeta[] {
  try {
    return stmt.columns().map((c) => ({ name: c.name, type: c.type ? String(c.type).toLowerCase() : null }));
  } catch {
    return [];
  }
}

function collectRows(stmt: StatementSync, columns: ColumnMeta[], max: number): unknown[][] {
  const rows: unknown[][] = [];
  const asArrays = typeof (stmt as { setReturnArrays?: (on: boolean) => void }).setReturnArrays === 'function';
  if (asArrays) (stmt as unknown as { setReturnArrays(on: boolean): void }).setReturnArrays(true);
  for (const row of stmt.iterate()) {
    const values = asArrays ? (row as unknown as unknown[]) : columns.map((c) => (row as Record<string, unknown>)[c.name]);
    rows.push(values.map(normalizeValue));
    if (rows.length >= max) break;
  }
  return rows;
}

function wrapError(err: unknown): QuiverError {
  if (err instanceof QuiverError) return err;
  const e = err as { message?: string; errcode?: number; errstr?: string; code?: string };
  return new QuiverError('REQUEST_FAILED', e.message ?? String(err), { errcode: e.errcode, errstr: e.errstr, code: e.code });
}
