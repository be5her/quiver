import { DB_QUERY_CANCELLED, QuiverError, qualifiedName, quoteIdentifier, splitStatements, type DbColumn, type DbConnection, type DbForeignKey, type DbIndex, type DbQueryResult, type DbTable, type DbTableColumns, type DbTableDetail, type DbTableRows } from '@quiver/core';
import { Client, types, type ClientConfig, type FieldDef, type QueryResult } from 'pg';
import { columnsEntry, emptyResult, normalizeValue, type Driver, type RunOptions, type TableRowsOptions } from './types';

/** Types whose values stay as the server wrote them, so nothing is rounded (int8, numeric) or shifted into the local zone (dates and times). */
const TEXT_OIDS = new Set([20, 1700, 1114, 1184, 1082, 1083, 1266, 1186]);

const customTypes = {
  getTypeParser: (oid: number, format?: 'text' | 'binary') => (TEXT_OIDS.has(oid) ? (value: string) => value : types.getTypeParser(oid, format as 'text')),
};

/** Row counts come from the planner's estimate; below this many rows a real COUNT(*) is cheap enough. */
const EXACT_COUNT_UNDER = 200_000;

const COMMANDS_WITH_ROWS = new Set(['SELECT', 'SHOW', 'EXPLAIN', 'VALUES', 'FETCH', 'TABLE']);

export class PostgresDriver implements Driver {
  readonly kind = 'postgres' as const;
  private client: Client | null = null;
  private dead = false;
  private currentSchema: string | null = null;
  private typeNames: Map<number, string> | null = null;

  constructor(
    private readonly config: DbConnection,
    private readonly password: string,
  ) {}

  private clientConfig(): ClientConfig {
    return {
      host: this.config.host,
      port: this.config.port || 5432,
      user: this.config.user || 'postgres',
      password: this.password,
      database: this.config.database || undefined,
      ssl: this.config.ssl ? { rejectUnauthorized: false } : undefined,
      connectionTimeoutMillis: 10_000,
      types: customTypes,
      application_name: 'quiver',
    };
  }

  async connect(): Promise<void> {
    const client = new Client(this.clientConfig());
    client.on('error', () => {
      this.dead = true;
    });
    try {
      await client.connect();
    } catch (err) {
      throw wrapError(err);
    }
    this.client = client;
    this.dead = false;
    this.currentSchema = null;
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.dead = true;
    if (client) await client.end().catch(() => {});
  }

  isAlive(): boolean {
    return this.client !== null && !this.dead;
  }

  private c(): Client {
    if (!this.client || this.dead) throw new QuiverError('REQUEST_FAILED', 'PostgreSQL connection is closed');
    return this.client;
  }

  private async query(text: string, values?: unknown[]): Promise<QueryResult<unknown[]>> {
    try {
      return await this.c().query<unknown[]>({ text, values, rowMode: 'array' });
    } catch (err) {
      throw wrapError(err);
    }
  }

  async ping(): Promise<{ serverVersion: string }> {
    const { rows } = await this.query('SELECT version()');
    const full = String(rows[0]?.[0] ?? 'PostgreSQL');
    return { serverVersion: /^PostgreSQL\s+\S+/.exec(full)?.[0] ?? full };
  }

  /** Schemas of the connected database, system ones left out. */
  async databases(): Promise<string[]> {
    const { rows } = await this.query(
      "SELECT nspname FROM pg_namespace WHERE nspname NOT IN ('pg_catalog', 'information_schema') AND nspname NOT LIKE 'pg_toast%' AND nspname NOT LIKE 'pg_temp%' ORDER BY (nspname <> 'public'), nspname",
    );
    return rows.map((r) => String(r[0]));
  }

  private schemaFor(database?: string | null): string {
    return database || this.currentSchema || 'public';
  }

