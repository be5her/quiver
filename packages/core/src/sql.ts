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

/**
 * Classify one SQL statement. Used to let agents run reads while writes stay gated. `readOnly` is exactly
 * `statementAction(statement) === 'select'`, so it is as strict as the actions are.
 */
export function classifyStatement(statement: string): StatementInfo {
  const words = topLevel(tokenizeSql(statement, LEXINGS[0])).map((t) => t.text);
  const first = words[0] ?? '';
  const verb = first === 'WITH' ? (words.slice(1).find((w) => MAIN_VERBS.has(w)) ?? 'WITH') : first;
  return { verb, readOnly: statementAction(statement) === 'select' };
}

/** True when every statement in the script is read-only. */
export function scriptIsReadOnly(sql: string): boolean {
  return scriptAction(sql) === 'select';
}

// ---------- actions, for agent rules ----------

/** What a SQL statement does, as an agent rule names it (`db.query.run#ddl`). */
export type SqlAction = 'select' | 'insert' | 'update' | 'delete' | 'ddl' | 'other';

/** The actions of `db.query.run`. A script with several statements gets its most severe one (`scriptAction`). */
export const SQL_ACTIONS: readonly SqlAction[] = ['select', 'insert', 'update', 'delete', 'ddl', 'other'];

export const SQL_ACTION_DESCRIPTIONS: Record<SqlAction, string> = {
  select: 'Reads only: SELECT, SHOW, DESCRIBE, EXPLAIN, a WITH that selects, a reading PRAGMA',
  insert: 'INSERT or REPLACE rows (also through WITH)',
  update: 'UPDATE or MERGE rows, or an INSERT that updates on conflict (also through WITH)',
  delete: 'DELETE rows (also through WITH, or a MERGE that deletes)',
  ddl: 'Changes the schema or privileges: CREATE, ALTER, DROP, TRUNCATE, RENAME, COMMENT, GRANT, REVOKE, SELECT INTO a new table',
  other: 'Anything else that is not a read: SET, CALL, COPY, transactions, VACUUM, SELECT INTO OUTFILE, a writing PRAGMA or function',
};

const DDL_VERBS = new Set(['CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'RENAME', 'COMMENT', 'GRANT', 'REVOKE']);
const DML_ACTIONS: Record<string, SqlAction> = { INSERT: 'insert', REPLACE: 'insert', UPDATE: 'update', MERGE: 'update', DELETE: 'delete' };
/** Data-changing keywords looked for anywhere in a statement (a CTE or MERGE branch). REPLACE is left out: it is also a string function. */
const NESTED_DML = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE']);
/** How severe each action is, when a script mixes them: `other` is ranked with `ddl` below it, as it may be anything. */
const SQL_SEVERITY: Record<SqlAction, number> = { select: 0, insert: 1, update: 2, delete: 3, other: 4, ddl: 5 };
/** Where the statement an `EXPLAIN ANALYZE` runs starts. */
const EXPLAINED_STARTS = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'MERGE', 'VALUES', 'WITH', 'TABLE', 'CREATE', 'EXECUTE', 'DECLARE']);
/**
 * Built-in functions that change data or the server even inside a SELECT (PostgreSQL, MySQL). A function the database
 * defines itself can do anything; a SELECT calling one is still `select`, so a read-only database user is the only
 * real guarantee.
 */
