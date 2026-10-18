import { describe, expect, it } from 'vitest';
import {
  formatRedisCliReply,
  grafanaFrameColumns,
  grafanaRedisRefusal,
  parseRedisCliReply,
  quoteRedisCliArg,
  redisCliLine,
  redisCliTextFromFrames,
  redisInfoFromText,
  splitRedisCliLine,
  type RedisCliValue,
} from './grafana-redis';
import { DbConnectionSchema, dbAccessProblem, newDbConnection, resolveConnectionTemplate } from './models/db';

describe('redisCliLine', () => {
  it('leaves plain words bare and single-quotes the rest', () => {
    expect(redisCliLine(['GET', 'user:1'])).toBe('GET user:1');
    expect(quoteRedisCliArg('')).toBe("''");
    expect(quoteRedisCliArg('hello world')).toBe("'hello world'");
    expect(quoteRedisCliArg("it's")).toBe("'it'\\''s'");
    expect(quoteRedisCliArg('user:*')).toBe("'user:*'");
  });

  it('carries every argument through the plugin splitter unchanged', () => {
    const tricky = ['SET', 'k', 'line one\nline "two"', "it's", '', 'a\tb', 'back\\slash', '$HOME', '  padded  ', '\r\n', 'ü 🙂', "'\"'"];
    expect(splitRedisCliLine(redisCliLine(tricky))).toEqual(tricky);
  });

  it('refuses an argument Grafana would alter and an empty command', () => {
    expect(() => redisCliLine(['SET', 'k', 'broken \uD800 half'])).toThrow(/lone UTF-16 surrogate/);
    expect(() => redisCliLine([])).toThrow(/Enter a Redis command/);
    expect(redisCliLine(['SET', 'k', 'pair 🙂'])).toBe("SET k 'pair 🙂'");
  });
});

describe('splitRedisCliLine', () => {
  it('reads quotes and backslashes the way creachadair/shell does', () => {
    expect(splitRedisCliLine(`SET a "b \\"c\\" \\d" 'e f'`)).toEqual(['SET', 'a', 'b "c" \\d', 'e f']);
    expect(splitRedisCliLine('GET a\\ b')).toEqual(['GET', 'a b']);
    expect(splitRedisCliLine("GET 'open")).toBeNull();
  });
});

describe('parseRedisCliReply', () => {
  it('reads the scalar replies', () => {
    expect(parseRedisCliReply('"OK"\n')).toBe('OK');
    expect(parseRedisCliReply('"007"\n')).toBe('007');
    expect(parseRedisCliReply('(integer) -2\n')).toBe(-2);
    expect(parseRedisCliReply('(nil)\n')).toBeNull();
    expect(parseRedisCliReply('(empty array)\n')).toEqual([]);
    expect(parseRedisCliReply('""\n')).toBe('');
  });

  it('reads a string with quotes and line breaks whole', () => {
    expect(parseRedisCliReply('"line one\nline "two""\n')).toBe('line one\nline "two"');
    expect(parseRedisCliReply('"# Server\r\nredis_version:7.2.0\r\n"\n')).toBe('# Server\r\nredis_version:7.2.0\r\n');
  });

  it('reads arrays as the tabwriter aligns them', () => {
    // SCAN as the plugin prints it: the nested array's first element shares the line of its index.
    expect(parseRedisCliReply('1) "17"\n2) 1) "user:1"\n   2) "user:2"\n')).toEqual(['17', ['user:1', 'user:2']]);
    expect(parseRedisCliReply('1) "0"\n2) (empty array)\n')).toEqual(['0', []]);
    expect(parseRedisCliReply('1) "a"\n2) (nil)\n3) (integer) 4\n')).toEqual(['a', null, 4]);
  });

  it('matches the formatter for nested, long and multi-line replies', () => {
    const samples: RedisCliValue[] = [
      ['0', ['k1', 'k2', 'k3']],
      Array.from({ length: 12 }, (_, i) => `item ${i + 1}`),
      [
        ['1700000000000-0', ['field', 'value', 'other', 'x']],
        ['1700000000001-0', ['field', 'second']],
      ],
      [['a', ['b', ['c']]], 'd', [], null, 7],
      ['first', 'two\nlines', 'after'],
      Array.from({ length: 11 }, (_, i) => (i === 4 ? 'multi\nline' : `v${i}`)),
      '',
      'it said "hi"',
    ];
    for (const value of samples) expect(parseRedisCliReply(formatRedisCliReply(value))).toEqual(value);
  });

  it('pads indexes from ten on to the right', () => {
    const text = formatRedisCliReply(Array.from({ length: 10 }, (_, i) => String(i)));
    expect(text.split('\n')[0]).toBe(' 1) "0"');
    expect(text.split('\n')[9]).toBe('10) "9"');
  });

  it('says what it could not read', () => {
    expect(() => parseRedisCliReply('something else')).toThrow(/Could not read the reply/);
    expect(() => parseRedisCliReply('"unterminated\n')).toThrow(/unterminated/);
    expect(() => parseRedisCliReply('2) "x"\n')).toThrow(/not starting at 1/);
  });
});