  async tables(database?: string | null): Promise<DbTable[]> {
    const schema = this.schemaFor(database);
    const { rows } = await this.query(
      "SELECT c.relname, c.relkind, c.reltuples FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'f') ORDER BY c.relname",
      [schema],
    );
    return rows.map((r) => {
      const kind = String(r[1]);
      const estimate = Number(r[2]);
      return {
        name: String(r[0]),
        type: kind === 'v' || kind === 'm' ? 'view' : 'table',
        rows: kind === 'v' || !Number.isFinite(estimate) || estimate < 0 ? null : Math.round(estimate),
        engine: kind === 'p' ? 'partitioned' : kind === 'f' ? 'foreign' : kind === 'm' ? 'materialized' : null,
      };
    });
  }

  async columns(database?: string | null): Promise<DbTableColumns[]> {
    const schema = this.schemaFor(database);
    const { rows } = await this.query(
      `SELECT c.relname, c.relkind, a.attname, format_type(a.atttypid, a.atttypmod)
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
       WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'f') ORDER BY c.relname, a.attnum`,
      [schema],
    );
    const out: DbTableColumns[] = [];
    for (const r of rows) {
      const name = String(r[0]);
      let entry = out[out.length - 1];
      if (!entry || entry.name !== name) {
        const kind = String(r[1]);
        entry = columnsEntry(name, kind === 'v' || kind === 'm' ? 'view' : 'table', []);
        out.push(entry);
      }
      entry.columns.push({ name: String(r[2]), type: String(r[3]) });
    }
    return out;
  }

  async table(name: string, database?: string | null): Promise<DbTableDetail> {
    const schema = this.schemaFor(database);
    const target = qualifiedName('postgres', name, schema);
    const cols = await this.query(
      `SELECT a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull, pg_get_expr(d.adbin, d.adrelid), a.attidentity, a.attgenerated
       FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`,
      [target],
    ).catch((err: QuiverError) => {
      if (/does not exist/i.test(err.message)) throw new QuiverError('NOT_FOUND', `Table ${schema}.${name} not found`);
      throw err;
    });
    if (!cols.rows.length) throw new QuiverError('NOT_FOUND', `Table ${schema}.${name} not found`);

    const idx = await this.query(
      `SELECT i.relname, ix.indisunique, ix.indisprimary,
              (SELECT array_agg(a.attname ORDER BY k.ord) FROM unnest(ix.indkey) WITH ORDINALITY k(attnum, ord) JOIN pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = k.attnum)
       FROM pg_index ix JOIN pg_class i ON i.oid = ix.indexrelid WHERE ix.indrelid = $1::regclass ORDER BY ix.indisprimary DESC, i.relname`,
      [target],
    );
    const indexes: DbIndex[] = idx.rows.map((r) => ({ name: String(r[0]), unique: Boolean(r[1]), columns: (r[3] as string[] | null) ?? [] }));
    const primaryKey = (idx.rows.find((r) => Boolean(r[2]))?.[3] as string[] | null) ?? [];
    const uniqueSingle = new Set(indexes.filter((i) => i.unique && i.columns.length === 1).map((i) => i.columns[0]));
    const indexed = new Set(indexes.flatMap((i) => i.columns));

    const columns: DbColumn[] = cols.rows.map((r) => {
      const column = String(r[0]);
      const identity = String(r[4] ?? '');
      const generated = String(r[5] ?? '');
      const extra = [identity === 'a' ? 'identity (always)' : identity === 'd' ? 'identity (by default)' : '', generated === 's' ? 'generated' : ''].filter(Boolean).join(', ');
      return {
        name: column,
        type: String(r[1]),
        nullable: !r[2],
        key: primaryKey.includes(column) ? 'PRI' : uniqueSingle.has(column) ? 'UNI' : indexed.has(column) ? 'MUL' : null,
        default: r[3] === null || r[3] === undefined ? null : String(r[3]),
        extra: extra || null,
      };
    });

    const fk = await this.query(
      `SELECT con.conname, n.nspname, c.relname, nf.nspname, cf.relname,
              (SELECT array_agg(a.attname ORDER BY k.ord) FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord) JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum),
              (SELECT array_agg(a.attname ORDER BY k.ord) FROM unnest(con.confkey) WITH ORDINALITY k(attnum, ord) JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum),
              con.conrelid = $1::regclass
       FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_class cf ON cf.oid = con.confrelid JOIN pg_namespace nf ON nf.oid = cf.relnamespace
       WHERE con.contype = 'f' AND (con.conrelid = $1::regclass OR con.confrelid = $1::regclass) ORDER BY n.nspname, c.relname, con.conname`,
      [target],
    );
    const foreignKeys: DbForeignKey[] = [];
    const referencedBy: DbForeignKey[] = [];
    for (const r of fk.rows) {
      const key: DbForeignKey = {
        name: String(r[0]),
        database: String(r[1]),
        table: String(r[2]),
        refDatabase: String(r[3]),
        refTable: String(r[4]),
        columns: (r[5] as string[] | null) ?? [],
        refColumns: (r[6] as string[] | null) ?? [],
      };
      if (r[7]) foreignKeys.push(key);
      if (key.refTable === name && key.refDatabase === schema) referencedBy.push(key);
    }

    return { name, database: schema, columns, primaryKey, indexes, foreignKeys, referencedBy, ddl: synthesizeDdl(schema, name, columns, primaryKey, foreignKeys) };
  }