const WRITE_FUNCTIONS = new Set([
  'NEXTVAL', 'SETVAL', 'SET_CONFIG', 'PG_TERMINATE_BACKEND', 'PG_CANCEL_BACKEND', 'PG_RELOAD_CONF', 'PG_ROTATE_LOGFILE', 'PG_SWITCH_WAL',
  'PG_CREATE_RESTORE_POINT', 'PG_PROMOTE', 'PG_CREATE_PHYSICAL_REPLICATION_SLOT', 'PG_CREATE_LOGICAL_REPLICATION_SLOT', 'PG_DROP_REPLICATION_SLOT',
  'PG_REPLICATION_ORIGIN_CREATE', 'PG_REPLICATION_ORIGIN_DROP', 'PG_LOGICAL_EMIT_MESSAGE', 'PG_NOTIFY', 'PG_STAT_RESET', 'PG_STAT_RESET_SHARED',
  'PG_STAT_STATEMENTS_RESET', 'PG_FILE_WRITE', 'PG_FILE_UNLINK', 'PG_FILE_RENAME', 'PG_IMPORT_SYSTEM_COLLATIONS', 'LO_IMPORT', 'LO_EXPORT',
  'LO_UNLINK', 'LO_CREATE', 'LO_CREAT', 'LO_FROM_BYTEA', 'LO_PUT', 'LO_TRUNCATE', 'DBLINK', 'DBLINK_EXEC', 'DBLINK_CONNECT', 'DBLINK_SEND_QUERY',
  'QUERY_TO_XML', 'QUERY_TO_XMLSCHEMA', 'QUERY_TO_XML_AND_XMLSCHEMA', 'LOAD_EXTENSION',
]);

/**
 * How one engine reads SQL text. The drivers send what `splitStatements` cuts, and PostgreSQL runs every statement in
 * one such piece, so a script, and each piece of it, is classified as each engine (and server setting) would read it and the most severe reading counts: a `#`
 * that MySQL takes for a comment, a backslash before a quote, a `$$` string or a nested comment cannot hide a write
 * from the classification.
 */
interface SqlLexing {
  /** `#` starts a comment to the end of the line. */
  hashComments: boolean;
  /** A backslash escapes the next character in '…' and "…". */
  backslashEscapes: boolean;
  /** Backticks quote an identifier. */
  backticks: boolean;
  /** Square brackets quote an identifier. */
  brackets: boolean;
  /** Dollar-quoted strings, nested block comments, and backslash escapes in E'…'. */
  postgres: boolean;
}

const LEXINGS: readonly SqlLexing[] = [
  { hashComments: true, backslashEscapes: true, backticks: true, brackets: false, postgres: false }, // MySQL
  { hashComments: true, backslashEscapes: false, backticks: true, brackets: false, postgres: false }, // MySQL with NO_BACKSLASH_ESCAPES
  { hashComments: false, backslashEscapes: false, backticks: false, brackets: false, postgres: true }, // PostgreSQL
  { hashComments: false, backslashEscapes: true, backticks: false, brackets: false, postgres: true }, // PostgreSQL without standard_conforming_strings
  { hashComments: false, backslashEscapes: false, backticks: true, brackets: true, postgres: false }, // SQLite
];

interface SqlToken {
  kind: 'word' | 'string' | 'punct';
  /** Uppercase for a word; the character for punctuation; empty for a string. */
  text: string;
  /** Parenthesis depth. */
  depth: number;
}

