import { describe, expect, it } from 'vitest';
import { SQL_ACTIONS, buildTableEdits, classifyStatement, coerceCellInput, isSelectLike, parseRedisCommands, redisCommandAction, redisCommandIsReadOnly, redisCommandsAction, scriptAction, scriptIsReadOnly, splitStatementRanges, splitStatements, sqlLiteral, statementAction, statementAt, stripComments, tableEditsAction, wrapForPage } from './sql';

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

describe('splitStatementRanges and statementAt', () => {
  const script = `SELECT 1;

  -- second
  SELECT 'a;b';
INSERT INTO t VALUES (1)`;
  it('reports where each statement sits', () => {
    const ranges = splitStatementRanges(script);
    expect(ranges.map((r) => r.text)).toEqual(['SELECT 1', `-- second
  SELECT 'a;b'`, 'INSERT INTO t VALUES (1)']);
    for (const r of ranges) expect(script.slice(r.from, r.to)).toBe(r.text);
  });
  it('picks the statement under the cursor, or the one before the whitespace the cursor is in', () => {
    expect(statementAt(script, 3)?.text).toBe('SELECT 1');
    expect(statementAt(script, 10)?.text).toBe('SELECT 1');
    expect(statementAt(script, script.indexOf("'a;b'"))?.text).toContain("SELECT 'a;b'");
    expect(statementAt(script, script.length)?.text).toBe('INSERT INTO t VALUES (1)');
    expect(statementAt('   ', 1)).toBeNull();
  });
});

describe('sqlLiteral and buildTableEdits', () => {
  it('quotes per dialect', () => {
    expect(sqlLiteral('mysql', "it's a \\ path")).toBe("'it''s a \\\\ path'");
    expect(sqlLiteral('postgres', "it's")).toBe("'it''s'");
    expect(sqlLiteral('sqlite', null)).toBe('NULL');
    expect(sqlLiteral('sqlite', true)).toBe('1');
    expect(sqlLiteral('postgres', false)).toBe('FALSE');
    expect(sqlLiteral('mysql', 12)).toBe('12');
    expect(sqlLiteral('mysql', { a: 1 })).toBe(`'{"a":1}'`);
    expect(sqlLiteral('mysql', { $bytes: 2, hex: 'abcd' })).toBe("X'abcd'");
    expect(sqlLiteral('mysql', { $bytes: 200, hex: 'ab' })).toBe('NULL');
  });
  it('builds insert, update and delete statements with the key in the WHERE clause', () => {
    const statements = buildTableEdits('mysql', 'users', 'app', [
      { kind: 'insert', values: { name: 'Ada', age: 36 } },
      { kind: 'update', key: { id: 1 }, values: { name: "O'Hara", nick: null } },
      { kind: 'update', key: { id: 2 }, values: {} },
      { kind: 'delete', key: { id: 3, tenant: null } },
      { kind: 'insert', values: {} },
    ]);
    expect(statements).toEqual([
      "INSERT INTO `app`.`users` (`name`, `age`) VALUES ('Ada', 36)",
      "UPDATE `app`.`users` SET `name` = 'O''Hara', `nick` = NULL WHERE `id` = 1",
      'DELETE FROM `app`.`users` WHERE `id` = 3 AND `tenant` IS NULL',
      'INSERT INTO `app`.`users` () VALUES ()',
    ]);
    expect(buildTableEdits('sqlite', 't', null, [{ kind: 'insert', values: {} }])).toEqual(['INSERT INTO "t" DEFAULT VALUES']);
  });
  it('refuses an edit without a key', () => {
    expect(() => buildTableEdits('sqlite', 't', null, [{ kind: 'delete', key: {} }])).toThrow(/no primary key/);
  });
});

describe('coerceCellInput', () => {
  it('turns typed text into the column type', () => {
    expect(coerceCellInput('42', 'int(11)')).toBe(42);
    expect(coerceCellInput('12345678901234567890', 'bigint')).toBe('12345678901234567890');
    expect(coerceCellInput('abc', 'int')).toBe('abc');
    expect(coerceCellInput('true', 'boolean')).toBe(true);
    expect(coerceCellInput('0', 'bool')).toBe(false);
    expect(coerceCellInput('42', 'varchar(10)')).toBe('42');
  });
});

