import { QuiverError, qualifiedName, quoteIdentifier, splitStatements, type DbColumn, type DbConnection, type DbIndex, type DbQueryResult, type DbTable, type DbTableDetail, type DbTableRows } from '@quiver/core';
import { Types } from 'mysql2';
import { createConnection, type Connection, type FieldPacket } from 'mysql2/promise';
import { emptyResult, normalizeValue, type Driver, type RunOptions, type TableRowsOptions } from './types';

const TYPE_NAMES = Types as unknown as Record<number, string>;

function typeName(field: FieldPacket): string | null {
  const type = (field as { columnType?: number }).columnType ?? (field as { type?: number }).type;
  return typeof type === 'number' ? (TYPE_NAMES[type] ?? String(type)).toLowerCase() : null;
}

interface ResultSetHeaderLike {
  affectedRows: number;
  insertId: number | bigint;
  info?: string;
}

export class MySqlDriver implements Driver {
  readonly kind = 'mysql' as const;
  private conn: Connection | null = null;
  private dead = false;
  private currentDb: string | null;
  private selectLimit = 0;

  constructor(
    private readonly config: DbConnection,
    private readonly password: string,
  ) {
    this.currentDb = config.database || null;
  }

  async connect(): Promise<void> {
    const conn = await createConnection({
      host: this.config.host,
      port: this.config.port || 3306,
      user: this.config.user || 'root',
      password: this.password,
      database: this.config.database || undefined,
      ssl: this.config.ssl ? { rejectUnauthorized: false } : undefined,
      connectTimeout: 10_000,
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
      multipleStatements: false,
    });
    conn.on('error', () => {
      this.dead = true;
    });
    this.conn = conn;
    this.dead = false;
  }

  async close(): Promise<void> {
    const conn = this.conn;
    this.conn = null;
    this.dead = true;
    if (conn) await conn.end().catch(() => conn.destroy());
  }

  isAlive(): boolean {
    return this.conn !== null && !this.dead;
  }

  private c(): Connection {
    if (!this.conn || this.dead) throw new QuiverError('REQUEST_FAILED', 'MySQL connection is closed');
    return this.conn;
  }

  private async query(sql: string, values?: unknown[]): Promise<[unknown, FieldPacket[] | undefined]> {
    try {
      const [rows, fields] = await this.c().query({ sql, values, rowsAsArray: true });
      return [rows, fields as FieldPacket[] | undefined];
    } catch (err) {
      throw wrapError(err);
    }
  }

  async ping(): Promise<{ serverVersion: string }> {
    const [rows] = await this.query('SELECT VERSION() AS v');
    return { serverVersion: String((rows as unknown[][])[0]?.[0] ?? 'unknown') };
  }

  async databases(): Promise<string[]> {
    const [rows] = await this.query('SHOW DATABASES');
    return (rows as unknown[][]).map((r) => String(r[0])).sort((a, b) => a.localeCompare(b));
  }

  private schemaFor(database?: string | null): string {
    const db = database || this.currentDb;
    if (!db) throw new QuiverError('INVALID_INPUT', 'Pick a database first: this connection has no default schema.');
    return db;
  }

  async tables(database?: string | null): Promise<DbTable[]> {
    const db = this.schemaFor(database);
    const [rows] = await this.query(
      'SELECT TABLE_NAME, TABLE_TYPE, TABLE_ROWS, ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME',
      [db],
    );
    return (rows as unknown[][]).map((r) => ({
      name: String(r[0]),
      type: String(r[1]).toUpperCase().includes('VIEW') ? 'view' : 'table',
      rows: r[2] === null || r[2] === undefined ? null : Number(r[2]),
      engine: r[3] === null || r[3] === undefined ? null : String(r[3]),
    }));
  }

  async table(name: string, database?: string | null): Promise<DbTableDetail> {
    const db = this.schemaFor(database);
    const [cols] = await this.query(
      'SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_DEFAULT, EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION',
      [db, name],
    );
    const columns: DbColumn[] = (cols as unknown[][]).map((r) => ({
      name: String(r[0]),
      type: String(r[1]),
      nullable: String(r[2]).toUpperCase() === 'YES',
      key: r[3] ? String(r[3]) : null,
      default: r[4] === null || r[4] === undefined ? null : String(r[4]),
      extra: r[5] ? String(r[5]) : null,
    }));
    if (!columns.length) throw new QuiverError('NOT_FOUND', `Table ${db}.${name} not found`);

    const indexes: DbIndex[] = [];
    try {
      const [idx, fields] = await this.query(`SHOW INDEX FROM ${qualifiedName('mysql', name, db)}`);
      const names = (fields ?? []).map((f) => f.name);
      const at = (row: unknown[], col: string) => row[names.indexOf(col)];
      const byName = new Map<string, DbIndex>();
      for (const row of idx as unknown[][]) {
        const keyName = String(at(row, 'Key_name'));
        const entry = byName.get(keyName) ?? { name: keyName, unique: Number(at(row, 'Non_unique')) === 0, columns: [] };
        entry.columns.push(String(at(row, 'Column_name')));
        byName.set(keyName, entry);
      }
      indexes.push(...byName.values());
    } catch {
      // Views have no indexes; ignore.
    }

    let ddl: string | null = null;
    try {
      const [create] = await this.query(`SHOW CREATE TABLE ${qualifiedName('mysql', name, db)}`);
      ddl = String((create as unknown[][])[0]?.[1] ?? '') || null;
    } catch {
      ddl = null;
    }
    return { name, database: db, columns, indexes, ddl };
  }