const WORD_START = /[A-Za-z_\u0080-￿]/;
const WORD_CHAR = /[A-Za-z0-9_$\u0080-￿]/;
const DOLLAR_TAG = /^\$(?:[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/;

/** The tokens of a script as one engine reads it: words, strings (and quoted identifiers) and punctuation, without comments. */
function tokenizeSql(sql: string, lex: SqlLexing): SqlToken[] {
  const out: SqlToken[] = [];
  const n = sql.length;
  let depth = 0;
  /** The index after a quoted run opened at `at`. Unterminated, it runs to the end (the engine refuses it). */
  const quoted = (at: number, close: string, backslash: boolean, doubled: boolean): number => {
    for (let j = at + 1; j < n; j++) {
      const ch = sql[j];
      if (backslash && ch === '\\') {
        j++;
        continue;
      }
      if (ch === close) {
        if (doubled && sql[j + 1] === close) {
          j++;
          continue;
        }
        return j + 1;
      }
    }
    return n;
  };
  let i = 0;
  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (/\s/.test(ch)) {
      i++;
    } else if ((ch === '-' && next === '-') || (lex.hashComments && ch === '#')) {
      const end = sql.indexOf('\n', i);
      i = end < 0 ? n : end + 1;
    } else if (ch === '/' && next === '*') {
      let nested = 1;
      let j = i + 2;
      while (j < n && nested > 0) {
        if (sql[j] === '*' && sql[j + 1] === '/') {
          nested--;
          j += 2;
        } else if (lex.postgres && sql[j] === '/' && sql[j + 1] === '*') {
          nested++;
          j += 2;
        } else j++;
      }
      i = j;
    } else if (ch === "'") {
      // PostgreSQL's E'…' takes backslash escapes, its other strings do not.
      const eString = lex.postgres && /[eE]/.test(sql[i - 1] ?? '') && !WORD_CHAR.test(sql[i - 2] ?? '');
      i = quoted(i, "'", lex.backslashEscapes || eString, true);
      out.push({ kind: 'string', text: '', depth });
    } else if (ch === '"') {
      i = quoted(i, '"', lex.backslashEscapes, true);
      out.push({ kind: 'string', text: '', depth });
    } else if (ch === '`' && lex.backticks) {
      i = quoted(i, '`', false, true);
      out.push({ kind: 'string', text: '', depth });
    } else if (ch === '[' && lex.brackets) {
      i = quoted(i, ']', false, false);
      out.push({ kind: 'string', text: '', depth });
    } else if (ch === '$' && lex.postgres && !WORD_CHAR.test(sql[i - 1] ?? '') && DOLLAR_TAG.test(sql.slice(i, i + 64))) {
      const tag = DOLLAR_TAG.exec(sql.slice(i, i + 64))![0];
      const end = sql.indexOf(tag, i + tag.length);
      i = end < 0 ? n : end + tag.length;
      out.push({ kind: 'string', text: '', depth });
    } else if (WORD_START.test(ch)) {
      let j = i + 1;
      while (j < n && WORD_CHAR.test(sql[j])) j++;
      out.push({ kind: 'word', text: sql.slice(i, j).toUpperCase(), depth });
      i = j;
    } else if (/[0-9]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[0-9A-Za-z_.]/.test(sql[j])) j++;
      out.push({ kind: 'punct', text: '0', depth });
      i = j;
    } else {
      if (ch === ')') depth = Math.max(0, depth - 1);
      out.push({ kind: 'punct', text: ch, depth });
      if (ch === '(') depth++;
      i++;
    }
  }
  return out;
}

/** The tokens of each statement, cut at the semicolons outside strings and comments. */
function tokenStatements(tokens: SqlToken[]): SqlToken[][] {
  const out: SqlToken[][] = [[]];
  for (const t of tokens) {
    if (t.kind === 'punct' && t.text === ';') out.push([]);
    else out[out.length - 1].push(t);
  }
  return out.filter((s) => s.length > 0);
}

function topLevel(tokens: SqlToken[]): SqlToken[] {
  return tokens.filter((t) => t.kind === 'word' && t.depth === 0);
}

function worse(a: SqlAction, b: SqlAction): SqlAction {
  return SQL_SEVERITY[b] > SQL_SEVERITY[a] ? b : a;
}

/** The most severe data change named anywhere in a statement (a data-modifying CTE, a MERGE branch, an upsert), or undefined. */
function nestedDml(tokens: SqlToken[]): SqlAction | undefined {
  let found: SqlAction | undefined;
  tokens.forEach((t, i) => {
    if (t.kind !== 'word' || !NESTED_DML.has(t.text)) return;
    // SELECT … FOR UPDATE and FOR NO KEY UPDATE lock rows; they change none (ON DUPLICATE KEY UPDATE does).
    if (t.text === 'UPDATE' && (tokens[i - 1]?.text === 'FOR' || (tokens[i - 1]?.text === 'KEY' && tokens[i - 2]?.text === 'NO'))) return;
    found = found ? worse(found, DML_ACTIONS[t.text]) : DML_ACTIONS[t.text];
  });
  return found;
}