describe('wrapForPage and isSelectLike', () => {
  it('wraps a select as a page', () => {
    expect(wrapForPage('SELECT * FROM t ORDER BY id; -- x', 500, 500)).toBe('SELECT * FROM (SELECT * FROM t ORDER BY id) AS q LIMIT 500 OFFSET 500');
  });
  it('tells selects from the rest', () => {
    expect(isSelectLike('SELECT 1')).toBe(true);
    expect(isSelectLike('WITH x AS (SELECT 1) SELECT * FROM x')).toBe(true);
    expect(isSelectLike('SHOW TABLES')).toBe(false);
    expect(isSelectLike('UPDATE t SET a = 1')).toBe(false);
  });
});

describe('actions for agent rules', () => {
  it('names the action of one statement', () => {
    const cases: [string, string][] = [
      ['SELECT 1', 'select'],
      ['show tables', 'select'],
      ['EXPLAIN SELECT * FROM t', 'select'],
      ['WITH x AS (SELECT 1) SELECT * FROM x', 'select'],
      ['PRAGMA table_info(t)', 'other'],
      ['PRAGMA foreign_keys', 'select'],
      ['INSERT INTO t VALUES (1)', 'insert'],
      ['replace into t values (1)', 'insert'],
      ['WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x', 'insert'],
      ['UPDATE t SET a = 1', 'update'],
      ['MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN UPDATE SET a = 1', 'update'],
      ['DELETE FROM t', 'delete'],
      ['WITH old AS (SELECT id FROM t) DELETE FROM t WHERE id IN (SELECT id FROM old)', 'delete'],
      ['EXPLAIN ANALYZE DELETE FROM t', 'delete'],
      ['CREATE TABLE t (id int)', 'ddl'],
      ['/* c */ drop table t', 'ddl'],
      ['ALTER TABLE t ADD c int', 'ddl'],
      ['TRUNCATE t', 'ddl'],
      ['GRANT SELECT ON t TO u', 'ddl'],
      ['SET search_path = x', 'other'],
      ['CALL p()', 'other'],
      ['SELECT * INTO OUTFILE "/tmp/x" FROM t', 'other'],
      ['VACUUM', 'other'],
    ];
    expect(cases.map(([sql]) => [sql, statementAction(sql)])).toEqual(cases);
  });

  it('gives a script its most severe action, and select exactly when it is read-only', () => {
    expect(scriptAction('SELECT 1; INSERT INTO t VALUES (1)')).toBe('insert');
    expect(scriptAction('INSERT INTO t VALUES (1); DELETE FROM t; UPDATE t SET a = 1')).toBe('delete');
    expect(scriptAction('DELETE FROM t; SET x = 1')).toBe('other');
    expect(scriptAction('SET x = 1; DROP TABLE t; SELECT 1')).toBe('ddl');
    expect(scriptAction('')).toBe('select');
    for (const sql of ['SELECT 1; SHOW tables', 'SELECT 1; DELETE FROM t', "SELECT 'DROP TABLE t'", '-- DROP TABLE t\nSELECT 1']) {
      expect(scriptAction(sql) === 'select').toBe(scriptIsReadOnly(sql));
    }
    expect(SQL_ACTIONS).toEqual(['select', 'insert', 'update', 'delete', 'ddl', 'other']);
  });

  it('names the action of Redis commands: admin beats write beats read', () => {
    expect(redisCommandAction(['GET', 'k'])).toBe('read');
    expect(redisCommandAction(['set', 'k', 'v'])).toBe('write');
    expect(redisCommandAction(['DEL', 'k'])).toBe('write');
    expect(redisCommandAction(['FLUSHALL'])).toBe('admin');
    expect(redisCommandAction(['config', 'set', 'maxmemory', '1'])).toBe('admin');
    expect(redisCommandAction(['CLIENT', 'LIST'])).toBe('read');
    expect(redisCommandAction(['CLIENT', 'KILL', 'ID', '1'])).toBe('admin');
    expect(redisCommandsAction([['GET', 'a'], ['TTL', 'a']])).toBe('read');
    expect(redisCommandsAction([['GET', 'a'], ['SET', 'a', '1']])).toBe('write');
    expect(redisCommandsAction([['SET', 'a', '1'], ['FLUSHDB']])).toBe('admin');
  });

  it('names the action of a batch of table edits', () => {
    expect(tableEditsAction([{ kind: 'insert' }, { kind: 'insert' }])).toBe('insert');
    expect(tableEditsAction([{ kind: 'delete' }])).toBe('delete');
    expect(tableEditsAction([{ kind: 'update' }, { kind: 'delete' }])).toBe('mixed');
  });
});
