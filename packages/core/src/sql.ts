import { tokenizeShell } from './curl';
import { QuiverError } from './errors';
import type { DbTableEdit, SqlKind } from './models/db';

export interface StatementRange {
  /** The statement, trimmed, without its terminating semicolon. */
  text: string;
  /** Offset of the statement's first character in the script. */
  from: number;
  /** Offset just past its last character. */
  to: number;
}

/**
 * Split a script into individual statements with their positions. Understands single/double/backtick
 * quotes, `--`, `#` and block comments, and keeps `CREATE TRIGGER ... BEGIN ... END` bodies intact.
 * Statements come back trimmed, with comments preserved (drivers ignore them).
 */
export function splitStatementRanges(sql: string): StatementRange[] {
  const out: StatementRange[] = [];
  let current = '';
  let start = 0;
  let quote: string | null = null;
  let inTrigger = false;
  let lastWord = '';
  let word = '';

  const append = (text: string, at: number) => {
    if (!current) start = at;
    current += text;
  };
  const flushWord = () => {
    if (!word) return;
    const upper = word.toUpperCase();
    if (!inTrigger && upper === 'TRIGGER' && /\bCREATE\b/i.test(current)) inTrigger = true;
    lastWord = upper;
    word = '';
  };
  const push = () => {
    const text = current.trim();
    if (text && !/^[\s;]*$/.test(text) && !isOnlyComments(text)) {
      const from = start + (current.length - current.trimStart().length);
      out.push({ text, from, to: from + text.length });
    }
    current = '';
    inTrigger = false;
    lastWord = '';
  };

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (quote) {
      append(ch, i);
      if (ch === '\\' && quote !== '`' && next !== undefined) {
        current += next;
        i++;
      } else if (ch === quote) {
        if (next === quote) {
          current += next;
          i++;
        } else {
          quote = null;
        }
      }
      continue;
    }

    if ((ch === '-' && next === '-') || ch === '#') {
      flushWord();
      const end = sql.indexOf('\n', i);
      append(end < 0 ? sql.slice(i) : sql.slice(i, end), i);
      i = end < 0 ? sql.length : end - 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      flushWord();
      const end = sql.indexOf('*/', i + 2);
      append(end < 0 ? sql.slice(i) : sql.slice(i, end + 2), i);
      i = end < 0 ? sql.length : end + 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      flushWord();
      quote = ch;
      append(ch, i);
      continue;
    }
    if (ch === ';') {
      flushWord();
      if (inTrigger && lastWord !== 'END') {
        append(ch, i);
        continue;
      }
      push();
      continue;
    }
    if (/[A-Za-z0-9_]/.test(ch)) {
      word += ch;
    } else {
      flushWord();
    }
    append(ch, i);
  }
  flushWord();
  push();
  return out;
}

/** The statements of a script, trimmed, in order. See `splitStatementRanges`. */
export function splitStatements(sql: string): string[] {
  return splitStatementRanges(sql).map((r) => r.text);
}

/**
 * The statement the cursor is in, for "run the statement under the cursor": the one spanning
 * `offset`, else the last one that starts before it (the cursor sits in the whitespace after it),
 * else the first. Null for a script without statements.
 */
export function statementAt(sql: string, offset: number): StatementRange | null {
  const ranges = splitStatementRanges(sql);
  if (!ranges.length) return null;
  const within = ranges.find((r) => offset >= r.from && offset <= r.to);
  if (within) return within;
  const before = [...ranges].reverse().find((r) => r.from <= offset);
  return before ?? ranges[0];
}

function isOnlyComments(text: string): boolean {
  return stripComments(text).trim() === '';
}

/** Remove comments, leaving strings untouched. */
export function stripComments(sql: string): string {
  let out = '';
  let quote: string | null = null;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (quote) {
      out += ch;
      if (ch === '\\' && quote !== '`' && next !== undefined) {
        out += next;
        i++;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      out += ch;
      continue;
    }
    if ((ch === '-' && next === '-') || ch === '#') {
      const end = sql.indexOf('\n', i);
      i = end < 0 ? sql.length : end - 1;
      out += ' ';
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end < 0 ? sql.length : end + 1;
      out += ' ';
      continue;
    }
    out += ch;
  }
  return out;
}