  private async useSchema(database?: string | null): Promise<void> {
    if (!database || database === this.currentSchema) return;
    await this.query(`SET search_path TO ${quoteIdentifier('postgres', database)}`);
    this.currentSchema = database;
  }

  private async typeName(oid: number): Promise<string | null> {
    if (!this.typeNames) {
      const { rows } = await this.query('SELECT oid, typname FROM pg_type');
      this.typeNames = new Map(rows.map((r) => [Number(r[0]), String(r[1])]));
    }
    return this.typeNames.get(oid) ?? null;
  }

  private async resultColumns(fields: FieldDef[]): Promise<{ name: string; type: string | null }[]> {
    return Promise.all(fields.map(async (f) => ({ name: f.name, type: await this.typeName(f.dataTypeID) })));
  }

  async run(query: string, options: RunOptions): Promise<DbQueryResult[]> {
    await this.useSchema(options.database);
    const results: DbQueryResult[] = [];
    for (const statement of splitStatements(query)) {
      const started = performance.now();
      const res = await this.query(statement);
      const durationMs = performance.now() - started;
      const sets = Array.isArray(res) ? (res as QueryResult<unknown[]>[]) : [res];
      for (const set of sets) results.push(await this.toResult(statement, set, options.maxRows, durationMs));
    }
    return results;
  }

  private async toResult(statement: string, res: QueryResult<unknown[]>, maxRows: number, durationMs: number): Promise<DbQueryResult> {
    const fields = res.fields ?? [];
    if (fields.length > 0 || COMMANDS_WITH_ROWS.has(String(res.command ?? '').toUpperCase())) {
      const all = res.rows ?? [];
      return {
        statement,
        kind: 'rows',
        columns: await this.resultColumns(fields),
        rows: all.slice(0, maxRows).map((r) => r.map(normalizeValue)),
        rowCount: Math.min(all.length, maxRows),
        truncated: all.length > maxRows,
        affectedRows: null,
        insertId: null,
        value: null,
        durationMs,
        message: null,
      };
    }
    const result = emptyResult(statement, durationMs);
    result.affectedRows = res.rowCount ?? 0;
    result.message = res.command ? String(res.command) : null;
    return result;
  }

