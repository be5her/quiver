import { promises as fs, writeSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import type {
  ApiRequest,
  ApiResponse,
  DbConnectionSummary,
  DbConnectionTest,
  DbHistoryEntry,
  DbQueryResult,
  DbTable,
  DbTableDetail,
  DbTableRows,
  Environment,
  HistoryEntry,
  RedisKeyDetail,
  RedisScanResult,
  SavedQuery,
  TeleportDatabase,
  TeleportKubeCluster,
  TeleportLoginResult,
  TeleportStatus,
  TeleportTunnel,
  WorkspaceInfo,
} from '@quiver/core';
import type { Host } from './host';
import { startFakeRedis } from './smoke-redis';
import { writeFakeTsh } from './smoke-tsh';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createTcpServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

/**
 * Headless end-to-end check used by `npm run smoke`. Exercises the command registry,
 * the file store, environments with secrets, HTTP sending, the MCP endpoint and a
 * renderer load, then exits non-zero on the first failure.
 */
export async function runSmokeTest(host: Host, openWindow: () => BrowserWindow): Promise<number> {
  const failures: string[] = [];
  let passes = 0;
  const check = (name: string, ok: boolean, detail?: unknown) => {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ''}`);
    if (ok) passes++;
    else failures.push(name);
  };
  const run = async <T>(id: string, input: unknown, workspaceId: string | null): Promise<T> => {
    const out = await host.invoke(id, input, { caller: 'ui', workspaceId });
    if (!out.ok) throw new Error(`${id}: ${out.error.code} ${out.error.message}`);
    return out.result as T;
  };

  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'quiver-smoke-'));
  const echo = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json', 'x-echo': 'yes' });
      res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body }));
    });
  });
  await new Promise<void>((r) => echo.listen(0, '127.0.0.1', () => r()));
  const echoPort = (echo.address() as { port: number }).port;
  const fakeRedis = await startFakeRedis();
  const tshDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quiver-smoke-tsh-'));
  const fakeTsh = await writeFakeTsh(tshDir, fakeRedis.port);

  try {
    // Never share the default MCP port with a Quiver that may already be running on this machine:
    // every MCP check below must hit this process, not an older build.
    const mcpPort = await freePort();
    await run('config.update', { patch: { mcp: { ...host.config.get().mcp, port: mcpPort } } }, null);
    check('mcp server listens on a private port', host.mcpStatus().running && host.mcpStatus().port === mcpPort, host.mcpStatus());

    const ws = await run<WorkspaceInfo>('workspace.open', { path: folder }, null);
    check('workspace.open', ws.path === folder, ws);

    const env = await run<Environment>('api.environment.create', { name: 'local' }, ws.id);
    const savedEnv = await run<Environment>(
      'api.environment.save',
      {
        environment: {
          ...env,
          variables: [
            { id: 'v1', key: 'baseUrl', value: `http://127.0.0.1:${echoPort}`, enabled: true },
            { id: 'v2', key: 'token', value: 's3cret', enabled: true, secret: true },
          ],
        },
      },
      ws.id,
    );
    check('environment secret round-trips', savedEnv.variables[1].value === 's3cret');
    const onDisk = JSON.parse(await fs.readFile(path.join(folder, '.quiver', 'environments', `${env.id}.json`), 'utf8')) as Environment;
    check('secret not written to committed file', onDisk.variables[1].value === '');
    await run('api.environment.setActive', { id: env.id }, ws.id);

    const created = await run<ApiRequest>('api.request.create', { name: 'echo', method: 'POST', url: '{{baseUrl}}/things?x=1' }, ws.id);
    const saved = await run<ApiRequest>(
      'api.request.save',
      {
        request: {
          ...created,
          headers: [{ id: 'h1', key: 'X-Test', value: '{{$uuid}}', enabled: true }],
          auth: { type: 'bearer', token: '{{token}}' },
          body: { type: 'json', content: '{"hello":"world"}' },
        },
      },
      ws.id,
    );
    const response = await run<ApiResponse>('api.request.send', { requestId: saved.id }, ws.id);
    const echoed = JSON.parse(response.body) as { headers: Record<string, string>; body: string; url: string };
    check('request.send status', response.status === 200, response.status);
    check('bearer token resolved from secret', echoed.headers.authorization === 'Bearer s3cret');
    check('json body sent', echoed.body === '{"hello":"world"}');
    check('query param kept', echoed.url === '/things?x=1', echoed.url);
    check('dynamic variable resolved', /^[0-9a-f-]{36}$/.test(echoed.headers['x-test'] ?? ''));

    const history = await run<HistoryEntry[]>('api.history.list', { limit: 5 }, ws.id);
    check('history recorded', history.length === 1 && history[0].status === 200);

    const imported = await run<ApiRequest>('api.import.curl', { command: `curl -X PUT '{{baseUrl}}/a?b=c' -H 'X-A: 1' -d '{"k":1}'` }, ws.id);
    check('curl import', imported.method === 'PUT' && imported.body.type === 'json');
    const curl = await run<{ command: string }>('api.export.curl', { requestId: imported.id }, ws.id);
    check('curl export resolves variables', curl.command.includes(`http://127.0.0.1:${echoPort}/a?b=c`), curl.command);

    const missing = await host.invoke('api.request.send', { request: { ...saved, url: '{{nope}}/x' } }, { caller: 'ui', workspaceId: ws.id });
    check('unresolved variable is reported', !missing.ok && missing.error.code === 'UNRESOLVED_VARIABLES');

    const jwt = await run<{ payload: { sub: string } }>(
      'tools.jwt.decode',
      { token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c' },
      null,
    );
    check('tools.jwt.decode', jwt.payload.sub === '1234567890');


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

    // ---------- teleport: fake tsh driving status, login, db/kube listing and tunnels ----------
    interface ConnectOut {
      tunnel: TeleportTunnel;
      connection: DbConnectionSummary | null;
      message: string | null;
    }
    await run('config.update', { patch: { teleport: { proxy: 'smoke.teleport.local:443', tshPath: fakeTsh.command, loginOnLaunch: false } } }, null);
    const t0 = await run<TeleportStatus>('teleport.status', { refresh: true }, null);
    check('teleport: tsh from settings', t0.tshSource === 'settings' && t0.tshVersion === '16.0.0-fake', { tsh: t0.tsh, version: t0.tshVersion, error: t0.error });
    check('teleport: logged out before login', t0.state === 'logged-out' && t0.proxy === 'smoke.teleport.local:443', t0.state);
    const dbsWhileOut = await host.invoke('teleport.db.list', {}, { caller: 'ui', workspaceId: null });
    check('teleport: db list needs a session', !dbsWhileOut.ok && dbsWhileOut.error.code === 'TELEPORT_LOGIN_REQUIRED', dbsWhileOut.ok ? 'ok?' : dbsWhileOut.error.code);
    const loginResult = await run<TeleportLoginResult>('teleport.login', {}, null);
    check('teleport: login completes', loginResult.ok && loginResult.status.state === 'logged-in' && loginResult.status.user === 'smoke-user' && loginResult.status.cluster === 'smoke.teleport.local', loginResult.output);
    check('teleport: login output shows the browser link', loginResult.output.some((l) => l.includes('http://127.0.0.1:61234')));
    check('teleport: certificate expiry parsed', typeof loginResult.status.validUntil === 'string' && new Date(loginResult.status.validUntil).getTime() > Date.now(), loginResult.status.validUntil);
    const dbs = await run<TeleportDatabase[]>('teleport.db.list', {}, null);
    check('teleport: db ls parsed', dbs.length === 4 && dbs.find((d) => d.name === 'orders-mysql')?.allowedUsers.join(',') === 'app,readonly' && dbs.find((d) => d.name === 'analytics-pg')?.protocol === 'postgres', dbs.map((d) => d.name));
    const kubes = await run<TeleportKubeCluster[]>('teleport.kube.list', {}, null);
    check('teleport: kube ls parsed', kubes.length === 2 && kubes.every((k) => !k.selected), kubes);
    const kubeLogin = await run<{ cluster: string; output: string }>('teleport.kube.login', { cluster: 'dev-eks' }, null);
    const kubesAfter = await run<TeleportKubeCluster[]>('teleport.kube.list', { refresh: true }, null);
    const statusKube = await run<TeleportStatus>('teleport.status', { refresh: true }, null);
    check('teleport: kube login selects the cluster', kubeLogin.output.includes('dev-eks') && kubesAfter.find((k) => k.name === 'dev-eks')?.selected === true && statusKube.kubeCluster === 'dev-eks', kubesAfter);
    const connected = await run<ConnectOut>('teleport.db.connect', { database: 'smoke-redis' }, ws.id);
    check(
      'teleport: db connect starts a tunnel and creates a connection',
      connected.tunnel.port > 0 && connected.connection?.kind === 'redis' && connected.connection.access.type === 'teleport' && connected.connection.access.dbUser === 'default',
      { tunnel: connected.tunnel.port, connection: connected.connection?.access },
    );
    const teleportConn = connected.connection!;
    const viaTunnel = await run<DbQueryResult[]>('db.query.run', { connectionId: teleportConn.id, query: 'PING\nLLEN queue', record: false }, ws.id);
    check('teleport: query through the tunnel', viaTunnel[0].value === 'PONG' && viaTunnel[1].value === 3, viaTunnel.map((r) => r.value));
    const again = await run<ConnectOut>('teleport.db.connect', { database: 'smoke-redis' }, ws.id);
    check('teleport: connect reuses tunnel and connection', again.tunnel.id === connected.tunnel.id && again.connection?.id === teleportConn.id);
    const pgOnly = await run<ConnectOut>('teleport.db.connect', { database: 'analytics-pg', dbUser: 'readonly' }, ws.id);
    check('teleport: unsupported protocol still gets a tunnel', pgOnly.connection === null && pgOnly.tunnel.port > 0 && /no postgres client/.test(pgOnly.message ?? ''), pgOnly.message);
    const ambiguous = await host.invoke('teleport.db.connect', { database: 'orders-mysql' }, { caller: 'ui', workspaceId: ws.id });
    check('teleport: ambiguous db user is refused with the allowed list', !ambiguous.ok && ambiguous.error.code === 'INVALID_INPUT' && /app, readonly/.test(ambiguous.error.message), ambiguous.ok ? 'ok?' : ambiguous.error.message);
    const status1 = await run<TeleportStatus>('teleport.status', {}, null);
    const redisTunnel = status1.tunnels.find((t) => t.target === 'smoke-redis');
    check('teleport: status lists tunnels with their users', status1.tunnels.length === 2 && Boolean(redisTunnel?.users.includes('pinned')) && Boolean(redisTunnel?.users.some((u) => u.endsWith(`/${teleportConn.id}`))), status1.tunnels.map((t) => [t.target, t.users]));
    const dbsWithTunnel = await run<TeleportDatabase[]>('teleport.db.list', {}, null);
    check('teleport: db list shows the tunnel', dbsWithTunnel.find((d) => d.name === 'smoke-redis')?.tunnel?.port === connected.tunnel.port);
    const stopped = await run<{ stopped: number }>('teleport.db.disconnect', { database: 'smoke-redis' }, null);
    const statusStopped = await run<TeleportStatus>('teleport.status', {}, null);
    check('teleport: disconnect stops the tunnel', stopped.stopped === 1 && !statusStopped.tunnels.some((t) => t.target === 'smoke-redis'), statusStopped.tunnels.map((t) => t.target));
    const auto = await run<DbQueryResult[]>('db.query.run', { connectionId: teleportConn.id, query: 'PING', record: false }, ws.id);
    const status2 = await run<TeleportStatus>('teleport.status', {}, null);
    const restarted = status2.tunnels.find((t) => t.target === 'smoke-redis');
    check('teleport: query restarts a stopped tunnel', auto[0].value === 'PONG' && Boolean(restarted) && restarted?.id !== connected.tunnel.id, restarted?.id);
    await run('teleport.db.disconnect', { tunnelId: pgOnly.tunnel.id }, null);
    const broken = await run<DbConnectionSummary>('db.connection.save', { connection: { kind: 'redis', name: 'broken', access: { type: 'teleport', database: 'broken-db', dbUser: 'default' } } }, ws.id);
    const brokenTest = await host.invoke('db.connection.test', { id: broken.id }, { caller: 'ui', workspaceId: ws.id });
    check('teleport: tunnel stderr surfaces as the connection error', !brokenTest.ok && brokenTest.error.code === 'REQUEST_FAILED' && /broken-db.*not found/.test(brokenTest.error.message), brokenTest.ok ? 'ok?' : brokenTest.error.message);
    const cmdConn = await run<DbConnectionSummary>(
      'db.connection.save',
      { connection: { kind: 'redis', name: 'via command', access: { type: 'command', command: `${fakeTsh.command} __forward {port} ${fakeRedis.port}` } }, password: 'hunter2' },
      ws.id,
    );
    const cmdTest = await run<DbConnectionTest>('db.connection.test', { id: cmdConn.id }, ws.id);
    check('teleport: command tunnel with {port} placeholder', cmdTest.serverVersion === 'Redis 7.2.0-fake', cmdTest.serverVersion);
    const status3 = await run<TeleportStatus>('teleport.status', {}, null);
    check('teleport: command tunnel listed', status3.tunnels.some((t) => t.kind === 'command' && t.target.includes('__forward')), status3.tunnels.map((t) => t.kind));
    const badCmd = await host.invoke('db.connection.test', { connection: { kind: 'redis', name: 'x', access: { type: 'command', command: 'definitely-not-a-program-xyz {port}' } } }, { caller: 'ui', workspaceId: ws.id });
    check('teleport: missing tunnel program is reported', !badCmd.ok && /definitely-not-a-program-xyz/.test(badCmd.error.message), badCmd.ok ? 'ok?' : badCmd.error.message);
    // Expired certificate: the tunnel is down, so the next query must ask for a login instead of hanging.
    await run('teleport.db.disconnect', { database: 'smoke-redis' }, null);
    const state = await fakeTsh.getState();
    await fakeTsh.setState({ ...state!, validUntil: new Date(Date.now() - 60_000).toISOString() });
    const expired = await run<TeleportStatus>('teleport.status', { refresh: true }, null);
    check('teleport: expired certificate detected', expired.state === 'expired' && expired.user === 'smoke-user', expired.state);
    const expiredQuery = await host.invoke('db.query.run', { connectionId: teleportConn.id, query: 'PING', record: false }, { caller: 'ui', workspaceId: ws.id });
    check('teleport: expired session yields TELEPORT_LOGIN_REQUIRED', !expiredQuery.ok && expiredQuery.error.code === 'TELEPORT_LOGIN_REQUIRED', expiredQuery.ok ? 'ok?' : expiredQuery.error);
    const relogin = await run<TeleportLoginResult>('teleport.login', {}, null);
    check('teleport: log in again restores the session', relogin.ok && relogin.status.state === 'logged-in', relogin.status.state);
    const afterRelogin = await run<DbQueryResult[]>('db.query.run', { connectionId: teleportConn.id, query: 'PING', record: false }, ws.id);
    check('teleport: query works after re-login', afterRelogin[0].value === 'PONG');

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

    // MCP over HTTP, stateless.
    const mcpUrl = `http://127.0.0.1:${host.config.get().mcp.port}/mcp?workspace=${encodeURIComponent(folder)}`;
    const rpc = async (method: string, params: unknown) => {
      const res = await fetch(mcpUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      return (await res.json()) as { result?: { tools?: { name: string }[]; content?: { text: string }[]; isError?: boolean }; error?: unknown };
    };
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } });
    check('mcp initialize', !init.error, init.error);
    const tools = await rpc('tools/list', {});
    const names = tools.result?.tools?.map((t) => t.name) ?? [];
    check('mcp lists api tools', names.includes('api_request_send') && names.includes('tools_json_format'), names.length);
    check('mcp hides plumbing', !names.includes('config_update'));
    const call = await rpc('tools/call', { name: 'api_request_send', arguments: { requestId: saved.id } });
    const called = JSON.parse(call.result?.content?.[0]?.text ?? '{}') as ApiResponse;
    check('mcp tools/call sends request', called.status === 200, call.error ?? called.status);
    const blocked = await rpc('tools/call', { name: 'api_request_delete', arguments: { id: imported.id } });
    check('mcp blocks mutations by default', blocked.result?.isError === true && (blocked.result.content?.[0]?.text ?? '').includes('MUTATION_BLOCKED'));
    const masked = await rpc('tools/call', { name: 'api_environment_get', arguments: { id: env.id } });
    check('mcp masks secrets', !(masked.result?.content?.[0]?.text ?? '').includes('s3cret'));
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
    check(
      'mcp lists teleport tools',
      ['teleport_status', 'teleport_db_list', 'teleport_db_connect', 'teleport_kube_list'].every((n) => names.includes(n)) && !names.includes('teleport_login_cancel'),
      { total: names.length, teleport: names.filter((n) => n.startsWith('teleport')) },
    );
    const mcpTeleport = await rpc('tools/call', { name: 'teleport_status', arguments: {} });
    const mcpTeleportText = mcpTeleport.result?.content?.[0]?.text ?? '';
    check('mcp reads teleport status', mcpTeleportText.startsWith('{') && JSON.parse(mcpTeleportText).state === 'logged-in', mcpTeleportText.slice(0, 200) || mcpTeleport.error);
    const mcpDbs = await rpc('tools/call', { name: 'teleport_db_list', arguments: {} });
    check('mcp lists teleport databases', (JSON.parse(mcpDbs.result?.content?.[0]?.text ?? '[]') as unknown[]).length === 4);
    for (const tool of ['teleport_login', 'teleport_logout', 'teleport_kube_login', 'teleport_db_disconnect']) {
      const blockedTool = await rpc('tools/call', { name: tool, arguments: tool === 'teleport_kube_login' ? { cluster: 'prod-eks' } : tool === 'teleport_db_disconnect' ? { database: 'smoke-redis' } : {} });
      check(`mcp blocks ${tool} by default`, blockedTool.result?.isError === true && (blockedTool.result.content?.[0]?.text ?? '').includes('MUTATION_BLOCKED'));
    }
    const mcpConnect = await rpc('tools/call', { name: 'teleport_db_connect', arguments: { database: 'smoke-redis' } });
    check('mcp can open a teleport tunnel for reads', mcpConnect.result?.isError !== true && (JSON.parse(mcpConnect.result?.content?.[0]?.text ?? '{}') as ConnectOut).tunnel?.port > 0, mcpConnect.result?.content?.[0]?.text?.slice(0, 200));

    // Renderer boots without console errors.
    const win = openWindow();
    const errors: string[] = [];
    win.webContents.on('console-message', (e) => {
      if (e.level === 'error') errors.push(e.message);
    });
    await new Promise<void>((resolve, reject) => {
      win.webContents.once('did-finish-load', () => resolve());
      win.webContents.once('did-fail-load', (_e, code, desc) => reject(new Error(`renderer failed to load: ${code} ${desc}`)));
    });
    await new Promise((r) => setTimeout(r, 2500));
    const title = await win.webContents.executeJavaScript('document.querySelector("[data-testid=app-ready]") ? "ready" : "not-ready"');
    check('renderer mounted', title === 'ready', title);

    // Optional: drive the UI and capture screenshots for visual review.
    const shotsDir = process.env.QUIVER_SMOKE_SHOTS;
    if (shotsDir) {
      await fs.mkdir(shotsDir, { recursive: true });
      const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const js = (code: string) => win.webContents.executeJavaScript(code) as Promise<unknown>;
      const shot = async (name: string) => {
        const image = await win.webContents.capturePage();
        await fs.writeFile(path.join(shotsDir, `${name}.png`), image.toPNG());
      };
      await js(`document.documentElement.classList.add('dark')`);
      await wait(300);
      await shot('01-welcome-dark');
      const clickedRow = await js(
        `(() => { const row = [...document.querySelectorAll('[role=button]')].find((r) => r.textContent.includes('echo')); if (row) row.click(); return Boolean(row); })()`,
      );
      check('ui: request row clickable', clickedRow === true);
      await wait(800);
      const clickedSend = await js(
        `(() => { const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Send'); if (btn) btn.click(); return Boolean(btn); })()`,
      );
      check('ui: send button present', clickedSend === true);
      await wait(1500);
      const status = await js(`(() => { const el = [...document.querySelectorAll('span')].find((s) => /^200 /.test(s.textContent)); return el ? el.textContent : null; })()`);
      check('ui: response rendered', typeof status === 'string' && status.startsWith('200'), status);
      await shot('02-request-dark');
      await js(`document.documentElement.classList.remove('dark')`);
      await wait(300);
      await shot('03-request-light');
      await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))`);
      await wait(400);
      await shot('04-palette-light');
      await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
      await wait(200);

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
      await shot('05-table-light');
      const clickedQuery = await js(
        `(() => { const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Query'); if (btn) btn.click(); return Boolean(btn); })()`,
      );
      check('ui: open query from table', clickedQuery === true);
      await wait(800);
      const clickedRun = await js(
        `(() => { const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Run'); if (btn) btn.click(); return Boolean(btn); })()`,
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
      await shot('08-redis-dark');

      // Teleport module: status card, databases with tunnel state, kube clusters.
      const clickedTeleport = await js(
        `(() => { const btn = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || b.title || '') === 'Teleport'); if (btn) btn.click(); return Boolean(btn); })()`,
      );
      check('ui: teleport module button', clickedTeleport === true);
      await wait(1200);
      const cardState = await js(`document.querySelector('[data-testid=teleport-status]')?.getAttribute('data-state') ?? null`);
      check('ui: teleport status card logged in', cardState === 'logged-in', cardState);
      const cardText = await js(`document.querySelector('[data-testid=teleport-status]')?.textContent ?? ''`);
      check('ui: status card shows user, cluster and countdown', typeof cardText === 'string' && cardText.includes('smoke-user') && cardText.includes('smoke.teleport.local') && /\d+h \d+m left/.test(cardText), cardText);
      const dbRows = await js(`document.querySelectorAll('[data-testid=teleport-db]').length`);
      check('ui: teleport databases listed', dbRows === 4, dbRows);
      const tunnelShown = await js(`[...document.querySelectorAll('[data-testid=teleport-db]')].find((r) => r.textContent.includes('smoke-redis'))?.textContent ?? ''`);
      check('ui: running tunnel shown on its database row', typeof tunnelShown === 'string' && /:\d+/.test(tunnelShown) && tunnelShown.includes('as default'), tunnelShown);
      const kubeRows = await js(`[...document.querySelectorAll('[data-testid=teleport-kube]')].map((r) => r.textContent)`);
      check('ui: kube clusters listed with the active one', Array.isArray(kubeRows) && kubeRows.length === 2 && kubeRows.some((t: string) => t.includes('dev-eks') && t.includes('active')), kubeRows);
      await shot('09-teleport-dark');
      await js(`document.documentElement.classList.remove('dark')`);
      await wait(300);
      await shot('10-teleport-light');
      const clickedStop = await js(
        `(() => { const row = [...document.querySelectorAll('[data-testid=teleport-db]')].find((r) => r.textContent.includes('smoke-redis')); const btn = row && [...row.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Stop'); if (btn) btn.click(); return Boolean(btn); })()`,
      );
      check('ui: stop button on the tunnel row', clickedStop === true);
      await wait(1500);
      const afterStop = await js(`[...document.querySelectorAll('[data-testid=teleport-db]')].find((r) => r.textContent.includes('smoke-redis'))?.textContent ?? ''`);
      check('ui: row shows Connect after stopping', typeof afterStop === 'string' && !/:\d+/.test(afterStop), afterStop);
      const clickedConnect = await js(
        `(() => { const row = [...document.querySelectorAll('[data-testid=teleport-db]')].find((r) => r.textContent.includes('smoke-redis')); const btn = row && [...row.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Connect'); if (btn) btn.click(); return Boolean(btn); })()`,
      );
      check('ui: connect button on the database row', clickedConnect === true);
      await wait(2500);
      const revealed = await js(`(() => { const aside = document.querySelector('aside'); return aside ? aside.textContent.includes('Databases') && aside.textContent.includes('smoke-redis') : false; })()`);
      check('ui: connect reveals the connection in the Databases tree', revealed === true);
      const keysTabOpen = await js(`Boolean(document.querySelector('[data-tab-type="db.redis"]'))`);
      check('ui: connect opens the key browser', keysTabOpen === true);
      await shot('11-teleport-revealed-light');
    }

    const loggedOut = await run<TeleportStatus>('teleport.logout', {}, null);
    check('teleport: logout clears the session and tunnels', loggedOut.state === 'logged-out' && loggedOut.tunnels.length === 0, { state: loggedOut.state, tunnels: loggedOut.tunnels.length });

    check('renderer has no console errors', errors.length === 0, errors);
    win.destroy();
  } catch (err) {
    check(`unexpected error: ${(err as Error).message}`, false);
    console.error(err);
  } finally {
    echo.close();
    await fakeRedis.close();
    await fs.rm(folder, { recursive: true, force: true }).catch(() => {});
    await fs.rm(tshDir, { recursive: true, force: true }).catch(() => {});
  }

  const summary = failures.length ? `SMOKE FAILED: ${failures.join(', ')}` : `SMOKE PASSED (${passes} checks)`;
  console.log(`MCP port used by this run: ${host.config.get().mcp.port}`);
  try {
    // Synchronous write: piped stdout on Windows can drop the last async console.log before exit.
    writeSync(1, `${summary}
`);
  } catch {
    console.log(summary);
  }
  return failures.length ? 1 : 0;
}