const READ_VERBS = new Set(['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'VALUES', 'TABLE', 'USE', 'HELP', 'CHECK']);
const MAIN_VERBS = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'MERGE', 'VALUES']);

export interface StatementInfo {
  /** Uppercase leading keyword, e.g. SELECT, INSERT, PRAGMA. Empty for blank input. */
  verb: string;
  /** True when the statement cannot change data or server state. Conservative: unknown verbs count as writes. */
  readOnly: boolean;
}

/** Classify one SQL statement. Used to let agents run reads while writes stay gated. */
export function classifyStatement(statement: string): StatementInfo {
  const text = stripComments(statement).trim().replace(/;+\s*$/, '');
  const words = topLevelWords(text);
  const verb = words[0] ?? '';
  if (!verb) return { verb, readOnly: true };

  if (verb === 'WITH') {
    const main = words.slice(1).find((w) => MAIN_VERBS.has(w));
    return { verb: main ?? 'WITH', readOnly: main === 'SELECT' || main === 'VALUES' };
  }
  if (verb === 'PRAGMA') {
    // `PRAGMA x` reads, `PRAGMA x = y` and `PRAGMA x(y)` write.
    return { verb, readOnly: !/[=(]/.test(text) };
  }
  if (verb === 'SELECT' && /\bINTO\s+(OUTFILE|DUMPFILE|@)/i.test(text)) return { verb, readOnly: false };
  if (verb === 'EXPLAIN' && /\bANALYZE\b/i.test(text) && words.includes('ANALYZE')) {
    // EXPLAIN ANALYZE executes the statement; keep reads, gate writes.
    const inner = words.slice(1).find((w) => MAIN_VERBS.has(w));
    return { verb, readOnly: inner === 'SELECT' };
  }
  return { verb, readOnly: READ_VERBS.has(verb) };
}

/** Uppercase identifiers found at parenthesis depth 0, outside strings. */
function topLevelWords(text: string): string[] {
  const words: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let word = '';
  const flush = () => {
    if (word && depth === 0) words.push(word.toUpperCase());
    word = '';
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      flush();
      quote = ch;
      continue;
    }
    if (ch === '(') {
      flush();
      depth++;
      continue;
    }
    if (ch === ')') {
      flush();
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (/[A-Za-z_]/.test(ch) || (word && /[0-9]/.test(ch))) {
      word += ch;
    } else {
      flush();
    }
  }
  flush();
  return words;
}

/** True when every statement in the script is read-only. */
export function scriptIsReadOnly(sql: string): boolean {
  return splitStatements(sql).every((s) => classifyStatement(s).readOnly);
}

// ---------- Redis ----------

const REDIS_READ_COMMANDS = new Set([
  'GET', 'MGET', 'GETRANGE', 'STRLEN', 'GETBIT', 'BITCOUNT', 'BITPOS',
  'HGET', 'HMGET', 'HGETALL', 'HKEYS', 'HVALS', 'HLEN', 'HEXISTS', 'HSCAN', 'HSTRLEN', 'HRANDFIELD',
  'LLEN', 'LRANGE', 'LINDEX', 'LPOS',
  'SCARD', 'SMEMBERS', 'SISMEMBER', 'SMISMEMBER', 'SSCAN', 'SRANDMEMBER', 'SINTER', 'SUNION', 'SDIFF', 'SINTERCARD',
  'ZCARD', 'ZRANGE', 'ZREVRANGE', 'ZRANGEBYSCORE', 'ZREVRANGEBYSCORE', 'ZRANGEBYLEX', 'ZSCORE', 'ZMSCORE', 'ZRANK', 'ZREVRANK', 'ZSCAN', 'ZCOUNT', 'ZLEXCOUNT', 'ZRANDMEMBER',
  'XLEN', 'XRANGE', 'XREVRANGE', 'XINFO', 'XPENDING',
  'TYPE', 'TTL', 'PTTL', 'EXISTS', 'KEYS', 'SCAN', 'DBSIZE', 'RANDOMKEY', 'OBJECT', 'MEMORY', 'DUMP', 'TOUCH',
  'INFO', 'PING', 'ECHO', 'TIME', 'LASTSAVE', 'DEBUG', 'COMMAND', 'HELLO', 'SELECT', 'CLIENT', 'LOLWUT',
  'PFCOUNT', 'GEOPOS', 'GEODIST', 'GEOHASH', 'GEOSEARCH', 'GEORADIUS_RO', 'GEORADIUSBYMEMBER_RO',
  'JSON.GET', 'JSON.MGET', 'JSON.TYPE', 'JSON.STRLEN', 'JSON.ARRLEN', 'JSON.OBJKEYS', 'JSON.OBJLEN',
  'FT.SEARCH', 'FT.INFO', 'FT._LIST', 'TS.GET', 'TS.RANGE', 'TS.INFO',
]);

const REDIS_WRITE_SUBCOMMANDS: Record<string, Set<string>> = {
  CLIENT: new Set(['KILL', 'PAUSE', 'UNPAUSE', 'SETNAME', 'NO-EVICT', 'NO-TOUCH', 'REPLY', 'TRACKING', 'CACHING']),
  MEMORY: new Set(['PURGE']),
  OBJECT: new Set(),
  DEBUG: new Set(['RELOAD', 'RESTART', 'CRASH-AND-RECOVER', 'SEGFAULT', 'SET-ACTIVE-EXPIRE', 'CHANGE-REPL-ID', 'JMAP', 'POPULATE', 'SLEEP']),
};

/** Parse a console-style command line (one command per line, shell quoting) into argv lists. */
export function parseRedisCommands(text: string): string[][] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => tokenizeShell(line))
    .filter((argv) => argv.length > 0);
}