  async tableRows(name: string, options: TableRowsOptions): Promise<DbTableRows> {
    const schema = this.schemaFor(options.database);
    const target = qualifiedName('postgres', name, schema);
    const where = options.where?.trim() ? ` WHERE ${options.where.trim()}` : '';
    const order = options.orderBy ? ` ORDER BY ${quoteIdentifier('postgres', options.orderBy)} ${options.direction === 'desc' ? 'DESC' : 'ASC'}` : '';
    const started = performance.now();
    const res = await this.query(`SELECT * FROM ${target}${where}${order} LIMIT ${options.limit} OFFSET ${options.offset}`);
    const durationMs = performance.now() - started;

    let total: number | null = null;
    let approximate = false;
    if (where) {
      const count = await this.query(`SELECT COUNT(*) FROM ${target}${where}`);
      total = Number(count.rows[0]?.[0] ?? 0);
    } else {
      const est = await this.query('SELECT reltuples FROM pg_class WHERE oid = $1::regclass', [target]);
      const estimate = Number(est.rows[0]?.[0]);
      total = Number.isFinite(estimate) && estimate >= 0 ? Math.round(estimate) : null;
      approximate = true;
      if (total === null || total < EXACT_COUNT_UNDER) {
        const count = await this.query(`SELECT COUNT(*) FROM ${target}`);
        total = Number(count.rows[0]?.[0] ?? 0);
        approximate = false;
      }
    }
    return {
      columns: await this.resultColumns(res.fields ?? []),
      rows: (res.rows ?? []).slice(0, options.limit).map((r) => r.map(normalizeValue)),
      total,
      approximate,
      limit: options.limit,
      offset: options.offset,
      durationMs,
    };
  }

  /** `pg_cancel_backend` from a second connection: the running statement fails with 57014, which comes back as QUERY_CANCELLED. */
  async cancel(): Promise<boolean> {
    const pid = (this.client as { processID?: number | null } | null)?.processID;
    if (!pid || !this.isAlive()) return false;
    const killer = new Client(this.clientConfig());
    try {
      await killer.connect();
      const { rows } = await killer.query('SELECT pg_cancel_backend($1)', [pid]);
      return Boolean(rows[0]?.pg_cancel_backend);
    } catch (err) {
      throw wrapError(err);
    } finally {
      await killer.end().catch(() => {});
    }
  }
}

/** Postgres has no SHOW CREATE TABLE; this is the table as the catalog describes it. */
function synthesizeDdl(schema: string, name: string, columns: DbColumn[], primaryKey: string[], foreignKeys: DbForeignKey[]): string {
  const lines = columns.map((c) => {
    const parts = [quoteIdentifier('postgres', c.name), c.type];
    if (!c.nullable) parts.push('NOT NULL');
    if (c.default !== null) parts.push(`DEFAULT ${c.default}`);
    if (c.extra?.startsWith('identity')) parts.push(c.extra === 'identity (always)' ? 'GENERATED ALWAYS AS IDENTITY' : 'GENERATED BY DEFAULT AS IDENTITY');
    return `  ${parts.join(' ')}`;
  });
  if (primaryKey.length) lines.push(`  PRIMARY KEY (${primaryKey.map((c) => quoteIdentifier('postgres', c)).join(', ')})`);
  for (const fk of foreignKeys) {
    lines.push(
      `  CONSTRAINT ${quoteIdentifier('postgres', fk.name)} FOREIGN KEY (${fk.columns.map((c) => quoteIdentifier('postgres', c)).join(', ')}) REFERENCES ${qualifiedName('postgres', fk.refTable, fk.refDatabase)} (${fk.refColumns.map((c) => quoteIdentifier('postgres', c)).join(', ')})`,
    );
  }
  return `CREATE TABLE ${qualifiedName('postgres', name, schema)} (\n${lines.join(',\n')}\n);`;
}

function wrapError(err: unknown): QuiverError {
  if (err instanceof QuiverError) return err;
  const e = err as { code?: string; message?: string; position?: string; detail?: string; hint?: string; severity?: string };
  const message = e.message ?? String(err);
  if (e.code === '57014') return new QuiverError(DB_QUERY_CANCELLED, 'The query was cancelled', { code: e.code });
  const extra = [e.detail, e.hint].filter(Boolean).join(' ');
  return new QuiverError('REQUEST_FAILED', extra ? `${message} (${extra})` : message, { code: e.code, position: e.position, detail: e.detail, hint: e.hint });
}
