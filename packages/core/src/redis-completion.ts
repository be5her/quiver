import { findRedisCommand, REDIS_CONTAINER_COMMANDS, type RedisCommandSpec, type RedisKeySpec } from './redis-commands';

/**
 * What the Redis console completes at the cursor. The console runs one command per line, split as
 * `tokenizeShell` splits it (single quotes literal, double quotes with backslash escapes, a backslash
 * outside quotes escaping the next character), and a line starting with `#` is a comment.
 */

export interface RedisLineToken {
  /** The word with quotes and escapes removed. */
  value: string;
  /** Offsets in the line: where the word starts (an opening quote included) and ends. */
  from: number;
  to: number;
}

export interface RedisPartialLine {
  tokens: RedisLineToken[];
  /** The quote left open at the end of the text, if any: the last token is still being typed inside it. */
  openQuote: '"' | "'" | null;
}

/** Split one console line, possibly cut off at the cursor, into words with their offsets. */
export function tokenizeRedisLine(line: string): RedisPartialLine {
  const tokens: RedisLineToken[] = [];
  let quote: '"' | "'" | null = null;
  let value = '';
  let start = -1;
  const begin = (i: number) => {
    if (start < 0) start = i;
  };
  const end = (i: number) => {
    if (start >= 0) tokens.push({ value, from: start, to: i });
    value = '';
    start = -1;
  };
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < line.length) value += line[++i];
      else value += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      begin(i);
      quote = ch;
      continue;
    }
    if (ch === '\\') {
      if (i + 1 < line.length) {
        begin(i);
        value += line[++i];
      }
      continue;
    }
    if (/\s/.test(ch)) {
      end(i);
      continue;
    }
    begin(i);
    value += ch;
  }
  end(line.length);
  return { tokens, openQuote: quote };
}

/** Whether the argument after `before` (the arguments after the command's name) is a key. */
export function isRedisKeyArgument(spec: RedisCommandSpec, before: readonly string[]): boolean {
  return keyAt(spec.keys, before);
}

function keyAt(keys: RedisKeySpec | undefined, before: readonly string[]): boolean {
  if (!keys) return false;
  const index = before.length;
  if ('range' in keys) {
    const { first, last, step } = keys.range;
    return index >= first && (last < 0 || index <= last) && (index - first) % step === 0;
  }
  if ('numkeys' in keys) {
    const { at, extra = 0 } = keys.numkeys;
    if (index < extra) return true;
    if (index <= at) return false;
    const count = Number(before[at]);
    return Number.isInteger(count) && index <= at + count;
  }
  const keyword = before.findIndex((a) => a.toUpperCase() === keys.after);
  return keyword >= 0 && index > keyword;
}

export type RedisCompletionKind = 'command' | 'subcommand' | 'key' | 'argument';

export interface RedisCompletionContext {
  kind: RedisCompletionKind;
  /** Where the word being typed starts in the text (its opening quote included); the cursor when none is. */
  from: number;
  /** The word typed so far, quotes and escapes removed. */
  prefix: string;
  /** The quote the word is open in. */
  quote: '"' | "'" | null;
  /** The command of the line, once its name is typed and known. */
  command: RedisCommandSpec | null;
  /** For `subcommand`: the first word (CLIENT, CONFIG…). */
  container: string | null;
  /** The arguments before the one being typed, after the command's name. */
  args: string[];
}

/** What to complete at `offset` of the console text, or null inside a comment. */
export function redisCompletionContext(text: string, offset: number): RedisCompletionContext | null {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  const line = text.slice(lineStart, offset).replace(/\r$/, '');
  if (line.trimStart().startsWith('#')) return null;
  const { tokens, openQuote } = tokenizeRedisLine(line);
  const last = tokens[tokens.length - 1];
  // The cursor is in a word when the last one runs up to it, or a quote is still open.
  const typing = last && (openQuote !== null || last.to === line.length) ? last : null;
  const before = (typing ? tokens.slice(0, -1) : tokens).map((t) => t.value);
  const base = {
    from: lineStart + (typing ? typing.from : line.length),
    prefix: typing?.value ?? '',
    quote: typing ? openQuote : null,
  };
  if (before.length === 0) return { ...base, kind: 'command', command: null, container: null, args: [] };
  const head = before[0]!.toUpperCase();
  if (before.length === 1 && REDIS_CONTAINER_COMMANDS.has(head)) return { ...base, kind: 'subcommand', command: null, container: head, args: [] };
  const found = findRedisCommand(before);
  if (!found) return { ...base, kind: 'argument', command: null, container: null, args: before.slice(1) };
  const args = before.slice(found.words);
  return { ...base, kind: isRedisKeyArgument(found.spec, args) ? 'key' : 'argument', command: found.spec, container: null, args };
}

/** `prefix` with the glob characters SCAN MATCH reads (`* ? [ ] \`) escaped, so it matches only itself. */
export function escapeRedisGlob(prefix: string): string {
  return prefix.replace(/[*?[\]\\]/g, '\\$&');
}

/** The SCAN MATCH pattern for keys starting with `prefix`. */
export function redisPrefixPattern(prefix: string): string {
  return `${escapeRedisGlob(prefix)}*`;
}

/** A value as one console word: bare when it needs no quoting, else double-quoted with `"` and `\` escaped. */
export function quoteRedisArgument(value: string): string {
  return value !== '' && /^[^\s"'\\]+$/.test(value) ? value : `"${value.replace(/["\\]/g, '\\$&')}"`;
}

export interface RedisScanPage {
  cursor: string;
  keys: string[];
}

export interface CollectRedisKeysOptions {
  /** Keys returned at most. */
  limit: number;
  /** SCAN calls at most, so a huge keyspace with few matches never stalls. */
  maxCalls: number;
  /** The COUNT hint of each SCAN. */
  count: number;
  /** Stop starting new SCAN calls after this many milliseconds. */
  budgetMs?: number;
  now?: () => number;
}

export interface RedisKeySuggestions {
  /** Sorted, each once. */
  keys: string[];
  /** True when the keyspace was scanned to the end and every match is in `keys`. */
  complete: boolean;
}

/** Keys starting with `prefix`, by SCAN MATCH a page at a time, bounded by `limit`, `maxCalls` and `budgetMs`. */
export async function collectRedisKeys(scan: (cursor: string, pattern: string, count: number) => Promise<RedisScanPage>, prefix: string, options: CollectRedisKeysOptions): Promise<RedisKeySuggestions> {
  const now = options.now ?? Date.now;
  const started = now();
  const pattern = redisPrefixPattern(prefix);
  const found = new Set<string>();
  let cursor = '0';
  let calls = 0;
  do {
    const page = await scan(cursor, pattern, options.count);
    calls++;
    cursor = String(page.cursor);
    for (const key of page.keys) if (key.startsWith(prefix)) found.add(key);
  } while (cursor !== '0' && found.size < options.limit && calls < options.maxCalls && (options.budgetMs === undefined || now() - started < options.budgetMs));
  const keys = [...found].sort();
  return { keys: keys.slice(0, options.limit), complete: cursor === '0' && keys.length <= options.limit };
}