export function redisCommandIsReadOnly(argv: string[]): boolean {
  const cmd = (argv[0] ?? '').toUpperCase();
  if (!REDIS_READ_COMMANDS.has(cmd)) return false;
  const sub = (argv[1] ?? '').toUpperCase();
  const gated = REDIS_WRITE_SUBCOMMANDS[cmd];
  if (gated && gated.has(sub)) return false;
  return true;
}

export function redisScriptIsReadOnly(text: string): boolean {
  return parseRedisCommands(text).every(redisCommandIsReadOnly);
}

/** True for a statement that returns rows and can be wrapped as a subquery: SELECT, VALUES, or a CTE ending in one. */
export function isSelectLike(statement: string): boolean {
  const { verb, readOnly } = classifyStatement(statement);
  return readOnly && (verb === 'SELECT' || verb === 'VALUES');
}

/** `statement` as a page: wrapped as a subquery with LIMIT and OFFSET, for "load the next rows". */
export function wrapForPage(statement: string, limit: number, offset: number): string {
  const inner = stripComments(statement).trim().replace(/;+\s*$/, '');
  return `SELECT * FROM (${inner}) AS q LIMIT ${Math.max(1, Math.floor(limit))} OFFSET ${Math.max(0, Math.floor(offset))}`;
}

// ---------- identifiers and literals ----------

export function quoteIdentifier(kind: SqlKind, name: string): string {
  if (kind === 'mysql') return `\`${name.replace(/`/g, '``')}\``;
  return `"${name.replace(/"/g, '""')}"`;
}

export function qualifiedName(kind: SqlKind, table: string, database?: string | null): string {
  const t = quoteIdentifier(kind, table);
  return database ? `${quoteIdentifier(kind, database)}.${t}` : t;
}

