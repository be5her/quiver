import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseConnectionUrl } from '@quiver/core';
import type { DbConnectionSummary, DbExportResult, DbSchemaMatch, DbTableApplyResult, DbTableColumns, DbConnectionTest, DbHistoryEntry, DbQueryResult, DbTable, DbTableDetail, RedisInfo, DbTableRows, RedisKeyDetail, RedisScanResult, SavedQuery } from '@quiver/core';
import { definePart, until } from '../part';

export default definePart({
  name: 'db',
  summary: 'Databases: SQLite, the fake Redis directly and through the fake Grafana, live MySQL/PostgreSQL when configured, agents over MCP, the grid and key browser',
  async run(t) {
    const { host, check, run, ws, folder, rpc, toolNames: names } = t;
    const { fakeRedis } = t.fixtures;

    // ---------- databases: SQLite through node:sqlite ----------
    const sqlite = await run<DbConnectionSummary>('db.connection.save', { connection: { kind: 'sqlite', name: 'smoke sqlite', file: 'data/smoke.db' } }, ws.id);
    check('db: sqlite connection saved', sqlite.kind === 'sqlite' && sqlite.hasPassword === false && sqlite.file === 'data/smoke.db');
    const sqliteTest = await run<DbConnectionTest>('db.connection.test', { id: sqlite.id }, ws.id);
    check('db: sqlite connects', sqliteTest.ok && sqliteTest.serverVersion.startsWith('SQLite'), sqliteTest.serverVersion);
    const seeded = await run<DbQueryResult[]>(
      'db.query.run',
      {
        connectionId: sqlite.id,
        query: `CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE);
          INSERT INTO users (name, email) VALUES ('Ada', 'ada@example.com'), ('Linus', 'linus@example.com');
          SELECT * FROM users ORDER BY id;`,
      },
      ws.id,
    );
    check('db: multi-statement script', seeded.length === 3 && seeded[1].affectedRows === 2, seeded.map((r) => r.kind));
    check(
      'db: rows come back as arrays with columns',
      seeded[2].kind === 'rows' && seeded[2].columns.map((c) => c.name).join(',') === 'id,name,email' && seeded[2].rows[0][1] === 'Ada',
      seeded[2].rows,
    );
    const tables = await run<DbTable[]>('db.schema.tables', { connectionId: sqlite.id }, ws.id);
    check('db: schema.tables', tables.some((t) => t.name === 'users' && t.type === 'table'), tables);
    const detail = await run<DbTableDetail>('db.schema.table', { connectionId: sqlite.id, table: 'users' }, ws.id);
    check('db: schema.table columns and indexes', detail.columns.length === 3 && detail.columns[0].key === 'PRI' && detail.indexes.some((i) => i.unique && i.columns.includes('email')) && Boolean(detail.ddl));
    const page = await run<DbTableRows>('db.table.rows', { connectionId: sqlite.id, table: 'users', where: "name = 'Ada'", orderBy: 'id', direction: 'desc' }, ws.id);
    check('db: table.rows with filter', page.total === 1 && page.rows.length === 1 && page.rows[0][1] === 'Ada', page);
    const capped = await run<DbQueryResult[]>('db.query.run', { connectionId: sqlite.id, query: 'SELECT * FROM users', maxRows: 1 }, ws.id);
    check('db: maxRows truncates', capped[0].rowCount === 1 && capped[0].truncated === true);
    const bad = await host.invoke('db.query.run', { connectionId: sqlite.id, query: 'SELECT * FROM nope' }, { caller: 'ui', workspaceId: ws.id });
    check('db: sql errors are reported', !bad.ok && bad.error.code === 'REQUEST_FAILED' && /no such table/.test(bad.error.message), bad.ok ? 'ok?' : bad.error.message);
    const dbHistory = await run<DbHistoryEntry[]>('db.history.list', { limit: 10 }, ws.id);
    check('db: history recorded', dbHistory.length === 3 && dbHistory[0].ok === false && dbHistory[1].ok === true, dbHistory.length);
    const savedQuery = await run<SavedQuery>('db.query.save', { query: { name: 'all users', connectionId: sqlite.id, text: 'SELECT * FROM users' } }, ws.id);
    const savedQueries = await run<SavedQuery[]>('db.query.list', {}, ws.id);
    check('db: saved queries', savedQueries.some((q) => q.id === savedQuery.id && q.name === 'all users'));

    // Foreign keys in both directions, the columns overview and the schema search.
    await run(
      'db.query.run',
      { connectionId: sqlite.id, query: `CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), total REAL); INSERT INTO orders (user_id, total) VALUES (1, 9.5), (2, 20);`, record: false },
      ws.id,
    );
    const ordersDetail = await run<DbTableDetail>('db.schema.table', { connectionId: sqlite.id, table: 'orders' }, ws.id);
    const usersDetail = await run<DbTableDetail>('db.schema.table', { connectionId: sqlite.id, table: 'users' }, ws.id);
    check(
      'db: schema.table reports the primary key and foreign keys both ways',
      ordersDetail.primaryKey.join() === 'id' &&
        ordersDetail.foreignKeys.length === 1 &&
        ordersDetail.foreignKeys[0].columns.join() === 'user_id' &&
        ordersDetail.foreignKeys[0].refTable === 'users' &&
        ordersDetail.foreignKeys[0].refColumns.join() === 'id' &&
        usersDetail.referencedBy.some((k) => k.table === 'orders' && k.columns.join() === 'user_id'),
      { orders: ordersDetail.foreignKeys, users: usersDetail.referencedBy },
    );
    const overview = await run<DbTableColumns[]>('db.schema.columns', { connectionId: sqlite.id }, ws.id);
    check('db: schema.columns lists every table with its columns', overview.find((t) => t.name === 'users')?.columns.map((c) => c.name).join() === 'id,name,email' && overview.some((t) => t.name === 'orders'), overview);
    const found = await run<{ matches: DbSchemaMatch[]; errors: unknown[] }>('db.schema.search', { query: 'mail' }, ws.id);
    check('db: schema.search finds columns across connections', found.matches.some((m) => m.table === 'users' && m.column === 'email' && m.connectionId === sqlite.id) && found.errors.length === 0, found);

    // Row edits: a preview, then insert, update and delete in one transaction, and a rollback when a key matches two rows.
    const preview = await run<DbTableApplyResult>(
      'db.table.apply',
      { connectionId: sqlite.id, table: 'users', preview: true, edits: [{ kind: 'update', key: { id: 1 }, values: { name: 'Ada L.' } }] },
      ws.id,
    );
    check('db: table.apply preview returns the statements without running them', !preview.applied && preview.statements.join() === `UPDATE "users" SET "name" = 'Ada L.' WHERE "id" = 1`, preview);
    const applied = await run<DbTableApplyResult>(
      'db.table.apply',
      {
        connectionId: sqlite.id,
        table: 'users',
        edits: [
          { kind: 'insert', values: { name: 'Grace', email: 'grace@example.com' } },
          { kind: 'update', key: { id: 2 }, values: { name: 'Linus T.' } },
          { kind: 'insert', values: { name: 'Temp', email: 'temp@example.com' } },
        ],
      },
      ws.id,
    );
    const afterApply = await run<DbTableRows>('db.table.rows', { connectionId: sqlite.id, table: 'users', orderBy: 'id' }, ws.id);
    const tempId = afterApply.rows.find((r) => r[1] === 'Temp')?.[0];
    const rowsRemoved = await run<DbTableApplyResult>('db.table.apply', { connectionId: sqlite.id, table: 'users', edits: [{ kind: 'delete', key: { id: tempId } }, { kind: 'update', key: { id: 2 }, values: { name: 'Linus' } }] }, ws.id);
    const afterRemove = await run<DbTableRows>('db.table.rows', { connectionId: sqlite.id, table: 'users', orderBy: 'id' }, ws.id);
    check(
      'db: table.apply inserts, updates and deletes by key',
      applied.applied && applied.affectedRows === 3 && afterApply.rows.length === 4 && afterApply.rows[1][1] === 'Linus T.' && rowsRemoved.affectedRows === 2 && afterRemove.rows.length === 3 && afterRemove.rows[1][1] === 'Linus' && afterRemove.rows[2][1] === 'Grace',
      { applied, afterApply: afterApply.rows, rowsRemoved, afterRemove: afterRemove.rows },
    );
    await run('db.query.run', { connectionId: sqlite.id, query: "INSERT INTO users (name, email) VALUES ('Dup', 'dup1@example.com'), ('Dup', 'dup2@example.com')", record: false }, ws.id);
    const conflict = await host.invoke('db.table.apply', { connectionId: sqlite.id, table: 'users', edits: [{ kind: 'update', key: { name: 'Dup' }, values: { name: 'Dup2' } }] }, { caller: 'ui', workspaceId: ws.id });
    const dupRows = await run<DbTableRows>('db.table.rows', { connectionId: sqlite.id, table: 'users', where: "name = 'Dup'" }, ws.id);
    check('db: table.apply rolls back when a key matches two rows', !conflict.ok && conflict.error.code === 'CONFLICT' && dupRows.rows.length === 2, conflict.ok ? 'ok?' : conflict.error.message);
    await run('db.query.run', { connectionId: sqlite.id, query: "DELETE FROM users WHERE name = 'Dup'", record: false }, ws.id);

    // Export: every format as text, and a file in the workspace.
    const csv = await run<DbExportResult>('db.export', { connectionId: sqlite.id, format: 'csv', table: 'users', orderBy: 'id' }, ws.id);
    const md = await run<DbExportResult>('db.export', { connectionId: sqlite.id, format: 'markdown', query: 'SELECT id, name FROM users ORDER BY id' }, ws.id);
    const inserts = await run<DbExportResult>('db.export', { connectionId: sqlite.id, format: 'sql', table: 'users', where: 'id = 1' }, ws.id);
    const jsonFile = await run<DbExportResult>('db.export', { connectionId: sqlite.id, format: 'json', table: 'users', orderBy: 'id', path: 'exports/users' }, ws.id);
    const exportedUsers = JSON.parse(await fs.readFile(path.join(folder, 'exports', 'users.json'), 'utf8')) as { name: string }[];
    check(
      'db: export renders csv, markdown and INSERTs, and writes a json file',
      csv.text?.split('\n')[0] === 'id,name,email' &&
        csv.rows === 3 &&
        md.text?.startsWith('| id | name |\n| --- | --- |\n| 1 | Ada |') === true &&
        inserts.text === `INSERT INTO "users" ("id", "name", "email") VALUES (1, 'Ada', 'ada@example.com');` &&
        jsonFile.path?.endsWith('users.json') === true &&
        jsonFile.text === null &&
        exportedUsers.map((r) => r.name).join() === 'Ada,Linus,Grace',
      { csv: csv.text, md: md.text, inserts: inserts.text, jsonFile, exportedUsers },
    );

    // History filters, a transaction that is rolled back, and cancel on an engine that cannot be interrupted.
    const historyHits = await run<DbHistoryEntry[]>('db.history.list', { search: 'grace', limit: 50 }, ws.id);
    const historyFailed = await run<DbHistoryEntry[]>('db.history.list', { ok: false, limit: 50 }, ws.id);
    check('db: history.list searches text and filters by outcome', historyHits.length > 0 && historyHits.every((e) => /grace/i.test(e.text)) && historyFailed.length > 0 && historyFailed.every((e) => !e.ok), { hits: historyHits.length, failed: historyFailed.length });
    const begun = await run<{ inTransaction: boolean }>('db.transaction', { connectionId: sqlite.id, action: 'begin' }, ws.id);
    await run('db.query.run', { connectionId: sqlite.id, query: "INSERT INTO users (name, email) VALUES ('Rolled', 'rolled@example.com')", record: false }, ws.id);
    const during = (await run<(DbConnectionSummary & { inTransaction: boolean })[]>('db.connection.list', {}, ws.id)).find((c) => c.id === sqlite.id);
    const rolledBack = await run<{ inTransaction: boolean }>('db.transaction', { connectionId: sqlite.id, action: 'rollback' }, ws.id);
    const afterRollback = await run<DbTableRows>('db.table.rows', { connectionId: sqlite.id, table: 'users', where: "name = 'Rolled'" }, ws.id);
    check('db: a transaction can be begun and rolled back', begun.inTransaction && during?.inTransaction === true && !rolledBack.inTransaction && afterRollback.rows.length === 0, { begun, during: during?.inTransaction, rolledBack, left: afterRollback.rows.length });
    const cancel = await run<{ supported: boolean; cancelled: boolean }>('db.query.cancel', { connectionId: sqlite.id }, ws.id);
    check('db: query.cancel says when the engine cannot be interrupted', cancel.supported === false && cancel.cancelled === false, cancel);
    await run('db.query.run', { connectionId: sqlite.id, query: "DELETE FROM users WHERE name = 'Grace'; DROP TABLE orders", record: false }, ws.id);

    // ---------- databases: Redis through the fake RESP server ----------
    const redis = await run<DbConnectionSummary>(
      'db.connection.save',
      { connection: { kind: 'redis', name: 'smoke redis', host: '127.0.0.1', port: fakeRedis.port }, password: 'hunter2' },
      ws.id,
    );
    check('db: redis connection stores password flag', redis.hasPassword === true);
    const redisOnDisk = await fs.readFile(path.join(folder, '.quiver', 'db-connections', `${redis.id}.json`), 'utf8');
    check('db: password not written to committed file', !redisOnDisk.includes('hunter2'));
    const dbSecrets = JSON.parse(await fs.readFile(path.join(folder, '.quiver', 'local', 'db-secrets.json'), 'utf8')) as Record<string, string>;
    check('db: password stored encrypted locally', typeof dbSecrets[redis.id] === 'string' && /^(enc|plain):/.test(dbSecrets[redis.id]));
    const redisTest = await run<DbConnectionTest>('db.connection.test', { id: redis.id }, ws.id);
    check('db: redis connects with stored password', redisTest.serverVersion === 'Redis 7.2.0-fake', redisTest.serverVersion);
    const wrongPassword = await host.invoke(
      'db.connection.test',
      { connection: { kind: 'redis', name: 'x', host: '127.0.0.1', port: fakeRedis.port }, password: 'nope' },
      { caller: 'ui', workspaceId: ws.id },
    );
    check('db: redis rejects wrong password', !wrongPassword.ok && /WRONGPASS/.test(wrongPassword.error.message), wrongPassword.ok ? 'ok?' : wrongPassword.error.message);
    const scan = await run<RedisScanResult>('db.redis.keys', { connectionId: redis.id, pattern: 'user:*' }, ws.id);
    check('db: redis scan', scan.done && scan.keys.length === 2 && scan.keys.every((k) => k.type === 'hash'), scan);
    const hash = await run<RedisKeyDetail>('db.redis.key', { connectionId: redis.id, key: 'user:1' }, ws.id);
    check('db: redis hash detail', hash.type === 'hash' && (hash.value as Record<string, string>).name === 'Ada' && hash.length === 2, hash);
    const session = await run<RedisKeyDetail>('db.redis.key', { connectionId: redis.id, key: 'session:abc' }, ws.id);
    check('db: redis string with ttl', session.type === 'string' && session.ttl > 0 && String(session.value).includes('userId'), session);
    const zset = await run<RedisKeyDetail>('db.redis.key', { connectionId: redis.id, key: 'scores' }, ws.id);
    check('db: redis zset pairs', zset.type === 'zset' && JSON.stringify(zset.value) === '[["linus",7],["ada",10]]', zset.value);
    const redisCmds = await run<DbQueryResult[]>('db.query.run', { connectionId: redis.id, query: 'SET smoke "hello world"\nGET smoke\nLRANGE queue 0 -1' }, ws.id);
    check('db: redis console commands', redisCmds.length === 3 && redisCmds[1].value === 'hello world' && Array.isArray(redisCmds[2].value) && redisCmds[2].value.length === 3, redisCmds.map((r) => r.value));
    const redisInfo = await run<RedisInfo>('db.redis.info', { connectionId: redis.id }, ws.id);
    check('db: redis.info boils INFO and DBSIZE down', redisInfo.version === '7.2.0-fake' && redisInfo.connectedClients === 3 && redisInfo.hitRate === 0.9 && (redisInfo.keys ?? 0) >= 6 && redisInfo.uptimeSeconds === 4242, redisInfo);
    const exact = await run<DbQueryResult[]>('db.redis.command', { connectionId: redis.id, commands: [['SET', 'smoke:multi', 'line one\nline "two"', 'EX', '120'], ['GET', 'smoke:multi'], ['TTL', 'smoke:multi']] }, ws.id);
    check('db: redis.command passes arguments exactly, line breaks and quotes included', exact[1].value === 'line one\nline "two"' && Number(exact[2].value) > 100, exact.map((r) => r.value));
    await fs.writeFile(path.join(folder, '.env'), `REDIS_HOST=127.0.0.1\n`, 'utf8');
    const templated = await run<DbConnectionSummary>('db.connection.save', { connection: { kind: 'redis', name: 'templated redis', host: '{{REDIS_HOST}}', port: fakeRedis.port }, password: 'hunter2' }, ws.id);
    const templatedTest = await run<DbConnectionTest>('db.connection.test', { id: templated.id }, ws.id);
    check('db: {{variables}} in a connection resolve from the workspace .env', templatedTest.ok && templated.host === '{{REDIS_HOST}}', { host: templated.host, version: templatedTest.serverVersion });
    await run('db.connection.delete', { id: templated.id }, ws.id);

    // ---------- databases: Redis through a Grafana Redis data source (the fake Grafana in front of the fake Redis) ----------
    const { fakeGrafana } = t.fixtures;
    const outcome = async (id: string, input: unknown, caller: 'ui' | 'mcp' = 'ui') => {
      const out = await host.invoke(id, input, { caller, workspaceId: ws.id });
      return out.ok ? { ok: true as const, value: out.result } : { ok: false as const, code: out.error.code, message: out.error.message, details: out.error.details as Record<string, unknown> | undefined };
    };
    const said = (o: Awaited<ReturnType<typeof outcome>>) => (o.ok ? 'ok' : `${o.code}: ${o.message}`);
    const grafanaAccess = (datasourceUid: string, datasourceName: string) => ({ type: 'grafana', grafanaUrl: `${fakeGrafana.url}/?orgId=1`, datasourceUid, datasourceName });
    const grafanaRedis = await run<DbConnectionSummary>('db.connection.save', { connection: { kind: 'redis', name: 'grafana redis', access: grafanaAccess('redis-smoke', 'Redis-Smoke') } }, ws.id);
    const grafanaOnDisk = JSON.parse(await fs.readFile(path.join(folder, '.quiver', 'db-connections', `${grafanaRedis.id}.json`), 'utf8')) as DbConnectionSummary;
    check(
      'db: a Redis connection through a Grafana data source is committed with the address normalised and no secret',
      JSON.stringify(grafanaOnDisk.access) === JSON.stringify({ type: 'grafana', grafanaUrl: fakeGrafana.url, datasourceUid: 'redis-smoke', datasourceName: 'Redis-Smoke' }) && grafanaRedis.hasPassword === false,
      grafanaOnDisk.access,
    );
    const sqlViaGrafana = await outcome('db.connection.save', { connection: { kind: 'postgres', name: 'x', access: grafanaAccess('redis-smoke', 'Redis-Smoke') } });
    const indexViaGrafana = await outcome('db.connection.save', { connection: { kind: 'redis', name: 'x', dbIndex: 2, access: grafanaAccess('redis-smoke', 'Redis-Smoke') } });
    check(
      'db: Grafana access is refused for SQL kinds and with a database index',
      !sqlViaGrafana.ok && sqlViaGrafana.code === 'INVALID_INPUT' && sqlViaGrafana.message.includes('only reach Redis') && !indexViaGrafana.ok && indexViaGrafana.code === 'INVALID_INPUT',
      { sql: said(sqlViaGrafana), index: said(indexViaGrafana) },
    );

    const grafanaSignedOut = await outcome('db.redis.keys', { connectionId: grafanaRedis.id, pattern: '*' });
    check(
      'db: through Grafana without a session the call asks for a sign-in, with the address for the Sign in button',
      !grafanaSignedOut.ok && grafanaSignedOut.code === 'SIGN_IN_REQUIRED' && grafanaSignedOut.details?.['grafanaUrl'] === fakeGrafana.url,
      said(grafanaSignedOut),
    );
    const grafanaLogins0 = fakeGrafana.seen.logins;
    const grafanaSignIn = await run<{ state: string; user: { email: string } | null }>('db.grafana.signin', { grafanaUrl: fakeGrafana.url }, ws.id);
    const sharedLogs = await run<{ id: string }>('logs.connection.save', { connection: { name: 'shared session', grafanaUrl: fakeGrafana.url } }, ws.id);
    const logsSees = await run<{ state: string }>('logs.session', { id: sharedLogs.id }, ws.id);
    const signInHidden = host.registry.list().find((c) => c.id === 'db.grafana.signin')?.hidden === true;
    check(
      'db: signing in for Redis opens the Grafana login once, is the Logs session too, and is not offered to agents',
      grafanaSignIn.state === 'signed-in' && fakeGrafana.seen.logins === grafanaLogins0 + 1 && logsSees.state === 'signed-in' && signInHidden,
      { state: grafanaSignIn.state, logins: fakeGrafana.seen.logins - grafanaLogins0, logs: logsSees.state, signInHidden },
    );
    const agentSources = await outcome('db.grafana.redis.datasources', { grafanaUrl: fakeGrafana.url }, 'mcp');
    const sources = agentSources.ok ? (agentSources.value as { uid: string; name: string; cliDisabled: boolean }[]) : [];
    check(
      'db: agents list the Redis data sources of a Grafana, and only those',
      agentSources.ok && sources.map((s) => `${s.uid}:${s.cliDisabled}`).join() === 'redis-ro:true,redis-smoke:false,redis-down:false' && names.includes('db_grafana_redis_datasources'),
      agentSources.ok ? sources : said(agentSources),
    );

    const grafanaTest = await run<DbConnectionTest>('db.connection.test', { id: grafanaRedis.id }, ws.id);
    check('db: through Grafana the test runs PING and INFO through the data source', grafanaTest.serverVersion === 'Redis 7.2.0-fake via Grafana (Redis-Smoke)', grafanaTest.serverVersion);
    const awkward = 'line one\nline "two" it\'s $HOME';
    const sentBefore = fakeGrafana.seen.redis.length;
    const roundTrip = await run<DbQueryResult[]>(
      'db.redis.command',
      { connectionId: grafanaRedis.id, commands: [['SET', 'smoke:grafana', awkward], ['GET', 'smoke:grafana'], ['EXISTS', 'smoke:grafana'], ['DEL', 'smoke:grafana'], ['EXISTS', 'smoke:grafana'], ['GET', 'smoke:grafana']] },
      ws.id,
    );
    check(
      'db: through Grafana SET, GET, EXISTS and DEL round trip a value with quotes, a line break and a dollar, one CLI query each',
      JSON.stringify(roundTrip.map((r) => r.value)) === JSON.stringify(['OK', awkward, 1, 1, 0, null]) && fakeGrafana.seen.redis.length === sentBefore + 6 && fakeGrafana.seen.redis[sentBefore] === `SET smoke:grafana 'line one\nline "two" it'\\''s $HOME'`,
      { values: roundTrip.map((r) => r.value), sent: fakeGrafana.seen.redis.slice(sentBefore) },
    );
    const grafanaConsole = await run<DbQueryResult[]>('db.query.run', { connectionId: grafanaRedis.id, query: 'SET smoke:num 007\nGET smoke:num\nLRANGE queue 0 -1\nDEL smoke:num' }, ws.id);
    check(
      'db: the console through Grafana keeps numeric strings as strings and lists as arrays',
      grafanaConsole[1]?.value === '007' && JSON.stringify(grafanaConsole[2]?.value) === JSON.stringify(['job-1', 'job-2', 'job-3']) && grafanaConsole[2]?.rowCount === 3,
      grafanaConsole.map((r) => r.value),
    );
    const grafanaScan = await run<RedisScanResult>('db.redis.keys', { connectionId: grafanaRedis.id, pattern: 'user:*' }, ws.id);
    const grafanaHash = await run<RedisKeyDetail>('db.redis.key', { connectionId: grafanaRedis.id, key: 'user:1' }, ws.id);
    const grafanaString = await run<RedisKeyDetail>('db.redis.key', { connectionId: grafanaRedis.id, key: 'session:abc' }, ws.id);
    const grafanaZset = await run<RedisKeyDetail>('db.redis.key', { connectionId: grafanaRedis.id, key: 'scores' }, ws.id);
    const grafanaInfo = await run<RedisInfo>('db.redis.info', { connectionId: grafanaRedis.id }, ws.id);
    check(
      'db: through Grafana the key browser scans with type and TTL, shows a hash, a string with its TTL, a sorted set and the server info',
      grafanaScan.done &&
        grafanaScan.keys.map((k) => `${k.key}:${k.type}:${k.ttl}`).join() === 'user:1:hash:-1,user:2:hash:-1' &&
        (grafanaHash.value as Record<string, string>).name === 'Ada' &&
        grafanaHash.length === 2 &&
        grafanaString.type === 'string' &&
        grafanaString.ttl > 0 &&
        String(grafanaString.value).includes('"userId":1') &&
        JSON.stringify(grafanaZset.value) === '[["linus",7],["ada",10]]' &&
        grafanaInfo.version === '7.2.0-fake' &&
        grafanaInfo.hitRate === 0.9 &&
        (grafanaInfo.keys ?? 0) >= 6,
      { scan: grafanaScan.keys, hash: grafanaHash.value, string: grafanaString, zset: grafanaZset.value, info: grafanaInfo },
    );

    const pluginError = await outcome('db.query.run', { connectionId: grafanaRedis.id, query: 'BOGUS x' });
    const selectRefused = await outcome('db.query.run', { connectionId: grafanaRedis.id, query: 'SELECT 1' });
    const sentBeforeRefusal = fakeGrafana.seen.redis.length;
    const surrogate = await outcome('db.redis.command', { connectionId: grafanaRedis.id, commands: [['SET', 'smoke:ok', 'fine'], ['SET', 'smoke:bad', 'half \uD800 pair']] });
    check(
      "db: through Grafana the plugin's error comes back verbatim, SELECT is refused, and an argument Grafana cannot carry is refused before anything runs",
      !pluginError.ok &&
        pluginError.message === "ERR unknown command 'BOGUS'" &&
        !selectRefused.ok &&
        selectRefused.code === 'INVALID_INPUT' &&
        selectRefused.message.includes('SELECT cannot run through Grafana') &&
        !surrogate.ok &&
        surrogate.code === 'INVALID_INPUT' &&
        surrogate.message.includes('lone UTF-16 surrogate') &&
        fakeGrafana.seen.redis.length === sentBeforeRefusal,
      { pluginError: said(pluginError), select: said(selectRefused), surrogate: said(surrogate), sent: fakeGrafana.seen.redis.slice(sentBeforeRefusal) },
    );
    const agentWrite = await outcome('db.redis.command', { connectionId: grafanaRedis.id, commands: [['SET', 'smoke:agent', 'x']] }, 'mcp');
    const agentRead = await outcome('db.redis.command', { connectionId: grafanaRedis.id, commands: [['GET', 'user:1'], ['TYPE', 'user:1']] }, 'mcp');
    const agentConsoleWrite = await outcome('db.query.run', { connectionId: grafanaRedis.id, query: 'FLUSHALL' }, 'mcp');
    check(
      'db: through Grafana agents may read but a write is gated the same as on a direct connection',
      !agentWrite.ok && agentWrite.code === 'MUTATION_BLOCKED' && !agentConsoleWrite.ok && agentConsoleWrite.code === 'MUTATION_BLOCKED' && agentRead.ok,
      { write: said(agentWrite), console: said(agentConsoleWrite), read: said(agentRead) },
    );

    const unreachable = await run<DbConnectionSummary>('db.connection.save', { connection: { kind: 'redis', name: 'grafana unreachable', access: grafanaAccess('redis-down', 'Redis-Unreachable') } }, ws.id);
    const unreachableTest = await outcome('db.connection.test', { id: unreachable.id });
    check(
      "db: Grafana's bare 500 Query data error says the data source cannot reach Redis",
      !unreachableTest.ok && unreachableTest.message === 'Grafana could not reach Redis through data source Redis-Unreachable; ask the Grafana admin to run Save & test on it.',
      said(unreachableTest),
    );
    const moved = await run<DbConnectionSummary>('db.connection.save', { connection: { kind: 'redis', name: 'grafana moved', access: grafanaAccess('z2A9WFrDz', 'Redis-Smoke') } }, ws.id);
    const movedTest = await outcome('db.connection.test', { id: moved.id });
    const movedTo = movedTest.ok ? null : (movedTest.details?.['datasourceMoved'] as { uid: string; name: string } | undefined);
    check(
      'db: a data source whose uid changed is found by name, and the error offers the new uid',
      !movedTest.ok && movedTest.code === 'NOT_FOUND' && movedTest.message.includes('uid redis-smoke') && movedTo?.uid === 'redis-smoke' && movedTest.details?.['connectionId'] === moved.id,
      said(movedTest),
    );

    const readOnly = await run<DbConnectionSummary>('db.connection.save', { connection: { kind: 'redis', name: 'grafana read-only', access: grafanaAccess('redis-ro', 'Redis-ReadOnly') } }, ws.id);
    const readOnlyTest = await run<DbConnectionTest>('db.connection.test', { id: readOnly.id }, ws.id);
    const readOnlyScan = await run<RedisScanResult>('db.redis.keys', { connectionId: readOnly.id, pattern: 'user:*' }, ws.id);
    const readOnlyHash = await run<RedisKeyDetail>('db.redis.key', { connectionId: readOnly.id, key: 'user:2' }, ws.id);
    const readOnlyInfo = await run<RedisInfo>('db.redis.info', { connectionId: readOnly.id }, ws.id);
    const readOnlyWrite = await outcome('db.redis.command', { connectionId: readOnly.id, commands: [['GET', 'user:1']] });
    check(
      "db: with the data source's CLI turned off the key browser reads through the plugin's fixed commands and commands are refused",
      readOnlyTest.serverVersion === 'Redis 7.2.0-fake via Grafana (Redis-ReadOnly), read-only: CLI turned off' &&
        readOnlyScan.keys.map((k) => `${k.key}:${k.type}:${k.ttl}`).join() === 'user:1:hash:-1,user:2:hash:-1' &&
        (readOnlyHash.value as Record<string, string>).name === 'Linus' &&
        readOnlyInfo.version === '7.2.0-fake' &&
        !readOnlyWrite.ok &&
        readOnlyWrite.message.includes('CLI is turned off on Grafana data source Redis-ReadOnly') &&
        !fakeGrafana.seen.redis.includes('CLI sent to a data source with the CLI turned off'),
      { version: readOnlyTest.serverVersion, scan: readOnlyScan.keys, hash: readOnlyHash.value, info: readOnlyInfo.version, write: said(readOnlyWrite) },
    );
    for (const c of [unreachable, moved, readOnly]) await run('db.connection.delete', { id: c.id }, ws.id);

    // Signing out from Logs ends the session for Redis too; the Logs part then starts signed out, as when run alone.
    await run('logs.signout', { id: sharedLogs.id }, ws.id);
    const afterSignOut = await outcome('db.redis.keys', { connectionId: grafanaRedis.id, pattern: '*' });
    check('db: signing out of Grafana in Logs signs the Redis connection out too', !afterSignOut.ok && afterSignOut.code === 'SIGN_IN_REQUIRED', said(afterSignOut));
    await run('logs.connection.delete', { id: sharedLogs.id }, ws.id);

    // Optional: a live MySQL server, e.g. QUIVER_SMOKE_MYSQL=mysql://root:secret@127.0.0.1:3306/test
    if (process.env.QUIVER_SMOKE_MYSQL) {
      const url = new URL(process.env.QUIVER_SMOKE_MYSQL);
      const mysql = await run<DbConnectionSummary>(
        'db.connection.save',
        {
          connection: { kind: 'mysql', name: 'smoke mysql', host: url.hostname, port: Number(url.port) || 3306, user: decodeURIComponent(url.username), database: url.pathname.replace(/^\//, '') },
          password: decodeURIComponent(url.password),
        },
        ws.id,
      );
      const mysqlTest = await run<DbConnectionTest>('db.connection.test', { id: mysql.id }, ws.id);
      check('db: mysql connects', mysqlTest.ok, mysqlTest.serverVersion);
      const dbs = await run<string[]>('db.schema.databases', { connectionId: mysql.id }, ws.id);
      check('db: mysql databases', dbs.length > 0, dbs);
      const one = await run<DbQueryResult[]>('db.query.run', { connectionId: mysql.id, query: "SELECT 1 AS one, NOW() AS at; SHOW VARIABLES LIKE 'version'" }, ws.id);
      check('db: mysql query', one.length === 2 && one[0].rows[0][0] === 1 && one[1].kind === 'rows', one);
      if (mysql.database) {
        const mysqlTables = await run<DbTable[]>('db.schema.tables', { connectionId: mysql.id }, ws.id);
        check('db: mysql tables', Array.isArray(mysqlTables), mysqlTables.length);
      }
    } else {
      console.log('SKIP db: mysql (set QUIVER_SMOKE_MYSQL=mysql://user:pass@host:port/db to run)');
    }

    // Optional: a live PostgreSQL server, e.g. QUIVER_SMOKE_POSTGRES=postgres://postgres:secret@127.0.0.1:5432/postgres
    if (process.env.QUIVER_SMOKE_POSTGRES) {
      const parsed = parseConnectionUrl(process.env.QUIVER_SMOKE_POSTGRES);
      check('db: postgres url parses', parsed?.connection.kind === 'postgres', parsed);
      const pg = await run<DbConnectionSummary>('db.connection.save', { connection: { ...parsed!.connection, name: 'smoke postgres' }, password: parsed!.password ?? undefined }, ws.id);
      const pgTest = await run<DbConnectionTest>('db.connection.test', { id: pg.id }, ws.id);
      check('db: postgres connects', pgTest.ok && pgTest.serverVersion.startsWith('PostgreSQL'), pgTest.serverVersion);
      const schemas = await run<string[]>('db.schema.databases', { connectionId: pg.id }, ws.id);
      check('db: postgres schemas, public first', schemas[0] === 'public', schemas);
      const table = `quiver_smoke_${Date.now().toString(36)}`;
      await run('db.query.run', { connectionId: pg.id, query: `CREATE TABLE ${table} (id serial PRIMARY KEY, name text NOT NULL, big bigint, at timestamptz DEFAULT now()); CREATE TABLE ${table}_child (id serial PRIMARY KEY, parent_id int REFERENCES ${table}(id));`, record: false }, ws.id);
      try {
        const applied = await run<DbTableApplyResult>('db.table.apply', { connectionId: pg.id, table, edits: [{ kind: 'insert', values: { name: 'Ada', big: '12345678901234567890' } }, { kind: 'insert', values: { name: 'Linus' } }] }, ws.id);
        const rows = await run<DbTableRows>('db.table.rows', { connectionId: pg.id, table, orderBy: 'id' }, ws.id);
        const pgDetail = await run<DbTableDetail>('db.schema.table', { connectionId: pg.id, table }, ws.id);
        const selected = await run<DbQueryResult[]>('db.query.run', { connectionId: pg.id, query: `SELECT id, name, big FROM ${table} ORDER BY id; UPDATE ${table} SET name = 'Ada L' WHERE id = 1` }, ws.id);
        check(
          'db: postgres rows, bigints as text, keys, foreign keys and affected counts',
          applied.affectedRows === 2 &&
            rows.rows.length === 2 &&
            rows.rows[0][2] === '12345678901234567890' &&
            pgDetail.primaryKey.join() === 'id' &&
            pgDetail.referencedBy.some((k) => k.table === `${table}_child`) &&
            Boolean(pgDetail.ddl?.includes('PRIMARY KEY')) &&
            selected[0].kind === 'rows' &&
            selected[1].kind === 'affected' &&
            selected[1].affectedRows === 1,
          { applied, rows: rows.rows, detail: pgDetail, selected },
        );
        const pgColumns = await run<DbTableColumns[]>('db.schema.columns', { connectionId: pg.id }, ws.id);
        check('db: postgres columns overview', pgColumns.find((t) => t.name === table)?.columns.map((c) => c.name).join() === 'id,name,big,at', pgColumns.find((t) => t.name === table));
        const pgCancel = await run<{ supported: boolean; cancelled: boolean }>('db.query.cancel', { connectionId: pg.id }, ws.id);
        check('db: postgres cancel is supported', pgCancel.supported === true, pgCancel);
      } finally {
        await run('db.query.run', { connectionId: pg.id, query: `DROP TABLE ${table}_child; DROP TABLE ${table}`, record: false }, ws.id);
        await run('db.connection.delete', { id: pg.id }, ws.id);
      }
    } else {
      console.log('SKIP db: postgres (set QUIVER_SMOKE_POSTGRES=postgres://user:pass@host:port/db to run)');
    }

    check('mcp lists db tools', names.includes('db_query_run') && names.includes('db_redis_keys') && names.includes('db_table_rows'));
    const mcpRead = await rpc('tools/call', { name: 'db_query_run', arguments: { connectionId: sqlite.id, query: 'SELECT name FROM users ORDER BY id' } });
    const mcpRows = JSON.parse(mcpRead.result?.content?.[0]?.text ?? '[]') as DbQueryResult[];
    check('mcp runs read-only sql', mcpRead.result?.isError !== true && mcpRows[0]?.rows.length === 2, mcpRead.result?.content?.[0]?.text?.slice(0, 200));
    const mcpWrite = await rpc('tools/call', { name: 'db_query_run', arguments: { connectionId: sqlite.id, query: 'DELETE FROM users' } });
    check('mcp blocks write sql by default', mcpWrite.result?.isError === true && (mcpWrite.result.content?.[0]?.text ?? '').includes('MUTATION_BLOCKED'));
    const stillThere = await run<DbQueryResult[]>('db.query.run', { connectionId: sqlite.id, query: 'SELECT COUNT(*) FROM users', record: false }, ws.id);
    check('mcp blocked write did not run', stillThere[0].rows[0][0] === 2);
    const mcpRedisWrite = await rpc('tools/call', { name: 'db_query_run', arguments: { connectionId: redis.id, query: 'FLUSHALL' } });
    check('mcp blocks redis writes by default', mcpRedisWrite.result?.isError === true);
    const mcpConnections = await rpc('tools/call', { name: 'db_connection_list', arguments: {} });
    check('mcp connection list has no password', !(mcpConnections.result?.content?.[0]?.text ?? '').includes('hunter2'));
    // The stored password stays where it was given, and a tunnel command is a process an agent may not start without mutations.
    {
      const tool = async (name: string, args: unknown) => {
        const out = await rpc('tools/call', { name, arguments: args });
        return { blocked: out.result?.isError === true && (out.result.content?.[0]?.text ?? '').includes('MUTATION_BLOCKED'), error: out.result?.isError === true, text: out.result?.content?.[0]?.text ?? '' };
      };
      const base = { id: redis.id, kind: 'redis', name: 'smoke redis', host: '127.0.0.1', port: fakeRedis.port };
      const moveHost = await tool('db_connection_save', { connection: { ...base, host: '127.0.0.2' } });
      const movePort = await tool('db_connection_save', { connection: { ...base, port: 9 } });
      const moveWithPassword = await tool('db_connection_test', { connection: { ...base, port: 9 }, password: 'agent-typed' });
      const testElsewhere = await tool('db_connection_test', { connection: { ...base, host: '127.0.0.2' } });
      const testAsIs = await tool('db_connection_test', { connection: base });
      const rename = await tool('db_connection_save', { connection: { ...base, name: 'smoke redis (agent)' } });
      const tunnel = { type: 'command', command: 'node -e "process.exit(0)" {port}' };
      const newTunnel = await tool('db_connection_save', { connection: { kind: 'redis', name: 'agent tunnel', access: tunnel } });
      const testTunnel = await tool('db_connection_test', { connection: { kind: 'redis', name: 'agent tunnel', access: tunnel } });
      const afterAgent = await run<DbConnectionSummary>('db.connection.get', { id: redis.id }, ws.id);
      const tunnels = (await run<DbConnectionSummary[]>('db.connection.list', {}, ws.id)).filter((c) => c.name === 'agent tunnel');
      check(
        'db: an agent may not point a connection with a stored password elsewhere or start a tunnel command, but may rename it and test it as it is',
        moveHost.blocked && movePort.blocked && !moveWithPassword.blocked && testElsewhere.blocked && !testAsIs.error && !rename.error && newTunnel.blocked && testTunnel.blocked &&
          afterAgent.host === '127.0.0.1' && afterAgent.port === fakeRedis.port && afterAgent.hasPassword && afterAgent.name === 'smoke redis (agent)' && tunnels.length === 0,
        { moveHost, movePort, moveWithPassword: moveWithPassword.blocked, testElsewhere, testAsIs: testAsIs.text.slice(0, 200), rename: rename.error, newTunnel, testTunnel, afterAgent: { host: afterAgent.host, port: afterAgent.port, name: afterAgent.name } },
      );
      await run('db.connection.save', { connection: base }, ws.id);
    }

    return {
      ui: async (u) => {
        const { win, js, wait, shot } = u;
        // Databases module: sidebar tree, table browser, query editor, redis keys.
        const clickedModule = await js(
          `(() => { const btn = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || b.title || '').includes('Databases')); if (btn) btn.click(); return Boolean(btn); })()`,
        );
        check('ui: databases module button', clickedModule === true);
        await wait(500);
        const clickedConn = await js(
          `(() => { const row = [...document.querySelectorAll('[role=button]')].find((r) => r.textContent.includes('smoke sqlite')); if (row) row.click(); return Boolean(row); })()`,
        );
        check('ui: sqlite connection row', clickedConn === true);
        await wait(1000);
        const clickedTable = await js(
          `(() => { const row = [...document.querySelectorAll('[role=button]')].find((r) => r.textContent.trim().startsWith('users')); if (row) row.click(); return Boolean(row); })()`,
        );
        check('ui: users table row', clickedTable === true);
        await wait(1200);
        const gridHasAda = await js(`[...document.querySelectorAll('[role=gridcell]')].some((c) => c.textContent === 'Ada')`);
        check('ui: table grid renders rows', gridHasAda === true);
        const tableHeader = await js(`[...document.querySelectorAll('[data-testid=db-table-connection]')].find((el) => el.offsetParent !== null)?.textContent.trim() ?? null`);
        check('ui: a table tab names the connection it belongs to', typeof tableHeader === 'string' && tableHeader.includes('smoke sqlite'), tableHeader);
        await shot('05-table-light');
        // A write from elsewhere (another tab, an agent) reloads the schema tree and the open table's rows.
        {
          const visibleCells = () => js(`[...document.querySelectorAll('[role=gridcell]')].filter((c) => c.offsetParent !== null).map((c) => c.textContent)`) as Promise<string[]>;
          const tableRows = () => js(`[...document.querySelectorAll('aside [role=button]')].map((r) => r.textContent.trim().split(/\\s+/)[0])`) as Promise<string[]>;
          await run('db.query.run', { connectionId: sqlite.id, query: 'CREATE TABLE smoke_live (id INTEGER PRIMARY KEY)' }, ws.id);
          await run('db.query.run', { connectionId: sqlite.id, query: "UPDATE users SET name = 'Ada Lovelace' WHERE name = 'Ada'" }, ws.id);
          await wait(1000);
          const created = { tables: await tableRows(), cells: await visibleCells() };
          await run('db.query.run', { connectionId: sqlite.id, query: 'DROP TABLE smoke_live' }, ws.id);
          await run('db.query.run', { connectionId: sqlite.id, query: "UPDATE users SET name = 'Ada' WHERE name = 'Ada Lovelace'" }, ws.id);
          await wait(1000);
          const dropped = { tables: await tableRows(), cells: await visibleCells() };
          check(
            'ui: a write reloads the table list and the open rows',
            created.tables.includes('smoke_live') && created.cells.includes('Ada Lovelace') && !dropped.tables.includes('smoke_live') && dropped.cells.includes('Ada') && !dropped.cells.includes('Ada Lovelace'),
            { created, dropped },
          );
        }
        // A long table list gets a filter (Enter opens the first match, Escape clears it), and a cell holding JSON text shows it formatted.
        {
          const sidebarTables = async () =>
            ((await js(`[...document.querySelectorAll('aside [role=button]')].map((r) => r.textContent.trim().split(/\\s+/)[0])`)) as string[]).filter((name) => name === 'users' || name.startsWith('smoke_'));
          const filterInput = `document.querySelector('[data-testid=db-table-filter]')`;
          const fillers = Array.from({ length: 10 }, (_, i) => `smoke_filter_${String(i).padStart(2, '0')}`);
          await run(
            'db.query.run',
            {
              connectionId: sqlite.id,
              query: [...fillers.map((t) => `CREATE TABLE ${t} (id INTEGER PRIMARY KEY);`), 'CREATE TABLE smoke_json (id INTEGER PRIMARY KEY, doc TEXT);', `INSERT INTO smoke_json (doc) VALUES ('{"id":12345678901234567890,"tags":["a","b"]}');`].join('\n'),
            },
            ws.id,
          );
          await wait(1000);
          const placeholder = await js(`${filterInput}?.placeholder ?? null`);
          await js(`(() => { const el = ${filterInput}; el.value = 'JSON'; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
          await wait(200);
          const matching = await sidebarTables();
          await shot('05a-table-filter-light');
          await js(`${filterInput}.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
          await wait(1200);
          const clickedJson = await js(`(() => { const cell = [...document.querySelectorAll('[role=gridcell]')].find((c) => c.offsetParent !== null && c.textContent.startsWith('{"id"')); if (cell) cell.click(); return Boolean(cell); })()`);
          await wait(200);
          const detail = await js(`[...document.querySelectorAll('[data-testid=db-cell-detail]')].find((p) => p.offsetParent !== null)?.textContent ?? null`);
          await shot('05a-table-json-cell-light');
          await js(`${filterInput}.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
          await wait(200);
          const cleared = await sidebarTables();
          check(
            'ui: a long table list filters by name and Enter opens the first match',
            placeholder === 'Filter 12 tables' && matching.join() === 'smoke_json' && clickedJson === true && cleared.includes('users') && cleared.includes('smoke_filter_09'),
            { placeholder, matching, clickedJson, cleared },
          );
          check('ui: a cell holding JSON text shows it formatted, numbers as written', detail === '{\n  "id": 12345678901234567890,\n  "tags": [\n    "a",\n    "b"\n  ]\n}', detail);
          await js(`(() => { const tab = document.querySelector('[data-testid=tab][aria-selected=true] [aria-label="Close tab"]'); if (tab) tab.click(); })()`);
          await run('db.query.run', { connectionId: sqlite.id, query: [...fillers, 'smoke_json'].map((t) => `DROP TABLE ${t};`).join('\n') }, ws.id);
          await wait(1000);
          const filterGone = await js(`!${filterInput}`);
          check('ui: the filter goes away once the list is short again', filterGone === true && (await sidebarTables()).join() === 'users', filterGone);
        }
        // The WHERE filter completes the table's columns: Enter picks one while the list is open, then applies the filter.
        const typeText = (text: string) => {
          for (const ch of text) win.webContents.sendInputEvent({ type: 'char', keyCode: ch });
        };
        const pressEnter = () => {
          win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
          win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
        };
        const whereFocused = await js(`(() => { const c = document.querySelector('[data-testid=db-table-where] .cm-content'); if (c) c.focus(); return document.activeElement === c; })()`);
        check('ui: WHERE filter is an editor', whereFocused === true);
        typeText('ema');
        await wait(500);
        const whereOptions = await js(`[...document.querySelectorAll('.cm-tooltip-autocomplete li')].map((li) => [li.querySelector('.cm-completionLabel')?.textContent, li.querySelector('.cm-completionDetail')?.textContent, li.getAttribute('aria-selected') === 'true'])`);
        check(
          'ui: WHERE filter offers the columns with their types',
          Array.isArray(whereOptions) && whereOptions.some((o: unknown[]) => o[0] === 'email' && o[1] === 'TEXT' && o[2] === true),
          whereOptions,
        );
        await js(`document.documentElement.classList.add('dark')`);
        await wait(300);
        await shot('05b-table-where-completion-dark');
        await js(`document.documentElement.classList.remove('dark')`);
        pressEnter();
        await wait(200);
        const whereText = () => js(`document.querySelector('[data-testid=db-table-where] .cm-content')?.textContent ?? ''`);
        const picked = await whereText();
        typeText(" = 'linus@example.com'");
        await wait(300);
        pressEnter();
        await wait(1200);
        const filtered = await js(`[...document.querySelectorAll('[role=gridcell]')].filter((c) => c.offsetParent !== null).map((c) => c.textContent).join(',')`);
        check('ui: Enter picks the column, then applies the filter', picked === 'email' && typeof filtered === 'string' && filtered.includes('Linus') && !filtered.includes('Ada'), { picked, filtered });
        // A pasted line break becomes a space instead of a second line.
        await js(`document.execCommand('insertText', false, '\\n  AND id > 0')`);
        await wait(200);
        const whereAfter = await js(`[...document.querySelectorAll('[data-testid=db-table-where] .cm-line')].map((l) => l.textContent)`);
        check('ui: the WHERE filter stays one line', Array.isArray(whereAfter) && whereAfter.length === 1 && whereAfter[0] === "email = 'linus@example.com' AND id > 0", whereAfter);
        // The grid edits in place: double-click, type, Enter, then Apply runs the UPDATE and the row comes back changed.
        {
          const nameCell = `[...document.querySelectorAll('[role=gridcell]')].find((c) => c.offsetParent !== null && c.textContent.trim() === 'Linus')`;
          const dblClicked = await js(`(() => { const c = ${nameCell}; if (!c) return false; c.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return true; })()`);
          await wait(200);
          const typed = await js(
            `(() => { const el = document.querySelector('[data-testid=db-cell-editor]'); if (!el) return false; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, 'Linus T'); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; })()`,
          );
          await wait(200);
          const pending = await js(`document.querySelector('[data-testid=db-pending]')?.textContent.trim() ?? null`);
          const changedCells = await js(`[...document.querySelectorAll('[role=gridcell][data-changed]')].filter((c) => c.offsetParent !== null).map((c) => c.textContent.trim())`);
          await shot('05c-table-pending-edit-light');
          await js(`document.querySelector('[data-testid=db-apply]')?.click()`);
          await wait(1500);
          const afterApply = await js(`[...document.querySelectorAll('[role=gridcell]')].filter((c) => c.offsetParent !== null).map((c) => c.textContent.trim())`);
          const stored = await run<DbTableRows>('db.table.rows', { connectionId: sqlite.id, table: 'users', where: "name = 'Linus T'" }, ws.id);
          check(
            'ui: a cell edited in the grid is applied by key and read back',
            dblClicked === true && typed === true && pending === '1 pending' && Array.isArray(changedCells) && changedCells.join() === 'Linus T' && Array.isArray(afterApply) && afterApply.includes('Linus T') && stored.rows.length === 1 && !(await js(`Boolean(document.querySelector('[data-testid=db-pending]'))`)),
            { dblClicked, typed, pending, changedCells, afterApply, stored: stored.rows },
          );
          await run('db.query.run', { connectionId: sqlite.id, query: "UPDATE users SET name = 'Linus' WHERE name = 'Linus T'", record: false }, ws.id);
          await wait(800);
        }
        // Right-click offers the row actions; the detail strip opens the transposed row; the export menu lists the formats.
        {
          const nameCell = `[...document.querySelectorAll('[role=gridcell]')].find((c) => c.offsetParent !== null && c.textContent.trim() === 'Linus')`;
          await js(`(() => { const c = ${nameCell}; if (c) c.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 320, clientY: 320 })); })()`);
          await wait(200);
          const menuItems = (await js(`[...document.querySelectorAll('[data-testid=context-menu] button')].map((b) => b.textContent.trim())`)) as string[];
          await shot('05d-table-context-menu-light');
          await js(`document.querySelector('[data-testid=context-menu]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
          await wait(100);
          await js(`(() => { const c = ${nameCell}; if (c) c.click(); })()`);
          await wait(100);
          await js(`[...document.querySelectorAll('button[aria-label="Show row detail"]')].find((b) => b.offsetParent !== null)?.click()`);
          await wait(200);
          const detailText = await js(`document.querySelector('[data-testid=db-row-detail]')?.textContent ?? null`);
          await shot('05e-table-row-detail-light');
          await js(`[...document.querySelectorAll('button[aria-label="Hide row detail"]')].find((b) => b.offsetParent !== null)?.click()`);
          await js(`[...document.querySelectorAll('[data-testid=db-export]')].find((b) => b.offsetParent !== null)?.click()`);
          await wait(200);
          const exportItems = (await js(`[...document.querySelectorAll('[role=menuitem]')].map((b) => b.textContent.trim())`)) as string[];
          await js(`document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
          await wait(100);
          check(
            'ui: the grid has a context menu, a row detail panel and an export menu',
            Array.isArray(menuItems) && menuItems.some((t) => t.startsWith('Filter by name')) && menuItems.some((t) => t.startsWith('Edit cell')) && menuItems.includes('Delete row') && typeof detailText === 'string' && detailText.includes('email') && detailText.includes('linus@example.com') && exportItems.includes('CSV') && exportItems.includes('INSERT statements…'),
            { menuItems, detailText, exportItems },
          );
        }
        // The history tab lists every run and searches it.
        {
          await js(`document.querySelector('[data-testid=db-history-open]')?.click()`);
          await wait(800);
          const all = await js(`document.querySelectorAll('[data-testid=db-history-entry]').length`);
          await js(`(() => { const el = document.querySelector('[data-testid=db-history-search]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, 'nope'); el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
          await wait(800);
          const searched = (await js(`[...document.querySelectorAll('[data-testid=db-history-entry]')].map((e) => e.title)`)) as string[];
          await shot('05f-history-tab-light');
          check('ui: the history tab lists runs and filters them by text', typeof all === 'number' && all > 3 && searched.length > 0 && searched.every((t) => t.includes('nope')), { all, searched });
          await js(`(() => { const tab = document.querySelector('[data-testid=tab][aria-selected=true] [aria-label="Close tab"]'); if (tab) tab.click(); })()`);
          await wait(300);
        }
        const clickedQuery = await js(
          `(() => { const btn = [...document.querySelectorAll('button')].find((b) => b.offsetParent !== null && b.textContent.trim() === 'Query'); if (btn) btn.click(); return Boolean(btn); })()`,
        );
        check('ui: open query from table', clickedQuery === true);
        await wait(800);
        const clickedRun = await js(
          `(() => { const btn = [...document.querySelectorAll('button')].find((b) => b.offsetParent !== null && b.textContent.trim() === 'Run'); if (btn) btn.click(); return Boolean(btn); })()`,
        );
        check('ui: run button present', clickedRun === true);
        await wait(1200);
        const queryRows = await js(`[...document.querySelectorAll('[role=gridcell]')].filter((c) => c.textContent === 'Linus' && c.offsetParent !== null).length`);
        check('ui: query results rendered', queryRows === 1, queryRows);
        await shot('06-query-light');
        await js(`document.documentElement.classList.add('dark')`);
        await wait(300);
        await shot('07-query-dark');
        const clickedRedis = await js(
          `(() => { const row = [...document.querySelectorAll('[role=button]')].find((r) => r.textContent.includes('smoke redis')); if (row) row.click(); return Boolean(row); })()`,
        );
        check('ui: redis connection row', clickedRedis === true);
        await wait(400);
        await js(`(() => { const row = [...document.querySelectorAll('[role=button]')].find((r) => r.textContent.trim() === 'Keys'); if (row) row.click(); })()`);
        await wait(1200);
        const clickedKey = await js(
          `(() => { const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('user:1')); if (btn) btn.click(); return Boolean(btn); })()`,
        );
        check('ui: redis key listed', clickedKey === true);
        await wait(800);
        const hashRendered = await js(`[...document.querySelectorAll('[role=gridcell]')].some((c) => c.textContent === 'Ada')`);
        check('ui: redis hash rendered', hashRendered === true);
        // A write from elsewhere rescans the keys and reloads the open key.
        {
          const keyNames = () => js(`[...document.querySelectorAll('button')].map((b) => b.textContent.trim()).filter((t) => /^(string|hash|list|set|zset|stream)/.test(t))`) as Promise<string[]>;
          const cells = () => js(`[...document.querySelectorAll('[role=gridcell]')].map((c) => c.textContent)`) as Promise<string[]>;
          await run('db.query.run', { connectionId: redis.id, query: 'SET smoke:live 1\nHSET user:1 name Grace' }, ws.id);
          await wait(1000);
          const written = { keys: await keyNames(), cells: await cells() };
          await run('db.query.run', { connectionId: redis.id, query: 'DEL smoke:live\nHSET user:1 name Ada' }, ws.id);
          await wait(1000);
          const restored = { keys: await keyNames(), cells: await cells() };
          check(
            'ui: a redis write rescans the keys and reloads the open key',
            written.keys.some((k) => k.endsWith('smoke:live')) && written.cells.includes('Grace') && !restored.keys.some((k) => k.endsWith('smoke:live')) && restored.cells.includes('Ada'),
            { written, restored },
          );
        }
        // The key browser shows the server's vitals, creates a key from a dialog and sets its expiry.
        {
          const vitals = await js(`document.querySelector('[data-testid=db-redis-info]')?.textContent ?? null`);
          await js(`document.querySelector('[data-testid=db-redis-new-key]')?.click()`);
          await wait(300);
          const dialogFilled = await js(
            `(() => { const el = document.querySelector('form input'); if (!el) return false; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, 'smoke:new'); el.dispatchEvent(new Event('input', { bubbles: true })); const btn = [...document.querySelectorAll('form button')].find((b) => b.textContent.trim() === 'Create'); if (btn) btn.click(); return Boolean(btn); })()`,
          );
          await wait(1200);
          const created = await js(`document.querySelector('[data-testid=db-redis-key-name]')?.textContent.trim() ?? null`);
          await js(`document.querySelector('[data-testid=db-redis-ttl]')?.click()`);
          await wait(300);
          await js(
            `(() => { const el = document.querySelector('form input'); if (!el) return; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, '120'); el.dispatchEvent(new Event('input', { bubbles: true })); [...document.querySelectorAll('form button')].find((b) => b.textContent.trim() === 'Set')?.click(); })()`,
          );
          await wait(1000);
          const ttlShown = await js(`document.querySelector('[data-testid=db-redis-ttl-value]')?.textContent ?? null`);
          await shot('08a-redis-new-key-dark');
          check(
            'ui: the key browser shows vitals, creates a key and sets its TTL',
            typeof vitals === 'string' && vitals.includes('7.2.0-fake') && vitals.includes('3 clients') && dialogFilled === true && created === 'smoke:new' && typeof ttlShown === 'string' && /TTL: (1m|2m)/.test(ttlShown),
            { vitals, dialogFilled, created, ttlShown },
          );
          await run('db.redis.command', { connectionId: redis.id, commands: [['DEL', 'smoke:new']] }, ws.id);
          await wait(500);
        }
        await shot('08-redis-dark');
        // Redis through Grafana: the connection's Access section with the sign-in state and the data source picker, then the key browser over Grafana.
        {
          // Run alone, the host checks above end signed out; a full run leaves the Logs part's session behind.
          await run('db.grafana.signin', { grafanaUrl: fakeGrafana.url }, ws.id);
          await js(`document.documentElement.classList.remove('dark')`);
          const visible = `(s) => [...document.querySelectorAll(s)].find((e) => e.offsetParent !== null)`;
          const grafanaRow = `[...document.querySelectorAll('[data-testid=db-connection-row]')].find((r) => r.textContent.includes('grafana redis'))`;
          await js(`${grafanaRow}?.querySelector('[data-testid=db-connection-menu]')?.click()`);
          await wait(300);
          await js(`[...document.querySelectorAll('[role^=menuitem]')].find((b) => b.textContent.trim() === 'Edit connection')?.click()`);
          await until(async () => (await js(`(${visible})('[data-testid=db-grafana-source]')?.options.length ?? 0`)) === 3, 6000);
          const form = await js(
            `(() => { const v = ${visible}; const select = v('[data-testid=db-grafana-source]'); return { session: v('[data-testid=db-grafana-session]')?.textContent.trim() ?? null, source: select?.value ?? null, options: [...(select?.options ?? [])].map((o) => o.textContent.trim()), url: v('[data-testid=db-grafana-url]')?.value ?? null, hostShown: [...document.querySelectorAll('label')].some((l) => l.offsetParent !== null && ['Host', 'Password'].includes(l.textContent.trim())), treeBadge: Boolean(${grafanaRow}?.querySelector('[data-testid=db-via-grafana]')) }; })()`,
          );
          check(
            'ui: the Access section of a Redis connection through Grafana shows who is signed in and picks among the Redis data sources, without host or password',
            JSON.stringify(form) ===
              JSON.stringify({
                session: 'Signed in as smoke@example.com',
                source: 'redis-smoke',
                options: ['Redis-ReadOnly (CLI off: read-only)', 'Redis-Smoke', 'Redis-Unreachable'],
                url: fakeGrafana.url,
                hostShown: false,
                treeBadge: true,
              }),
            form,
          );
          await shot('08b-redis-grafana-access-light');
          await js(`${grafanaRow}?.click()`);
          await wait(400);
          await js(`(() => { const rows = [...document.querySelectorAll('[role=button]')]; const at = rows.findIndex((r) => r.textContent.includes('grafana redis')); rows.slice(at).find((r) => r.textContent.trim() === 'Keys')?.click(); })()`);
          await until(async () => Boolean(await js(`[...document.querySelectorAll('button')].some((b) => b.offsetParent !== null && b.textContent.includes('session:abc'))`)), 6000);
          await js(`[...document.querySelectorAll('button')].find((b) => b.offsetParent !== null && b.textContent.includes('user:2'))?.click()`);
          await until(async () => Boolean(await js(`[...document.querySelectorAll('[role=gridcell]')].some((c) => c.offsetParent !== null && c.textContent === 'Linus')`)), 4000);
          await js(`document.documentElement.classList.add('dark')`);
          await wait(300);
          const browser = await js(
            `(() => { const v = ${visible}; return { badge: v('[data-testid=db-via-grafana]')?.textContent.trim() ?? null, keys: [...document.querySelectorAll('button')].filter((b) => b.offsetParent !== null && /(user|session|queue|tags|scores)/.test(b.textContent)).length, linus: [...document.querySelectorAll('[role=gridcell]')].some((c) => c.offsetParent !== null && c.textContent === 'Linus'), info: v('[data-testid=db-redis-info]')?.textContent ?? null }; })()`,
          );
          check(
            'ui: the key browser over Grafana lists the keys, shows a hash and the server info, and is marked via Grafana',
            typeof browser === 'object' && browser !== null && (browser as { badge: string }).badge === 'via Grafana' && (browser as { keys: number }).keys >= 5 && (browser as { linus: boolean }).linus && String((browser as { info: string }).info).includes('7.2.0-fake'),
            browser,
          );
          await shot('08c-redis-grafana-keys-dark');
        }
      },
    };
  },
});