/** The action of one statement's tokens. */
function tokensAction(tokens: SqlToken[]): SqlAction {
  const top = topLevel(tokens);
  const verb = top[0]?.text;
  if (!verb) return 'other';
  if (DDL_VERBS.has(verb)) return 'ddl';
  const dml = DML_ACTIONS[verb];
  if (dml) return worse(dml, nestedDml(tokens) ?? dml);
  if (verb === 'PRAGMA') {
    // `PRAGMA x` reads, `PRAGMA x = y` and `PRAGMA x(y)` write.
    return tokens.some((t) => t.kind === 'punct' && (t.text === '=' || t.text === '(')) ? 'other' : 'select';
  }
  if (verb === 'EXPLAIN') {
    // EXPLAIN ANALYZE (also EXPLAIN (ANALYZE) and ANALYSE) runs the statement; a plain EXPLAIN does not.
    if (!tokens.some((t) => t.kind === 'word' && (t.text === 'ANALYZE' || t.text === 'ANALYSE'))) return 'select';
    const start = tokens.findIndex((t, i) => i > 0 && t.kind === 'word' && t.depth === 0 && EXPLAINED_STARTS.has(t.text));
    return start < 0 ? 'other' : tokensAction(tokens.slice(start));
  }
  if (verb === 'SELECT' || verb === 'WITH' || verb === 'VALUES' || verb === 'TABLE') {
    let action: SqlAction = 'select';
    const changed = nestedDml(tokens);
    if (changed) action = changed;
    else {
      // SELECT … INTO OUTFILE / DUMPFILE / @var writes a file or a variable; SELECT … INTO t creates a table.
      const into = tokens.findIndex((t) => t.kind === 'word' && t.text === 'INTO');
      if (into >= 0) {
        const target = tokens[into + 1];
        action = (target?.kind === 'word' && (target.text === 'OUTFILE' || target.text === 'DUMPFILE')) || (target?.kind === 'punct' && target.text === '@') ? 'other' : 'ddl';
      }
    }
    const calls = tokens.some((t, i) => t.kind === 'word' && WRITE_FUNCTIONS.has(t.text) && tokens[i + 1]?.kind === 'punct' && tokens[i + 1].text === '(');
    return calls ? worse(action, 'other') : action;
  }
  return READ_VERBS.has(verb) ? 'select' : 'other';
}

/**
 * The action of one statement. A read is `select`, whatever its verb; `WITH`, `MERGE` and `EXPLAIN ANALYZE` take the
 * most severe change they make. Read as each engine would read it (see `SqlLexing`); the most severe reading counts.
 */
export function statementAction(statement: string): SqlAction {
  return scriptAction(statement);
}

/** The action of a script: its most severe statement's (`ddl` beats `other` beats `delete`, and so on); `select` when empty. */
export function scriptAction(sql: string): SqlAction {
  // The whole text, as a server given all of it reads it, and each piece the drivers send, as the server reads that.
  const pieces = splitStatements(sql);
  const texts = pieces.length === 1 && pieces[0] === sql.trim() ? pieces : [sql, ...pieces];
  let worst: SqlAction = 'select';
  for (const lex of LEXINGS) {
    for (const text of texts) {
      for (const statement of tokenStatements(tokenizeSql(text, lex))) worst = worse(worst, tokensAction(statement));
    }
  }
  return worst;
}

/** What a batch of table edits does (`db.table.apply#delete`): the one kind they all have, or `mixed`. */
export type TableEditsAction = 'insert' | 'update' | 'delete' | 'mixed';

export const TABLE_EDITS_ACTIONS: readonly TableEditsAction[] = ['insert', 'update', 'delete', 'mixed'];