/** A value as a SQL literal of the dialect. Binary previews (`{ $bytes, hex }`) become `X'…'` when complete, else NULL. */
export function sqlLiteral(kind: SqlKind, value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'boolean') return kind === 'sqlite' ? (value ? '1' : '0') : value ? 'TRUE' : 'FALSE';
  if (value instanceof Date) return quoteString(kind, value.toISOString());
  if (typeof value === 'string') return quoteString(kind, value);
  if (typeof value === 'object' && '$bytes' in value) {
    const bytes = value as { $bytes: number; hex: string };
    return bytes.hex.length === bytes.$bytes * 2 ? `X'${bytes.hex}'` : 'NULL';
  }
  return quoteString(kind, JSON.stringify(value));
}

function quoteString(kind: SqlKind, text: string): string {
  const doubled = text.replace(/'/g, "''");
  return `'${kind === 'mysql' ? doubled.replace(/\\/g, '\\\\') : doubled}'`;
}

/** `name = value`, or `name IS NULL`, for a WHERE clause. */
function keyCondition(kind: SqlKind, key: Record<string, unknown>): string {
  const names = Object.keys(key);
  if (!names.length) throw new QuiverError('INVALID_INPUT', 'A row edit needs a key: the table has no primary key');
  return names.map((name) => (key[name] === null || key[name] === undefined ? `${quoteIdentifier(kind, name)} IS NULL` : `${quoteIdentifier(kind, name)} = ${sqlLiteral(kind, key[name])}`)).join(' AND ');
}

/**
 * The statements that apply a set of row edits to a table, one per edit, in order. An update with
 * nothing changed produces no statement. The host runs them inside a transaction (`db.table.apply`).
 */
export function buildTableEdits(kind: SqlKind, table: string, database: string | null | undefined, edits: DbTableEdit[]): string[] {
  const target = qualifiedName(kind, table, database);
  const statements: string[] = [];
  for (const edit of edits) {
    switch (edit.kind) {
      case 'insert': {
        const names = Object.keys(edit.values);
        if (!names.length) {
          statements.push(kind === 'mysql' ? `INSERT INTO ${target} () VALUES ()` : `INSERT INTO ${target} DEFAULT VALUES`);
        } else {
          statements.push(`INSERT INTO ${target} (${names.map((n) => quoteIdentifier(kind, n)).join(', ')}) VALUES (${names.map((n) => sqlLiteral(kind, edit.values[n])).join(', ')})`);
        }
        break;
      }
      case 'update': {
        const names = Object.keys(edit.values);
        if (!names.length) break;
        statements.push(`UPDATE ${target} SET ${names.map((n) => `${quoteIdentifier(kind, n)} = ${sqlLiteral(kind, edit.values[n])}`).join(', ')} WHERE ${keyCondition(kind, edit.key)}`);
        break;
      }
      case 'delete':
        statements.push(`DELETE FROM ${target} WHERE ${keyCondition(kind, edit.key)}`);
        break;
    }
  }
  return statements;
}

/**
 * What a value typed into a grid cell means for the column: numbers for numeric columns when the
 * text is one, booleans for boolean columns, text otherwise. The grid sets NULL explicitly.
 */
export function coerceCellInput(text: string, columnType: string | null | undefined): unknown {
  const type = (columnType ?? '').toLowerCase();
  if (/\b(int|integer|smallint|bigint|tinyint|mediumint|serial|decimal|numeric|real|double|float|number|money)\b/.test(type) && /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(text.trim())) {
    const n = Number(text.trim());
    // Keep digits beyond what a double holds as text: the literal is written as-is either way.
    return Number.isSafeInteger(n) || !/^-?\d+$/.test(text.trim()) ? n : text.trim();
  }
  if (/\b(bool|boolean)\b/.test(type)) {
    const t = text.trim().toLowerCase();
    if (t === 'true' || t === '1' || t === 't' || t === 'yes') return true;
    if (t === 'false' || t === '0' || t === 'f' || t === 'no') return false;
  }
  return text;
}