describe('frames', () => {
  it('takes the CLI text from the Value field', () => {
    expect(redisCliTextFromFrames([{ schema: { fields: [{ name: 'Value', type: 'string' }] }, data: { values: [['"PONG"\n']] } }])).toBe('"PONG"\n');
    expect(() => redisCliTextFromFrames([])).toThrow(/without the CLI reply/);
    const cols = grafanaFrameColumns({ schema: { fields: [{ name: 'key' }, { name: 'type' }] }, data: { values: [['a'], ['hash']] } });
    expect(cols.get('type')).toEqual(['hash']);
  });
});

describe('grafanaRedisRefusal', () => {
  it('refuses commands that need a connection of their own', () => {
    expect(grafanaRedisRefusal(['select', '2'])).toMatch(/SELECT cannot run through Grafana.*address picks the database/);
    expect(grafanaRedisRefusal(['MULTI'])).toMatch(/MULTI/);
    expect(grafanaRedisRefusal(['CLIENT', 'setname', 'x'])).toMatch(/CLIENT SETNAME/);
    expect(grafanaRedisRefusal(['CLIENT', 'LIST'])).toBeNull();
    expect(grafanaRedisRefusal(['GET', 'k'])).toBeNull();
  });
});

describe('redisInfoFromText', () => {
  it('boils INFO down to the strip', () => {
    const info = redisInfoFromText('# Server\r\nredis_version:7.2.0\r\nuptime_in_seconds:10\r\n# Stats\r\nkeyspace_hits:9\r\nkeyspace_misses:1\r\n', 5);
    expect(info).toMatchObject({ version: '7.2.0', uptimeSeconds: 10, keys: 5, hitRate: 0.9, role: null });
  });
});

describe('grafana access', () => {
  it('parses with defaults and is Redis only', () => {
    const conn = DbConnectionSchema.parse({ id: 'x', name: 'n', kind: 'redis', createdAt: 't', updatedAt: 't', access: { type: 'grafana', grafanaUrl: 'https://g', datasourceUid: 'u' } });
    expect(conn.access).toEqual({ type: 'grafana', grafanaUrl: 'https://g', datasourceUid: 'u', datasourceName: '' });
    expect(dbAccessProblem(conn)).toBeNull();
    expect(dbAccessProblem({ ...conn, kind: 'postgres' })).toMatch(/only reach Redis, not PostgreSQL/);
    expect(dbAccessProblem({ ...conn, dbIndex: 2 })).toMatch(/leave the database index at 0/);
  });

  it('resolves variables in the Grafana address', () => {
    const conn = newDbConnection('redis', { access: { type: 'grafana', grafanaUrl: 'https://{{GRAFANA}}', datasourceUid: 'u', datasourceName: 'n' } });
    expect(resolveConnectionTemplate(conn, { GRAFANA: 'grafana.example.com' }).access).toMatchObject({ grafanaUrl: 'https://grafana.example.com', datasourceUid: 'u' });
  });
});
