import { describe, expect, it } from 'vitest';
import { tokenizeShell } from './curl';
import { findRedisCommand, REDIS_COMMANDS, REDIS_CONTAINER_COMMANDS, redisSignature, redisSubcommands } from './redis-commands';
import { collectRedisKeys, escapeRedisGlob, quoteRedisArgument, redisCompletionContext, redisPrefixPattern, tokenizeRedisLine, type RedisScanPage } from './redis-completion';
import { REDIS_READ_COMMAND_NAMES } from './sql';

/** The context with the cursor at `|`. */
function at(textWithCursor: string) {
  const offset = textWithCursor.indexOf('|');
  return redisCompletionContext(textWithCursor.replace('|', ''), offset);
}

describe('REDIS_COMMANDS', () => {
  it('names each command once, in upper case', () => {
    const names = REDIS_COMMANDS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toBe(name.toUpperCase());
  });

  it('knows every command the read-only classifier knows', () => {
    const known = (name: string) => REDIS_COMMANDS.some((c) => c.name === name) || REDIS_CONTAINER_COMMANDS.has(name);
    expect([...REDIS_READ_COMMAND_NAMES].filter((name) => !known(name))).toEqual([]);
  });

  it('finds one- and two-word commands case-insensitively', () => {
    expect(findRedisCommand(['get', 'k'])?.spec.name).toBe('GET');
    expect(findRedisCommand(['client', 'list'])).toMatchObject({ spec: { name: 'CLIENT LIST' }, words: 2 });
    expect(findRedisCommand(['xinfo', 'Stream', 'k'])?.spec.name).toBe('XINFO STREAM');
    expect(findRedisCommand(['client'])).toBeNull();
    expect(findRedisCommand(['nope'])).toBeNull();
    expect(redisSubcommands('config').map((c) => c.name)).toContain('CONFIG GET');
    expect(redisSignature(findRedisCommand(['GET'])!.spec)).toBe('GET key');
  });
});

describe('tokenizeRedisLine', () => {
  it('splits as tokenizeShell does, with offsets', () => {
    const line = `SET "a b" 'c"d' e\\ f "x\\"y"`;
    const { tokens, openQuote } = tokenizeRedisLine(line);
    expect(tokens.map((t) => t.value)).toEqual(tokenizeShell(line));
    expect(tokens.map((t) => line.slice(t.from, t.to))).toEqual(['SET', '"a b"', `'c"d'`, 'e\\ f', '"x\\"y"']);
    expect(openQuote).toBeNull();
  });

  it('reports a quote left open', () => {
    expect(tokenizeRedisLine('GET "user:')).toMatchObject({ tokens: [{ value: 'GET' }, { value: 'user:', from: 4 }], openQuote: '"' });
    expect(tokenizeRedisLine(`GET ''`).tokens[1]).toEqual({ value: '', from: 4, to: 6 });
  });
});

describe('redisCompletionContext', () => {
  it('completes the command name at the start of a line', () => {
    expect(at('hg|')).toMatchObject({ kind: 'command', from: 0, prefix: 'hg' });
    expect(at('|')).toMatchObject({ kind: 'command', from: 0, prefix: '' });
    expect(at('GET a\n  ze|')).toMatchObject({ kind: 'command', from: 8, prefix: 'ze' });
  });

  it('completes subcommands after a container command', () => {
    expect(at('client l|')).toMatchObject({ kind: 'subcommand', container: 'CLIENT', prefix: 'l', from: 7 });
    expect(at('CONFIG |')).toMatchObject({ kind: 'subcommand', container: 'CONFIG', prefix: '' });
  });

  it('completes keys in key positions only', () => {
    expect(at('GET us|')).toMatchObject({ kind: 'key', prefix: 'us', from: 4, command: { name: 'GET' }, args: [] });
    expect(at('get |')).toMatchObject({ kind: 'key', prefix: '', from: 4 });
    expect(at('SET k |')).toMatchObject({ kind: 'argument', command: { name: 'SET' }, args: ['k'] });
    expect(at('MGET a b |')).toMatchObject({ kind: 'key' });
    expect(at('MSET a 1 |')).toMatchObject({ kind: 'key' });
    expect(at('MSET a 1 b |')).toMatchObject({ kind: 'argument' });
    expect(at('HGET h |')).toMatchObject({ kind: 'argument' });
    expect(at('XINFO STREAM s|')).toMatchObject({ kind: 'key', command: { name: 'XINFO STREAM' }, prefix: 's' });
    expect(at('MEMORY USAGE |')).toMatchObject({ kind: 'key' });
    expect(at('BOGUS |')).toMatchObject({ kind: 'argument', command: null });
    expect(at('PING |')).toMatchObject({ kind: 'argument' });
  });

  it('reads numkeys and keyword key positions', () => {
    expect(at('EVAL "return 1" |')).toMatchObject({ kind: 'argument' });
    expect(at('EVAL "return 1" 2 |')).toMatchObject({ kind: 'key' });
    expect(at('EVAL "return 1" 2 a |')).toMatchObject({ kind: 'key' });
    expect(at('EVAL "return 1" 2 a b |')).toMatchObject({ kind: 'argument' });
    expect(at('ZUNIONSTORE |')).toMatchObject({ kind: 'key' });
    expect(at('ZUNIONSTORE d |')).toMatchObject({ kind: 'argument' });
    expect(at('ZUNIONSTORE d 1 |')).toMatchObject({ kind: 'key' });
    expect(at('XREAD COUNT 2 |')).toMatchObject({ kind: 'argument' });
    expect(at('XREAD COUNT 2 STREAMS |')).toMatchObject({ kind: 'key' });
    expect(at('BITOP AND |')).toMatchObject({ kind: 'key' });
    expect(at('BITOP |')).toMatchObject({ kind: 'argument' });
  });

  it('reads quoted words and keeps the opening quote in the range', () => {
    expect(at('GET "user:|')).toMatchObject({ kind: 'key', from: 4, prefix: 'user:', quote: '"' });
    expect(at(`GET 'a b|`)).toMatchObject({ kind: 'key', prefix: 'a b', quote: "'" });
    expect(at('SET "a b" |')).toMatchObject({ kind: 'argument', args: ['a b'] });
    expect(at('GET a\\ b|')).toMatchObject({ kind: 'key', prefix: 'a b', from: 4, quote: null });
  });

  it('looks at the line of the cursor only, and not into comments', () => {
    expect(at('SET a 1\nGET |\nDEL b')).toMatchObject({ kind: 'key', from: 12 });
    expect(at('GET a\r\nGET b|')).toMatchObject({ kind: 'key', prefix: 'b' });
    expect(at('# GET |')).toBeNull();
    expect(at('  #x|')).toBeNull();
  });
});

