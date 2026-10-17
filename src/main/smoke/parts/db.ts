import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseConnectionUrl } from '@quiver/core';
import type { DbConnectionSummary, DbExportResult, DbSchemaMatch, DbTableApplyResult, DbTableColumns, DbConnectionTest, DbHistoryEntry, DbQueryResult, DbTable, DbTableDetail, RedisInfo, DbTableRows, RedisKeyDetail, RedisScanResult, SavedQuery } from '@quiver/core';
import { definePart } from '../part';

export default definePart({
  name: 'db',
  summary: 'Databases: SQLite, the fake Redis, live MySQL/PostgreSQL when configured, agents over MCP, the grid and key browser',
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
      },
    };
  },
});