export function tableEditsAction(edits: readonly { kind: 'insert' | 'update' | 'delete' }[]): TableEditsAction {
  const kinds = new Set(edits.map((e) => e.kind));
  return kinds.size === 1 ? [...kinds][0] : 'mixed';
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

/**
 * The subcommands that only read, for the read commands that also have subcommands acting on the server: any other
 * subcommand (CLIENT KILL or UNBLOCK, DEBUG RELOAD, LOADAOF or PANIC, MEMORY PURGE, one added in a later Redis) writes.
 */
const REDIS_READ_SUBCOMMANDS: Record<string, Set<string>> = {
  CLIENT: new Set(['LIST', 'INFO', 'GETNAME', 'ID', 'GETREDIR', 'TRACKINGINFO', 'HELP']),
  MEMORY: new Set(['USAGE', 'STATS', 'DOCTOR', 'MALLOC-STATS', 'HELP']),
  DEBUG: new Set(['OBJECT', 'DIGEST', 'DIGEST-VALUE', 'HTSTATS', 'HTSTATS-KEY', 'SDSLEN', 'LISTPACK', 'QUICKLIST', 'HELP']),
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
  const reads = REDIS_READ_SUBCOMMANDS[cmd];
  return !reads || reads.has((argv[1] ?? '').toUpperCase());
}

export function redisScriptIsReadOnly(text: string): boolean {
  return parseRedisCommands(text).every(redisCommandIsReadOnly);
}

/** What a Redis command does, as an agent rule names it (`db.redis.command#admin`). */
export type RedisAction = 'read' | 'write' | 'admin';

export const REDIS_ACTIONS: readonly RedisAction[] = ['read', 'write', 'admin'];

export const REDIS_ACTION_DESCRIPTIONS: Record<RedisAction, string> = {
  read: 'Read-only commands: GET, HGETALL, SCAN, TTL, INFO…',
  write: 'Commands that change keys: SET, DEL, EXPIRE, HSET, LPUSH…',
  admin: 'Server-wide commands and scripts: FLUSHALL, FLUSHDB, CONFIG, SHUTDOWN, SAVE, ACL, SCRIPT, EVAL, FCALL, MODULE, REPLICAOF, CLIENT KILL…',
};

/** Commands that act on the whole server or every key, rather than on named keys. */
const REDIS_ADMIN_COMMANDS = new Set([
  'FLUSHALL', 'FLUSHDB', 'CONFIG', 'SHUTDOWN', 'SAVE', 'BGSAVE', 'BGREWRITEAOF', 'ACL', 'MODULE', 'SCRIPT', 'FUNCTION',
  'SLAVEOF', 'REPLICAOF', 'FAILOVER', 'CLUSTER', 'SWAPDB', 'MIGRATE', 'MONITOR', 'SYNC', 'PSYNC', 'SLOWLOG', 'LATENCY', 'RESET',
  // A script can call any command, FLUSHALL included.
  'EVAL', 'EVALSHA', 'EVAL_RO', 'EVALSHA_RO', 'FCALL', 'FCALL_RO',
]);

/** The action of one Redis command: `read` exactly when `redisCommandIsReadOnly`, else `admin` or `write`. */
export function redisCommandAction(argv: string[]): RedisAction {
  if (redisCommandIsReadOnly(argv)) return 'read';
  const cmd = (argv[0] ?? '').toUpperCase();
  // A read command made a write by its subcommand (CLIENT KILL, DEBUG RELOAD, MEMORY PURGE) acts on the server.
  if (REDIS_ADMIN_COMMANDS.has(cmd) || REDIS_READ_SUBCOMMANDS[cmd]) return 'admin';
  return 'write';
}

/** The action of several commands: `admin` beats `write` beats `read`. */
export function redisCommandsAction(commands: string[][]): RedisAction {
  const actions = new Set(commands.map(redisCommandAction));
  return actions.has('admin') ? 'admin' : actions.has('write') ? 'write' : 'read';
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