  private async useDatabase(database?: string | null): Promise<void> {
    if (!database || database === this.currentDb) return;
    await this.query(`USE ${quoteIdentifier('mysql', database)}`);
    this.currentDb = database;
  }

  private async applySelectLimit(maxRows: number): Promise<void> {
    const wanted = maxRows + 1;
    if (this.selectLimit === wanted) return;
    await this.query(`SET SESSION sql_select_limit = ${wanted}`);
    this.selectLimit = wanted;
  }

  async run(query: string, options: RunOptions): Promise<DbQueryResult[]> {
    await this.useDatabase(options.database);
    await this.applySelectLimit(options.maxRows);
    const results: DbQueryResult[] = [];
    for (const statement of splitStatements(query)) {
      const started = performance.now();
      const [rows, fields] = await this.query(statement);
      const durationMs = performance.now() - started;
      results.push(...toResults(statement, rows, fields, options.maxRows, durationMs));
      if (/^\s*USE\s/i.test(statement)) {
        const m = /^\s*USE\s+`?([^`\s;]+)`?/i.exec(statement);
        if (m) this.currentDb = m[1];
      }
    }
    return results;
  }

  async tableRows(name: string, options: TableRowsOptions): Promise<DbTableRows> {
    const db = this.schemaFor(options.database);
    const target = qualifiedName('mysql', name, db);
    const where = options.where?.trim() ? ` WHERE ${options.where.trim()}` : '';
    const order = options.orderBy ? ` ORDER BY ${quoteIdentifier('mysql', options.orderBy)} ${options.direction === 'desc' ? 'DESC' : 'ASC'}` : '';
    await this.applySelectLimit(options.limit);
    const started = performance.now();
    const [rows, fields] = await this.query(`SELECT * FROM ${target}${where}${order} LIMIT ${options.limit} OFFSET ${options.offset}`);
    const durationMs = performance.now() - started;

    let total: number | null = null;
    let approximate = false;
    if (where) {
      const [count] = await this.query(`SELECT COUNT(*) FROM ${target}${where}`);
      total = Number((count as unknown[][])[0]?.[0] ?? 0);
    } else {
      const [est] = await this.query('SELECT TABLE_ROWS FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?', [db, name]);
      const estimate = (est as unknown[][])[0]?.[0];
      total = estimate === null || estimate === undefined ? null : Number(estimate);
      approximate = true;
      if (total !== null && total < 200_000) {
        const [count] = await this.query(`SELECT COUNT(*) FROM ${target}`);
        total = Number((count as unknown[][])[0]?.[0] ?? 0);
        approximate = false;
      }
    }
    return {
      columns: (fields ?? []).map((f) => ({ name: f.name, type: typeName(f) })),
      rows: (rows as unknown[][]).slice(0, options.limit).map((r) => r.map(normalizeValue)),
      total,
      approximate,
      limit: options.limit,
      offset: options.offset,
      durationMs,
    };
  }
}

function toResults(statement: string, rows: unknown, fields: FieldPacket[] | undefined, maxRows: number, durationMs: number): DbQueryResult[] {
  // Stored procedures return several result sets: rows is an array of sets, fields an array of field lists.
  if (Array.isArray(fields) && fields.length > 0 && Array.isArray(fields[0])) {
    const sets = rows as unknown[];
    const out: DbQueryResult[] = [];
    (fields as unknown as (FieldPacket[] | undefined)[]).forEach((f, i) => out.push(...toResults(statement, sets[i], f, maxRows, i === 0 ? durationMs : 0)));
    return out;
  }
  if (Array.isArray(rows) && Array.isArray(fields)) {
    const all = rows as unknown[][];
    const truncated = all.length > maxRows;
    return [
      {
        statement,
        kind: 'rows',
        columns: fields.map((f) => ({ name: f.name, type: typeName(f) })),
        rows: all.slice(0, maxRows).map((r) => (Array.isArray(r) ? r.map(normalizeValue) : [normalizeValue(r)])),
        rowCount: Math.min(all.length, maxRows),
        truncated,
        affectedRows: null,
        insertId: null,
        value: null,
        durationMs,
        message: null,
      },
    ];
  }
  const header = rows as ResultSetHeaderLike | undefined;
  const result = emptyResult(statement, durationMs);
  result.affectedRows = header?.affectedRows ?? 0;
  result.insertId = header?.insertId ? String(header.insertId) : null;
  result.message = header?.info || null;
  return [result];
}

function wrapError(err: unknown): QuiverError {
  if (err instanceof QuiverError) return err;
  const e = err as { code?: string; sqlMessage?: string; message?: string; errno?: number; sqlState?: string };
  const message = e.sqlMessage ?? e.message ?? String(err);
  return new QuiverError('REQUEST_FAILED', e.code && !message.includes(e.code) ? `${message} (${e.code})` : message, { code: e.code, errno: e.errno, sqlState: e.sqlState });
}
