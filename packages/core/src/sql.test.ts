import { describe, expect, it } from 'vitest';
import { classifyStatement, parseRedisCommands, redisCommandIsReadOnly, scriptIsReadOnly, splitStatements, stripComments } from './sql';

describe('splitStatements', () => {
  it('splits on semicolons outside strings and comments', () => {
    const script = `SELECT 'a;b' AS x; -- trailing; comment
      INSERT INTO t VALUES ("q;q"); /* block; comment */ SELECT 2`;
    expect(splitStatements(script)).toEqual([`SELECT 'a;b' AS x`, `-- trailing; comment
      INSERT INTO t VALUES ("q;q")`, `/* block; comment */ SELECT 2`]);
  });

  it('keeps trigger bodies together', () => {
    const script = `CREATE TRIGGER tr AFTER INSERT ON t BEGIN UPDATE t SET a = 1; DELETE FROM u; END; SELECT 1;`;
    const parts = splitStatements(script);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatch(/^CREATE TRIGGER[\s\S]*END$/);
    expect(parts[1]).toBe('SELECT 1');
  });

  it('drops blank and comment-only fragments', () => {
    expect(splitStatements(`;; -- nothing\n; SELECT 1;;`)).toEqual(['SELECT 1']);
  });

  it('handles escaped quotes', () => {
    expect(splitStatements(`SELECT 'it''s; here'; SELECT "a\\"; b"`)).toEqual([`SELECT 'it''s; here'`, `SELECT "a\\"; b"`]);
  });
});

describe('stripComments', () => {
  it('leaves strings alone', () => {
    expect(stripComments(`SELECT '-- not a comment' -- real\nFROM t`)).toBe(`SELECT '-- not a comment'  \nFROM t`);
  });
});

describe('classifyStatement', () => {
  const ro = (s: string) => classifyStatement(s).readOnly;
  it('recognises reads', () => {
    expect(ro('SELECT * FROM t')).toBe(true);
    expect(ro('  /* c */ select 1;')).toBe(true);
    expect(ro('SHOW TABLES')).toBe(true);
    expect(ro('DESCRIBE t')).toBe(true);
    expect(ro('EXPLAIN SELECT 1')).toBe(true);
    expect(ro('PRAGMA table_info(t)')).toBe(false);
    expect(ro('PRAGMA foreign_keys')).toBe(true);
    expect(ro('WITH x AS (INSERT INTO a VALUES (1)) SELECT * FROM x')).toBe(true);
    expect(ro('USE db')).toBe(true);
  });
  it('recognises writes', () => {
    expect(ro('INSERT INTO t VALUES (1)')).toBe(false);
    expect(ro('UPDATE t SET a = 1')).toBe(false);
    expect(ro('delete from t')).toBe(false);
    expect(ro('DROP TABLE t')).toBe(false);
    expect(ro('WITH x AS (SELECT 1) DELETE FROM t WHERE a IN (SELECT * FROM x)')).toBe(false);
    expect(ro('PRAGMA foreign_keys = ON')).toBe(false);
    expect(ro("SELECT * FROM t INTO OUTFILE '/tmp/x'")).toBe(false);
    expect(ro('CALL proc()')).toBe(false);
    expect(ro('SET @a = 1')).toBe(false);
  });
  it('reports the verb', () => {
    expect(classifyStatement('WITH a AS (SELECT 1) UPDATE t SET x = 1').verb).toBe('UPDATE');
    expect(classifyStatement('').verb).toBe('');
  });
});

describe('scriptIsReadOnly', () => {
  it('requires every statement to be read-only', () => {
    expect(scriptIsReadOnly('SELECT 1; SELECT 2')).toBe(true);
    expect(scriptIsReadOnly('SELECT 1; DELETE FROM t')).toBe(false);
  });
});

describe('redis', () => {
  it('parses command lines with quoting', () => {
    expect(parseRedisCommands(`SET "my key" 'v 1'\n# comment\n\nHGETALL h`)).toEqual([['SET', 'my key', 'v 1'], ['HGETALL', 'h']]);
  });
  it('classifies commands', () => {
    expect(redisCommandIsReadOnly(['get', 'k'])).toBe(true);
    expect(redisCommandIsReadOnly(['SCAN', '0'])).toBe(true);
    expect(redisCommandIsReadOnly(['SET', 'k', 'v'])).toBe(false);
    expect(redisCommandIsReadOnly(['FLUSHALL'])).toBe(false);
    expect(redisCommandIsReadOnly(['CLIENT', 'LIST'])).toBe(true);
    expect(redisCommandIsReadOnly(['CLIENT', 'KILL', 'x'])).toBe(false);
  });
});
