import { tokenizeShell } from './curl';

/**
 * Split a script into individual statements. Understands single/double/backtick quotes,
 * `--`, `#` and block comments, and keeps `CREATE TRIGGER ... BEGIN ... END` bodies intact.
 * Statements come back trimmed, with comments preserved (drivers ignore them).
 */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: string | null = null;
  let inTrigger = false;
  let lastWord = '';
  let word = '';

  const flushWord = () => {
    if (!word) return;
    const upper = word.toUpperCase();
    if (!inTrigger && upper === 'TRIGGER' && /\bCREATE\b/i.test(current)) inTrigger = true;
    lastWord = upper;
    word = '';
  };
  const push = () => {
    const text = current.trim();
    if (text && !/^[\s;]*$/.test(text) && !isOnlyComments(text)) out.push(text);
    current = '';
    inTrigger = false;
    lastWord = '';
  };

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (quote) {
      current += ch;
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

    if (ch === '-' && next === '-') {
      flushWord();
      const end = sql.indexOf('\n', i);
      current += end < 0 ? sql.slice(i) : sql.slice(i, end);
      i = end < 0 ? sql.length : end - 1;
      continue;
    }
    if (ch === '#') {
      flushWord();
      const end = sql.indexOf('\n', i);
      current += end < 0 ? sql.slice(i) : sql.slice(i, end);
      i = end < 0 ? sql.length : end - 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      flushWord();
      const end = sql.indexOf('*/', i + 2);
      current += end < 0 ? sql.slice(i) : sql.slice(i, end + 2);
      i = end < 0 ? sql.length : end + 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      flushWord();
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ';') {
      flushWord();
      if (inTrigger && lastWord !== 'END') {
        current += ch;
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
    current += ch;
  }
  flushWord();
  push();
  return out;
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

// ---------- identifiers ----------

export function quoteIdentifier(kind: 'mysql' | 'sqlite', name: string): string {
  if (kind === 'mysql') return `\`${name.replace(/`/g, '``')}\``;
  return `"${name.replace(/"/g, '""')}"`;
}

export function qualifiedName(kind: 'mysql' | 'sqlite', table: string, database?: string | null): string {
  const t = quoteIdentifier(kind, table);
  return database ? `${quoteIdentifier(kind, database)}.${t}` : t;
}