describe('escaping', () => {
  it('escapes the glob characters of SCAN MATCH', () => {
    expect(escapeRedisGlob('a*b?c[d]e\\f')).toBe('a\\*b\\?c\\[d\\]e\\\\f');
    expect(redisPrefixPattern('user:')).toBe('user:*');
    expect(redisPrefixPattern('')).toBe('*');
  });

  it('quotes a key only when it needs it, the way the console reads it back', () => {
    expect(quoteRedisArgument('user:1')).toBe('user:1');
    for (const key of ['a b', 'say "hi"', "it's", 'back\\slash', '']) {
      expect(tokenizeShell(`GET ${quoteRedisArgument(key)}`)).toEqual(['GET', key]);
    }
  });
});

describe('collectRedisKeys', () => {
  /** A keyspace scanned `perPage` keys a call, matching like Redis would for a prefix pattern. */
  function scanner(keys: string[], perPage: number) {
    const calls: { cursor: string; pattern: string }[] = [];
    const scan = async (cursor: string, pattern: string, _count?: number): Promise<RedisScanPage> => {
      calls.push({ cursor, pattern });
      const start = Number(cursor);
      const prefix = pattern.slice(0, -1).replace(/\\(.)/g, '$1');
      const page = keys.slice(start, start + perPage).filter((k) => k.startsWith(prefix));
      const next = start + perPage >= keys.length ? '0' : String(start + perPage);
      return { cursor: next, keys: page };
    };
    return { scan, calls };
  }

  it('scans to the end and says so', async () => {
    const { scan, calls } = scanner(['user:2', 'user:1', 'order:1', 'user:1'], 2);
    expect(await collectRedisKeys(scan, 'user:', { limit: 10, maxCalls: 10, count: 2 })).toEqual({ keys: ['user:1', 'user:2'], complete: true });
    expect(calls).toEqual([{ cursor: '0', pattern: 'user:*' }, { cursor: '2', pattern: 'user:*' }]);
  });

  it('stops at the limit', async () => {
    const keys = Array.from({ length: 50 }, (_, i) => `k:${String(i).padStart(2, '0')}`);
    const { scan } = scanner(keys, 10);
    const out = await collectRedisKeys(scan, 'k:', { limit: 15, maxCalls: 100, count: 10 });
    expect(out.keys).toHaveLength(15);
    expect(out.complete).toBe(false);
  });

  it('stops after maxCalls, so few matches in a huge keyspace never stall', async () => {
    const keys = Array.from({ length: 1000 }, (_, i) => `other:${i}`);
    const { scan, calls } = scanner(keys, 10);
    expect(await collectRedisKeys(scan, 'user:', { limit: 10, maxCalls: 5, count: 10 })).toEqual({ keys: [], complete: false });
    expect(calls).toHaveLength(5);
  });

  it('stops after the time budget', async () => {
    let t = 0;
    const { scan, calls } = scanner(Array.from({ length: 100 }, (_, i) => `x${i}`), 1);
    await collectRedisKeys(async (c, p, n) => ((t += 40), scan(c, p, n)), 'x', { limit: 1000, maxCalls: 1000, count: 1, budgetMs: 100, now: () => t });
    expect(calls).toHaveLength(3);
  });

  it('escapes glob characters of the prefix', async () => {
    const { scan, calls } = scanner(['a*b', 'axb'], 10);
    expect((await collectRedisKeys(scan, 'a*', { limit: 10, maxCalls: 1, count: 10 })).keys).toEqual(['a*b']);
    expect(calls[0]!.pattern).toBe('a\\**');
  });
});
