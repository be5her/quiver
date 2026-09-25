import { execFile } from 'node:child_process';
import { promises as fs, writeSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { BrowserWindow } from 'electron';
import { buildSchema, graphql as executeGraphql } from 'graphql';
import type { WebSocket as WsSocket } from 'ws';
import { DEFAULT_PALETTE, capabilityLabels, contentText, expandUriTemplate, resolvePalette, skeletonFromSchema } from '@quiver/core';
import type {
  ApiRequest,
  ApiResponse,
  GraphqlSchemaDoc,
  DbConnectionSummary,
  DbConnectionTest,
  DbHistoryEntry,
  DbQueryResult,
  DbTable,
  DbTableDetail,
  DbTableRows,
  EnvBackup,
  EnvDiff,
  EnvFileContent,
  EnvFileSummary,
  EnvProfileGroup,
  Environment,
  HistoryEntry,
  McpConfigFile,
  McpLogEntry,
  McpPrompt,
  McpPromptResult,
  McpReadResourceResult,
  McpResource,
  McpResourceTemplate,
  McpServerSummary,
  McpTool,
  McpToolCallOutcome,
  MockCapturedRequest,
  MockReplayResult,
  MockRoute,
  MockServerSummary,
  RealtimeConnectionSummary,
  RealtimeMessage,
  RedisKeyDetail,
  RedisScanResult,
  SavedQuery,
  TeleportDatabase,
  TeleportKubeCluster,
  TeleportLoginResult,
  TeleportPin,
  TeleportStatus,
  TeleportTunnel,
  UpdateState,
  WorkspaceInfo,
} from '@quiver/core';
import type { Host } from './host';
import { startFakeMcpHttp, writeFakeMcpStdio } from './smoke-mcp';
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
  const hooksFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'quiver-smoke-hooks-'));
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

  // GraphQL endpoint: a small schema executed by graphql-js, over POST (JSON) and GET (query parameters).
  const gqlSchema = buildSchema(`
    """A person"""
    type User {
      id: ID!
      name: String!
      email: String @deprecated(reason: "use contact")
    }
    type Query {
      """Greets by name"""
      hello(name: String = "world"): String!
      user(id: ID!): User
      users: [User!]!
    }
    type Mutation {
      rename(id: ID!, name: String!): User!
    }
  `);
  const gqlUsers = new Map([
    ['1', { id: '1', name: 'Ada' }],
    ['2', { id: '2', name: 'Linus' }],
  ]);
  const gqlRoot = {
    hello: ({ name }: { name: string }) => `Hello, ${name}`,
    user: ({ id }: { id: string }) => gqlUsers.get(id) ?? null,
    users: () => [...gqlUsers.values()],
    rename: ({ id, name }: { id: string; name: string }) => {
      const u = gqlUsers.get(id)!;
      u.name = name;
      return u;
    },
  };
  let gqlAuthSeen: string | null = null;
  let gqlLastMethod = '';
  const gql = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      void (async () => {
        gqlAuthSeen = req.headers.authorization ?? null;
        gqlLastMethod = req.method ?? '';
        let payload: { query?: string; variables?: Record<string, unknown> | string | null; operationName?: string | null } = {};
        if (req.method === 'GET') {
          const u = new URL(req.url ?? '/', 'http://x');
          payload = { query: u.searchParams.get('query') ?? '', variables: u.searchParams.get('variables'), operationName: u.searchParams.get('operationName') };
        } else {
          payload = JSON.parse(body || '{}') as typeof payload;
        }
        const variableValues = typeof payload.variables === 'string' ? (JSON.parse(payload.variables) as Record<string, unknown>) : (payload.variables ?? undefined);
        const result = await executeGraphql({ schema: gqlSchema, source: payload.query ?? '', rootValue: gqlRoot, variableValues, operationName: payload.operationName ?? undefined });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(result));
      })().catch((err) => {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end(String(err));
      });
    });
  });
  await new Promise<void>((r) => gql.listen(0, '127.0.0.1', () => r()));
  const gqlPort = (gql.address() as { port: number }).port;

  // SSE endpoint: two events, then the server drops the stream; a reconnect must carry Last-Event-ID.
  const sseSeen: { lastEventId: string | null; method: string; body: string; accept: string }[] = [];
  const sse = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname === '/missing') {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('no such stream');
        return;
      }
      if (url.pathname === '/plain') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('not a stream');
        return;
      }
      const lastEventId = req.headers['last-event-id'] ?? null;
      sseSeen.push({ lastEventId: Array.isArray(lastEventId) ? lastEventId[0] : lastEventId, method: req.method ?? '', body, accept: String(req.headers.accept ?? '') });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      if (url.pathname === '/echo') {
        res.write(`event: echo\ndata: ${body}\n\n`);
        return;
      }
      if (lastEventId === null) {
        res.write('retry: 200\n\n');
        res.write('id: 1\nevent: tick\ndata: {"n":1}\n\n');
        res.write(': keep-alive\n');
        res.write('id: 2\ndata: line one\ndata: line two\n\n');
        setTimeout(() => res.end(), 150);
      } else {
        res.write(`id: 3\nevent: resumed\ndata: after ${lastEventId}\n\n`);
      }
    });
  });
  await new Promise<void>((r) => sse.listen(0, '127.0.0.1', () => r()));
  const ssePort = (sse.address() as { port: number }).port;

  // WebSocket endpoint (the `ws` dev dependency): greets with what the handshake carried, echoes, closes on request.
  const { WebSocketServer } = await import('ws');
  const wsHttp = createServer();
  const wss = new WebSocketServer({ server: wsHttp, handleProtocols: (protocols) => (protocols.has('quiver.v1') ? 'quiver.v1' : false) });
  const wsSockets = new Set<WsSocket>();
  wss.on('connection', (socket, req) => {
    wsSockets.add(socket);
    socket.on('close', () => wsSockets.delete(socket));
    socket.send(JSON.stringify({ hello: 'client', auth: req.headers.authorization ?? null, path: req.url }));
    socket.on('message', (data, isBinary) => {
      if (isBinary) socket.send(Buffer.concat([Buffer.from('bin:'), data as Buffer]), { binary: true });
      else if (String(data) === 'bye') socket.close(4001, 'client asked');
      else socket.send(`echo:${String(data)}`);
    });
  });
  await new Promise<void>((r) => wsHttp.listen(0, '127.0.0.1', () => r()));
  const wsPort = (wsHttp.address() as { port: number }).port;

  const fakeRedis = await startFakeRedis();
  const tshDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quiver-smoke-tsh-'));
  const fakeTsh = await writeFakeTsh(tshDir, fakeRedis.port);
  // MCP servers for the inspector: a stdio script, plus Streamable HTTP and legacy SSE endpoints in process.
  const mcpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quiver-smoke-mcp-'));
  const fakeStdio = await writeFakeMcpStdio(mcpDir);
  const fakeMcp = await startFakeMcpHttp();

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

    // ---------- teleport: fake tsh driving status, login, db/kube listing, pins and tunnels across two clusters ----------
    interface ConnectOut {
      tunnel: TeleportTunnel;
      connection: DbConnectionSummary | null;
      message: string | null;
    }
    const { first, second } = fakeTsh.proxies;
    const clusterOf = (s: TeleportStatus, proxy: string) => s.clusters.find((c) => c.proxy === proxy);
    await run('config.update', { patch: { teleport: { proxies: [first], pins: [], tshPath: fakeTsh.command, loginOnLaunch: false } } }, null);
    const t0 = await run<TeleportStatus>('teleport.status', { refresh: true }, null);
    check('teleport: tsh from settings', t0.tshSource === 'settings' && t0.tshVersion === '16.0.0-fake', { tsh: t0.tsh, version: t0.tshVersion, error: t0.error });
    check('teleport: configured cluster shows as logged out', t0.state === 'logged-out' && t0.clusters.length === 1 && clusterOf(t0, first)?.state === 'logged-out' && clusterOf(t0, first)?.configured === true, t0.clusters);
    const dbsWhileOut = await host.invoke('teleport.db.list', { proxy: first }, { caller: 'ui', workspaceId: null });
    check('teleport: db list needs a session', !dbsWhileOut.ok && dbsWhileOut.error.code === 'TELEPORT_LOGIN_REQUIRED' && (dbsWhileOut.error.details as { proxy?: string })?.proxy === first, dbsWhileOut.ok ? 'ok?' : dbsWhileOut.error);
    const loginResult = await run<TeleportLoginResult>('teleport.login', {}, null);
    const c1 = clusterOf(loginResult.status, first);
    check('teleport: login completes', loginResult.ok && loginResult.proxy === first && c1?.state === 'logged-in' && c1.user === 'smoke-user' && c1.cluster === 'smoke.teleport.local' && c1.current, loginResult.output);
    check('teleport: login output shows the browser link', loginResult.output.some((l) => l.includes('http://127.0.0.1:61234')));
    check('teleport: certificate expiry parsed', typeof c1?.validUntil === 'string' && new Date(c1.validUntil).getTime() > Date.now(), c1?.validUntil);
    const added = await run<TeleportStatus>('teleport.cluster.add', { proxy: second }, null);
    check('teleport: cluster add lists it as logged out', added.clusters.length === 2 && clusterOf(added, second)?.state === 'logged-out' && clusterOf(added, second)?.configured === true, added.clusters.map((c) => [c.proxy, c.state]));
    const ambiguousLogin = await host.invoke('teleport.login', {}, { caller: 'ui', workspaceId: null });
    check('teleport: login needs a proxy with several clusters', !ambiguousLogin.ok && ambiguousLogin.error.code === 'INVALID_INPUT' && ambiguousLogin.error.message.includes(second), ambiguousLogin.ok ? 'ok?' : ambiguousLogin.error.message);
    const login2 = await run<TeleportLoginResult>('teleport.login', { proxy: second }, null);
    check(
      'teleport: second cluster logs in independently',
      login2.ok && clusterOf(login2.status, second)?.state === 'logged-in' && clusterOf(login2.status, first)?.state === 'logged-in' && clusterOf(login2.status, second)?.current === true && clusterOf(login2.status, first)?.current === false,
      login2.status.clusters.map((c) => [c.proxy, c.state, c.current]),
    );
    const dbs = await run<TeleportDatabase[]>('teleport.db.list', {}, null);
    check(
      'teleport: db ls across clusters',
      dbs.length === 6 && dbs.filter((d) => d.proxy === first).length === 4 && dbs.find((d) => d.name === 'second-redis')?.proxy === second && dbs.find((d) => d.name === 'orders-mysql')?.allowedUsers.join(',') === 'app,readonly',
      dbs.map((d) => [d.proxy, d.name]),
    );
    const dbsSecond = await run<TeleportDatabase[]>('teleport.db.list', { proxy: second }, null);
    check('teleport: db ls for one cluster', dbsSecond.length === 2 && dbsSecond.every((d) => d.proxy === second && d.clusterName === 'second.teleport.local'), dbsSecond.map((d) => d.name));
    const kubes = await run<TeleportKubeCluster[]>('teleport.kube.list', {}, null);
    check('teleport: kube ls across clusters', kubes.length === 3 && kubes.every((k) => !k.selected) && kubes.find((k) => k.name === 'eu-eks')?.proxy === second, kubes);
    const kubeLogin = await run<{ proxy: string; cluster: string; output: string }>('teleport.kube.login', { cluster: 'dev-eks' }, null);
    const kubesAfter = await run<TeleportKubeCluster[]>('teleport.kube.list', { refresh: true }, null);
    const statusKube = await run<TeleportStatus>('teleport.status', { refresh: true }, null);
    check(
      'teleport: kube login selects the cluster on the right proxy',
      kubeLogin.proxy === first && kubeLogin.output.includes('dev-eks') && kubesAfter.find((k) => k.name === 'dev-eks')?.selected === true && clusterOf(statusKube, first)?.kubeCluster === 'dev-eks' && !clusterOf(statusKube, second)?.kubeCluster,
      kubesAfter,
    );
    const pins1 = await run<TeleportPin[]>('teleport.pin', { proxy: first, kind: 'db', name: 'smoke-redis' }, null);
    const pins2 = await run<TeleportPin[]>('teleport.pin', { proxy: second, kind: 'kube', name: 'eu-eks', pinned: true }, null);
    check('teleport: pins from both clusters', pins1.length === 1 && pins2.length === 2 && pins2.some((p) => p.proxy === second && p.kind === 'kube' && p.name === 'eu-eks'), pins2);
    const pinnedDbs = await run<TeleportDatabase[]>('teleport.db.list', {}, null);
    check('teleport: db list flags pinned', pinnedDbs.find((d) => d.name === 'smoke-redis')?.pinned === true && pinnedDbs.find((d) => d.name === 'second-redis')?.pinned === false);
    const pinsToggled = await run<TeleportPin[]>('teleport.pin', { proxy: 'SMOKE.teleport.local', kind: 'db', name: 'smoke-redis' }, null);
    check('teleport: pin toggles off with a loosely written proxy', pinsToggled.length === 1 && pinsToggled[0].kind === 'kube', pinsToggled);
    await run('teleport.pin', { proxy: first, kind: 'db', name: 'smoke-redis', pinned: true }, null);
    const statusPins = await run<TeleportStatus>('teleport.status', {}, null);
    check('teleport: status carries pins and the config keeps them', statusPins.pins.length === 2 && host.config.get().teleport.pins.length === 2);
    const connected = await run<ConnectOut>('teleport.db.connect', { database: 'smoke-redis' }, ws.id);
    check(
      'teleport: db connect infers the cluster, starts a tunnel and creates a connection',
      connected.tunnel.port > 0 && connected.tunnel.proxy === first && connected.connection?.kind === 'redis' && connected.connection.access.type === 'teleport' && connected.connection.access.proxy === first && connected.connection.access.dbUser === 'default',
      { tunnel: connected.tunnel.port, connection: connected.connection?.access },
    );
    const teleportConn = connected.connection!;
    const viaTunnel = await run<DbQueryResult[]>('db.query.run', { connectionId: teleportConn.id, query: 'PING\nLLEN queue', record: false }, ws.id);
    check('teleport: query through the tunnel', viaTunnel[0].value === 'PONG' && viaTunnel[1].value === 3, viaTunnel.map((r) => r.value));
    const again = await run<ConnectOut>('teleport.db.connect', { database: 'smoke-redis' }, ws.id);
    check('teleport: connect reuses tunnel and connection', again.tunnel.id === connected.tunnel.id && again.connection?.id === teleportConn.id);
    const onSecond = await run<ConnectOut>('teleport.db.connect', { proxy: second, database: 'second-redis' }, ws.id);
    check(
      'teleport: connect on the second cluster',
      onSecond.tunnel.proxy === second && onSecond.connection?.access.type === 'teleport' && onSecond.connection.access.proxy === second && onSecond.connection.id !== teleportConn.id,
      onSecond.connection?.access,
    );
    const viaSecond = await run<DbQueryResult[]>('db.query.run', { connectionId: onSecond.connection!.id, query: 'PING', record: false }, ws.id);
    check('teleport: query through the second cluster tunnel', viaSecond[0].value === 'PONG');
    const pgOnly = await run<ConnectOut>('teleport.db.connect', { database: 'analytics-pg', dbUser: 'readonly' }, ws.id);
    check('teleport: unsupported protocol still gets a tunnel', pgOnly.connection === null && pgOnly.tunnel.port > 0 && /no postgres client/.test(pgOnly.message ?? ''), pgOnly.message);
    const ambiguous = await host.invoke('teleport.db.connect', { database: 'orders-mysql' }, { caller: 'ui', workspaceId: ws.id });
    check('teleport: ambiguous db user is refused with the allowed list', !ambiguous.ok && ambiguous.error.code === 'INVALID_INPUT' && /app, readonly/.test(ambiguous.error.message), ambiguous.ok ? 'ok?' : ambiguous.error.message);
    const status1 = await run<TeleportStatus>('teleport.status', {}, null);
    const redisTunnel = status1.tunnels.find((t) => t.target === 'smoke-redis');
    check(
      'teleport: status lists tunnels per cluster with their users',
      status1.tunnels.length === 3 && Boolean(redisTunnel?.users.includes('pinned')) && Boolean(redisTunnel?.users.some((u) => u.endsWith(`/${teleportConn.id}`))) && status1.tunnels.some((t) => t.proxy === second),
      status1.tunnels.map((t) => [t.proxy, t.target, t.users]),
    );
    const dbsWithTunnel = await run<TeleportDatabase[]>('teleport.db.list', {}, null);
    check('teleport: db list shows the tunnel', dbsWithTunnel.find((d) => d.name === 'smoke-redis')?.tunnel?.port === connected.tunnel.port);
    const stopped = await run<{ stopped: number }>('teleport.db.disconnect', { database: 'smoke-redis' }, null);
    const statusStopped = await run<TeleportStatus>('teleport.status', {}, null);
    check('teleport: disconnect stops one tunnel and leaves the others', stopped.stopped === 1 && !statusStopped.tunnels.some((t) => t.target === 'smoke-redis') && statusStopped.tunnels.some((t) => t.target === 'second-redis'), statusStopped.tunnels.map((t) => t.target));
    const auto = await run<DbQueryResult[]>('db.query.run', { connectionId: teleportConn.id, query: 'PING', record: false }, ws.id);
    const status2 = await run<TeleportStatus>('teleport.status', {}, null);
    const restarted = status2.tunnels.find((t) => t.target === 'smoke-redis');
    check('teleport: query restarts a stopped tunnel', auto[0].value === 'PONG' && Boolean(restarted) && restarted?.id !== connected.tunnel.id, restarted?.id);
    await run('teleport.db.disconnect', { tunnelId: pgOnly.tunnel.id }, null);
    const broken = await run<DbConnectionSummary>('db.connection.save', { connection: { kind: 'redis', name: 'broken', access: { type: 'teleport', proxy: first, database: 'broken-db', dbUser: 'default' } } }, ws.id);
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
    // Expired certificate on one cluster only: its tunnel is down, so the next query must ask for a login while the other cluster keeps working.
    await run('teleport.db.disconnect', { database: 'smoke-redis' }, null);
    await fakeTsh.expire(first);
    const expired = await run<TeleportStatus>('teleport.status', { refresh: true }, null);
    check('teleport: expired certificate detected per cluster', clusterOf(expired, first)?.state === 'expired' && clusterOf(expired, second)?.state === 'logged-in' && expired.state === 'logged-in', expired.clusters.map((c) => [c.proxy, c.state]));
    const expiredQuery = await host.invoke('db.query.run', { connectionId: teleportConn.id, query: 'PING', record: false }, { caller: 'ui', workspaceId: ws.id });
    check(
      'teleport: expired session yields TELEPORT_LOGIN_REQUIRED naming the cluster',
      !expiredQuery.ok && expiredQuery.error.code === 'TELEPORT_LOGIN_REQUIRED' && (expiredQuery.error.details as { proxy?: string })?.proxy === first,
      expiredQuery.ok ? 'ok?' : expiredQuery.error,
    );
    const stillSecond = await run<DbQueryResult[]>('db.query.run', { connectionId: onSecond.connection!.id, query: 'PING', record: false }, ws.id);
    check('teleport: the other cluster keeps working', stillSecond[0].value === 'PONG');
    const relogin = await run<TeleportLoginResult>('teleport.login', { proxy: first }, null);
    check('teleport: log in again restores the cluster', relogin.ok && clusterOf(relogin.status, first)?.state === 'logged-in', relogin.status.clusters.map((c) => [c.proxy, c.state]));
    const afterRelogin = await run<DbQueryResult[]>('db.query.run', { connectionId: teleportConn.id, query: 'PING', record: false }, ws.id);
    check('teleport: query works after re-login', afterRelogin[0].value === 'PONG');

    // ---------- mock servers: routes with templates, fallback, capture, wait, hot reload, forward, replay, webhook receiver ----------
    interface WaitOut {
      request: MockCapturedRequest | null;
      timedOut: boolean;
    }
    const mock = await run<MockServerSummary>(
      'mock.server.save',
      {
        server: {
          name: 'smoke mock',
          routes: [
            { id: 'r-user', method: 'GET', path: '/users/:id', status: 200, headers: [{ id: 'h1', key: 'X-Route', value: '{{params.id}}', enabled: true }], body: '{"id":"{{params.id}}","q":"{{query.q}}","rid":"{{$uuid}}"}' },
            { id: 'r-echo', method: 'POST', path: '/echo', status: 201, body: 'hello {{body.name}} via {{headers.x-caller}}' },
            { id: 'r-slow', method: 'ANY', path: '/slow/*', status: 503, delayMs: 300 },
            { id: 'r-off', method: 'GET', path: '/off', enabled: false },
          ],
        },
      },
      ws.id,
    );
    check('mock: server saved with a random five-digit port and route defaults', mock.port >= 10000 && mock.port <= 32767 && !mock.running && mock.routes.length === 4 && mock.routes[2].enabled && mock.routes[1].headers.length === 0, { port: mock.port });
    check('mock: definition committed to the project', (await fs.stat(path.join(folder, '.quiver', 'mock-servers', `${mock.id}.json`))).isFile());
    const mockStarted = await run<MockServerSummary>('mock.server.start', { id: mock.id }, ws.id);
    check('mock: server starts', mockStarted.running && mockStarted.url === `http://127.0.0.1:${mock.port}`, mockStarted.url);
    const base = mockStarted.url!;
    const r1 = await fetch(`${base}/users/42?q=abc`);
    const j1 = (await r1.json()) as { id: string; q: string; rid: string };
    check(
      'mock: route with params, query and dynamic values',
      r1.status === 200 && r1.headers.get('x-route') === '42' && (r1.headers.get('content-type') ?? '').includes('application/json') && j1.id === '42' && j1.q === 'abc' && /^[0-9a-f-]{36}$/.test(j1.rid),
      j1,
    );
    check('mock: cors header on every answer', r1.headers.get('access-control-allow-origin') === '*');
    const r2 = await fetch(`${base}/echo`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-caller': 'smoke' }, body: '{"name":"Ada"}' });
    const t2 = await r2.text();
    check('mock: body and header templates', r2.status === 201 && t2 === 'hello Ada via smoke', t2);
    const slowStart = Date.now();
    const r3 = await fetch(`${base}/slow/a/b`, { method: 'DELETE' });
    check('mock: wildcard route with delay', r3.status === 503 && Date.now() - slowStart >= 280, Date.now() - slowStart);
    const r4 = await fetch(`${base}/off`);
    check('mock: disabled route falls through to the 404 fallback', r4.status === 404);
    const headRes = await fetch(`${base}/users/1`, { method: 'HEAD' });
    check('mock: HEAD matches a GET route without a body', headRes.status === 200 && (await headRes.text()) === '');
    const preflight = await fetch(`${base}/anything`, { method: 'OPTIONS', headers: { origin: 'http://app.local', 'access-control-request-method': 'PUT' } });
    check('mock: preflight answered with the requesting origin', preflight.status === 204 && preflight.headers.get('access-control-allow-origin') === 'http://app.local' && preflight.headers.get('access-control-allow-methods') === 'PUT');
    const mockLog = await run<MockCapturedRequest[]>('mock.request.list', { serverId: mock.id }, ws.id);
    check(
      'mock: every request captured newest first with what was answered',
      mockLog.length === 6 && mockLog[0].outcome === 'preflight' && mockLog[5].routeId === 'r-user' && mockLog[5].query.q === 'abc' && mockLog[4].body === '{"name":"Ada"}' && mockLog[4].response.body === 'hello Ada via smoke' && mockLog[2].outcome === 'fallback',
      mockLog.map((r) => [r.method, r.url, r.outcome, r.response.status]),
    );
    const mockFiltered = await run<MockCapturedRequest[]>('mock.request.list', { serverId: mock.id, method: 'post', path: '/echo' }, ws.id);
    check('mock: list filters by method and path pattern', mockFiltered.length === 1 && mockFiltered[0].routeId === 'r-echo');
    const mockList = await run<MockServerSummary[]>('mock.server.list', {}, ws.id);
    check('mock: list carries running state and request count', mockList.find((s) => s.id === mock.id)?.requestCount === 6 && mockList.find((s) => s.id === mock.id)?.running === true);
    const waiting = run<WaitOut>('mock.request.wait', { serverId: mock.id, timeoutMs: 5000, method: 'PUT', path: '/hooks/:kind' }, ws.id);
    setTimeout(() => void fetch(`${base}/hooks/github?x=1`, { method: 'PUT', body: 'payload' }).catch(() => undefined), 150);
    const waited = await waiting;
    check('mock: wait resolves with the matching request', !waited.timedOut && waited.request?.method === 'PUT' && waited.request.path === '/hooks/github' && waited.request.body === 'payload', waited.request?.url);
    const waitedOut = await run<WaitOut>('mock.request.wait', { serverId: mock.id, timeoutMs: 200, path: '/never' }, ws.id);
    check('mock: wait times out cleanly', waitedOut.timedOut && waitedOut.request === null);
    const routeSaved = await run<{ route: MockRoute; server: MockServerSummary }>('mock.route.save', { serverId: mock.id, route: { id: 'r-user', body: '{"changed":true}' } }, ws.id);
    const r5 = await fetch(`${base}/users/7`);
    check('mock: route update keeps other fields and applies to the running server', routeSaved.route.path === '/users/:id' && routeSaved.route.headers.length === 1 && routeSaved.server.running && ((await r5.json()) as { changed: boolean }).changed === true);
    const renamed = await run<MockServerSummary>('mock.server.save', { server: { id: mock.id, name: 'smoke mock renamed' } }, ws.id);
    check('mock: partial server update keeps routes and port', renamed.name === 'smoke mock renamed' && renamed.routes.length === 4 && renamed.port === mock.port && renamed.running);
    await run('mock.server.save', { server: { id: mock.id, name: 'smoke mock', fallback: { type: 'forward', url: `http://127.0.0.1:${echoPort}/upstream` } } }, ws.id);
    const r6 = await fetch(`${base}/not/mocked?y=2`, { method: 'POST', headers: { 'content-type': 'text/plain', 'x-fwd': '1' }, body: 'fwd-body' });
    const j6 = (await r6.json()) as { url: string; method: string; headers: Record<string, string>; body: string };
    check(
      'mock: unmatched requests forward to the upstream with path, headers and body',
      r6.status === 200 && r6.headers.get('x-echo') === 'yes' && j6.url === '/upstream/not/mocked?y=2' && j6.method === 'POST' && j6.headers['x-fwd'] === '1' && j6.body === 'fwd-body',
      j6,
    );
    const fwdLog = await run<MockCapturedRequest[]>('mock.request.list', { serverId: mock.id, limit: 1 }, ws.id);
    check('mock: forwarded exchange recorded', fwdLog[0].outcome === 'forwarded' && fwdLog[0].response.status === 200 && fwdLog[0].response.body.includes('fwd-body'), fwdLog[0].outcome);
    const r7 = await fetch(`${base}/users/9`);
    check('mock: routes still win over forwarding', r7.status === 200 && r7.headers.get('x-route') === '9');
    await run('mock.server.save', { server: { id: mock.id, fallback: { type: 'forward', url: 'http://127.0.0.1:1' } } }, ws.id);
    const r8 = await fetch(`${base}/down`);
    const j8 = (await r8.json()) as { message?: string };
    check('mock: unreachable upstream yields 502 with the reason', r8.status === 502 && (j8.message ?? '').length > 0, j8);
    const hook = (await run<MockCapturedRequest[]>('mock.request.list', { serverId: mock.id, method: 'PUT' }, ws.id))[0];
    const replayed = await run<MockReplayResult>('mock.request.replay', { serverId: mock.id, requestId: hook.id, url: `http://127.0.0.1:${echoPort}` }, ws.id);
    const jr = JSON.parse(replayed.body) as { method: string; url: string; body: string; headers: Record<string, string> };
    check('mock: replay sends method, path, query and body to another server', replayed.status === 200 && jr.method === 'PUT' && jr.url === '/hooks/github?x=1' && jr.body === 'payload' && !('content-length' in jr.headers && jr.headers['content-length'] !== '7'), jr);
    const gotOne = await run<MockCapturedRequest>('mock.request.get', { serverId: mock.id, id: hook.id }, ws.id);
    check('mock: request.get', gotOne.id === hook.id && gotOne.remoteAddress.length > 0);
    // Webhook receiver in a second workspace: no routes, templated 200 fallback, autostart, log persisted across close and reopen.
    const ws2 = await run<WorkspaceInfo>('workspace.open', { path: hooksFolder }, null);
    const hooks = await run<MockServerSummary>(
      'mock.server.save',
      { server: { name: 'hooks', autoStart: true, fallback: { type: 'respond', status: 200, headers: [], body: '{"ok":true,"got":"{{body.event}}"}' } } },
      ws2.id,
    );
    await run('mock.server.start', { id: hooks.id }, ws2.id);
    const portRecords = host.config.get().mock.ports;
    check(
      'mock: ports of every project are recorded in the global config',
      hooks.port !== mock.port &&
        portRecords.some((r) => r.port === mock.port && r.serverId === mock.id && r.workspace === ws.path) &&
        portRecords.some((r) => r.port === hooks.port && r.serverId === hooks.id && r.workspace === ws2.path && r.name === 'hooks'),
      portRecords,
    );
    const rh = await fetch(`http://127.0.0.1:${hooks.port}/webhooks/stripe`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"event":"invoice.paid"}' });
    check('mock: webhook receiver answers the templated fallback', rh.status === 200 && ((await rh.json()) as { got: string }).got === 'invoice.paid');
    await run('workspace.close', { id: ws2.id }, null);
    const closedFetch = await fetch(`http://127.0.0.1:${hooks.port}/`).catch(() => null);
    check('mock: closing the workspace stops its servers', closedFetch === null);
    const ws2b = await run<WorkspaceInfo>('workspace.open', { path: hooksFolder }, null);
    const hooksAfter = await run<MockServerSummary>('mock.server.get', { id: hooks.id }, ws2b.id);
    check('mock: autostart on workspace open with the persisted request count', hooksAfter.running && hooksAfter.requestCount === 1, { running: hooksAfter.running, count: hooksAfter.requestCount, error: hooksAfter.error });
    const persisted = await run<MockCapturedRequest[]>('mock.request.list', { serverId: hooks.id }, ws2b.id);
    check('mock: persisted request keeps its body', persisted[0]?.body === '{"event":"invoice.paid"}' && persisted[0].outcome === 'fallback');
    const clash = await host.invoke('mock.server.save', { server: { name: 'clash', port: mock.port } }, { caller: 'ui', workspaceId: ws.id });
    check('mock: duplicate port within a workspace is refused', !clash.ok && clash.error.code === 'INVALID_INPUT', clash.ok ? 'ok?' : clash.error.message);
    const busy = await run<MockServerSummary>('mock.server.save', { server: { name: 'busy', port: hooks.port } }, ws.id);
    const busyStart = await host.invoke('mock.server.start', { id: busy.id }, { caller: 'ui', workspaceId: ws.id });
    const busySummary = await run<MockServerSummary>('mock.server.get', { id: busy.id }, ws.id);
    check('mock: starting on a taken port names the other project\'s server and keeps the error on the summary', !busyStart.ok && /already in use by mock server "hooks" in /.test(busyStart.error.message) && /in use/.test(busySummary.error ?? ''), busyStart.ok ? 'ok?' : busyStart.error.message);
    await run('mock.server.delete', { id: busy.id }, ws.id);
    check('mock: deleting a server forgets its port record', !host.config.get().mock.ports.some((r) => r.serverId === busy.id) && host.config.get().mock.ports.some((r) => r.serverId === hooks.id));
    const cleared = await run<{ cleared: number }>('mock.request.clear', { serverId: mock.id }, ws.id);
    check('mock: clear drops the log', cleared.cleared === 11 && (await run<MockCapturedRequest[]>('mock.request.list', { serverId: mock.id }, ws.id)).length === 0, cleared);
    const mockStopped = await run<MockServerSummary>('mock.server.stop', { id: mock.id }, ws.id);
    const stoppedFetch = await fetch(`${base}/users/1`).catch(() => null);
    check('mock: stop releases the port', !mockStopped.running && mockStopped.url === null && stoppedFetch === null);
    // Leave it running with three captured requests for the MCP and UI checks below.
    await run('mock.server.save', { server: { id: mock.id, fallback: { type: 'respond', status: 404, headers: [], body: '{"error":"no mock route matched"}' } } }, ws.id);
    await run('mock.server.start', { id: mock.id }, ws.id);
    await fetch(`${base}/users/1?q=ui`);
    await fetch(`${base}/echo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"Ada"}' });
    await fetch(`${base}/missing`);

    // ---------- GraphQL: body type over POST and GET, variables, operation names, introspection cache ----------
    const gqlReq = await run<ApiRequest>(
      'api.request.create',
      { name: 'smoke graphql', method: 'POST', url: `http://127.0.0.1:${gqlPort}/graphql`, body: { type: 'graphql', query: 'query Hello($name: String) {\n  hello(name: $name)\n}', variables: '{"name":"{{token}}"}' } },
      ws.id,
    );
    check('graphql: request created with a graphql body', gqlReq.body.type === 'graphql');
    const gqlSaved = await run<ApiRequest>('api.request.save', { request: { ...gqlReq, auth: { type: 'bearer', token: '{{token}}' } } }, ws.id);
    const gqlRes = await run<ApiResponse>('api.request.send', { requestId: gqlSaved.id }, ws.id);
    const gqlData = JSON.parse(gqlRes.body) as { data?: { hello?: string } };
    check('graphql: POST sends query and variables as JSON with variables resolved', gqlRes.status === 200 && gqlData.data?.hello === 'Hello, s3cret' && gqlLastMethod === 'POST' && gqlAuthSeen === 'Bearer s3cret', gqlRes.body);
    check('graphql: sent request shows the JSON payload', (gqlRes.sent.bodyPreview ?? '').includes('"query"') && gqlRes.sent.headers.some(([k, v]) => k === 'Content-Type' && v === 'application/json'));
    const gqlGet = await run<ApiResponse>('api.request.send', { request: { ...gqlSaved, method: 'GET' } }, ws.id);
    check(
      'graphql: GET puts query and variables in the URL',
      gqlGet.status === 200 && (JSON.parse(gqlGet.body) as typeof gqlData).data?.hello === 'Hello, s3cret' && gqlLastMethod === 'GET' && gqlGet.sent.url.includes('query=') && gqlGet.sent.bodyPreview === null,
      gqlGet.sent.url.slice(0, 120),
    );
    const gqlMulti = 'query A { hello } query B($id: ID!) { user(id: $id) { name } }';
    const gqlOp = await run<ApiResponse>('api.request.send', { request: { ...gqlSaved, body: { type: 'graphql', query: gqlMulti, variables: '{"id":"2"}', operationName: 'B' } } }, ws.id);
    check('graphql: operationName picks the operation', (JSON.parse(gqlOp.body) as { data?: { user?: { name: string } } }).data?.user?.name === 'Linus', gqlOp.body);
    const gqlBadVars = await host.invoke('api.request.send', { request: { ...gqlSaved, body: { type: 'graphql', query: '{ hello }', variables: '{not json' } } }, { caller: 'ui', workspaceId: ws.id });
    check('graphql: invalid variables JSON is refused before sending', !gqlBadVars.ok && gqlBadVars.error.code === 'INVALID_INPUT', gqlBadVars.ok ? 'ok?' : gqlBadVars.error.message);
    check('graphql: no schema before introspection', (await run<GraphqlSchemaDoc | null>('api.graphql.schema', { requestId: gqlSaved.id }, ws.id)) === null);
    const schemaDoc = await run<GraphqlSchemaDoc>('api.graphql.introspect', { requestId: gqlSaved.id }, ws.id);
    check(
      'graphql: introspection caches the schema as SDL',
      schemaDoc.url === `http://127.0.0.1:${gqlPort}/graphql` && schemaDoc.typeCount >= 3 && schemaDoc.sdl.includes('type User') && schemaDoc.sdl.includes('A person') && schemaDoc.sdl.includes('@deprecated'),
      { types: schemaDoc.typeCount, sdl: schemaDoc.sdl.slice(0, 80) },
    );
    const cachedSchema = await run<GraphqlSchemaDoc | null>('api.graphql.schema', { requestId: gqlSaved.id }, ws.id);
    check('graphql: cached schema is read back from .quiver/local', cachedSchema?.sdl === schemaDoc.sdl && (await fs.readdir(path.join(folder, '.quiver', 'local'))).some((f) => f.startsWith('graphql-schema-')));
    const gqlCurl = await run<{ command: string }>('api.export.curl', { requestId: gqlSaved.id }, ws.id);
    check('graphql: curl export carries the JSON payload and auth', gqlCurl.command.includes('--data-raw') && gqlCurl.command.includes('"query"') && gqlCurl.command.includes('Bearer s3cret'), gqlCurl.command.slice(0, 160));

    // ---------- realtime: WebSocket and SSE connections, send, wait, reconnect, errors ----------
    type RtWait = { message: RealtimeMessage | null; timedOut: boolean };
    const untilMessages = async (id: string, pred: (list: RealtimeMessage[]) => boolean, timeout = 3000): Promise<RealtimeMessage[]> => {
      const deadline = Date.now() + timeout;
      for (;;) {
        const list = await run<RealtimeMessage[]>('realtime.message.list', { id, limit: 200 }, ws.id);
        if (pred(list) || Date.now() > deadline) return list;
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    const wsConn = await run<RealtimeConnectionSummary>(
      'realtime.connection.save',
      {
        connection: {
          name: 'smoke ws',
          kind: 'websocket',
          url: `ws://127.0.0.1:${wsPort}/chat?room={{token}}`,
          protocols: ['quiver.v1', 'other'],
          auth: { type: 'bearer', token: '{{token}}' },
          messages: [{ id: 'm1', name: 'ping', body: 'ping {{token}}' }],
        },
      },
      ws.id,
    );
    check('realtime: connection saved with defaults', wsConn.status === 'disconnected' && wsConn.reconnect && wsConn.logLimit === 500 && wsConn.messageCount === 0, { status: wsConn.status });
    check('realtime: definition committed to the project', (await fs.stat(path.join(folder, '.quiver', 'realtime-connections', `${wsConn.id}.json`))).isFile());
    const wsOpen = await run<RealtimeConnectionSummary>('realtime.connect', { id: wsConn.id }, ws.id);
    check('realtime: websocket opens with the negotiated subprotocol', wsOpen.status === 'open' && wsOpen.protocol === 'quiver.v1' && wsOpen.error === null, { status: wsOpen.status, protocol: wsOpen.protocol, error: wsOpen.error });
    const wsLog1 = await untilMessages(wsConn.id, (l) => l.some((m) => m.direction === 'in'));
    const greeting = wsLog1.find((m) => m.direction === 'in');
    const greetingData = greeting ? (JSON.parse(greeting.data) as { auth: string | null; path: string }) : null;
    check('realtime: handshake carried the resolved auth header and url variables', greetingData?.auth === 'Bearer s3cret' && greetingData.path === '/chat?room=s3cret' && wsLog1[0]?.kind === 'open' && wsLog1[0].direction === 'system', greetingData);
    const echoWait = run<RtWait>('realtime.message.wait', { id: wsConn.id, contains: 'echo:', timeoutMs: 3000 }, ws.id);
    const sentMsg = await run<RealtimeMessage>('realtime.send', { id: wsConn.id, data: 'hello {{token}}' }, ws.id);
    const wsEchoed = await echoWait;
    check('realtime: send resolves variables and wait returns the echo', sentMsg.direction === 'out' && sentMsg.data === 'hello s3cret' && !wsEchoed.timedOut && wsEchoed.message?.data === 'echo:hello s3cret', wsEchoed.message?.data);
    const savedWait = run<RtWait>('realtime.message.wait', { id: wsConn.id, contains: 'echo:ping', timeoutMs: 3000 }, ws.id);
    await run('realtime.send', { id: wsConn.id, messageId: 'm1' }, ws.id);
    check('realtime: saved messages send by id', (await savedWait).message?.data === 'echo:ping s3cret');
    const binWait = run<RtWait>('realtime.message.wait', { id: wsConn.id, timeoutMs: 3000 }, ws.id);
    await run('realtime.send', { id: wsConn.id, data: Buffer.from([1, 2, 3]).toString('base64'), binary: true }, ws.id);
    const bin = (await binWait).message;
    check('realtime: binary frames round-trip as base64', bin?.encoding === 'base64' && Buffer.from(bin.data, 'base64').toString('latin1') === 'bin:\u0001\u0002\u0003' && bin.size === 7, bin);
    const outOnly = await run<RealtimeMessage[]>('realtime.message.list', { id: wsConn.id, direction: 'out' }, ws.id);
    check('realtime: list filters by direction and reads oldest first', outOnly.length === 3 && outOnly[0].data === 'hello s3cret' && outOnly[2].encoding === 'base64', outOnly.map((m) => m.data));
    const reopenWait = run<RtWait>('realtime.message.wait', { id: wsConn.id, direction: 'system', contains: 'Connected', timeoutMs: 8000 }, ws.id);
    await run('realtime.send', { id: wsConn.id, data: 'bye' }, ws.id);
    const reopened = await reopenWait;
    const afterReopen = await run<RealtimeConnectionSummary>('realtime.connection.get', { id: wsConn.id }, ws.id);
    const wsSystem = await run<RealtimeMessage[]>('realtime.message.list', { id: wsConn.id, direction: 'system' }, ws.id);
    check(
      'realtime: a server close reconnects after a second',
      !reopened.timedOut && afterReopen.status === 'open' && wsSystem.some((m) => m.kind === 'close' && m.data.includes('4001')) && wsSystem.some((m) => m.kind === 'info' && m.data.includes('Reconnecting in 1 s')),
      wsSystem.map((m) => m.data),
    );
    const disconnected = await run<RealtimeConnectionSummary>('realtime.disconnect', { id: wsConn.id }, ws.id);
    await new Promise((r) => setTimeout(r, 1300));
    const stillClosed = await run<RealtimeConnectionSummary>('realtime.connection.get', { id: wsConn.id }, ws.id);
    check('realtime: disconnect closes and does not reconnect', disconnected.status === 'disconnected' && stillClosed.status === 'disconnected' && wsSockets.size === 0, { status: stillClosed.status, serverSockets: wsSockets.size });
    const deadConn = await run<RealtimeConnectionSummary>('realtime.connection.save', { connection: { name: 'smoke dead', kind: 'websocket', url: 'ws://127.0.0.1:1/', reconnect: false } }, ws.id);
    const deadOpen = await run<RealtimeConnectionSummary>('realtime.connect', { id: deadConn.id }, ws.id);
    check('realtime: an unreachable websocket reports the failure', deadOpen.status === 'disconnected' && typeof deadOpen.error === 'string' && deadOpen.error.length > 0, deadOpen.error);
    await run('realtime.connection.delete', { id: deadConn.id }, ws.id);
    check('realtime: delete removes the definition', !(await run<RealtimeConnectionSummary[]>('realtime.connection.list', {}, ws.id)).some((c) => c.id === deadConn.id));
    await run('realtime.connection.save', { connection: { id: wsConn.id, url: 'ws://127.0.0.1:{{nope}}/' } }, ws.id);
    const unresolvedRt = await host.invoke('realtime.connect', { id: wsConn.id }, { caller: 'ui', workspaceId: ws.id });
    check('realtime: unresolved variables are reported before connecting', !unresolvedRt.ok && unresolvedRt.error.code === 'UNRESOLVED_VARIABLES');
    const wsRestored = await run<RealtimeConnectionSummary>('realtime.connection.save', { connection: { id: wsConn.id, url: `ws://127.0.0.1:${wsPort}/chat` } }, ws.id);
    check('realtime: partial update keeps the rest of the connection', wsRestored.protocols.length === 2 && wsRestored.messages.length === 1 && wsRestored.auth.type === 'bearer');

    const sseConn = await run<RealtimeConnectionSummary>(
      'realtime.connection.save',
      { connection: { name: 'smoke sse', kind: 'sse', url: `http://127.0.0.1:${ssePort}/events`, headers: [{ id: 'h', key: 'X-Client', value: 'smoke', enabled: true }] } },
      ws.id,
    );
    const resumedWait = run<RtWait>('realtime.message.wait', { id: sseConn.id, event: 'resumed', timeoutMs: 8000 }, ws.id);
    const sseOpen = await run<RealtimeConnectionSummary>('realtime.connect', { id: sseConn.id }, ws.id);
    check('realtime: sse stream opens', sseOpen.status === 'open' && sseOpen.error === null, { status: sseOpen.status, error: sseOpen.error });
    const resumed = await resumedWait;
    const sseLog = await run<RealtimeMessage[]>('realtime.message.list', { id: sseConn.id }, ws.id);
    const tick = sseLog.find((m) => m.event === 'tick');
    const multiLine = sseLog.find((m) => m.eventId === '2');
    check(
      'realtime: sse events carry name, id and multi-line data',
      tick?.eventId === '1' && tick.data === '{"n":1}' && multiLine?.event === 'message' && multiLine.data === 'line one\nline two',
      sseLog.map((m) => [m.kind, m.event, m.eventId, m.data]),
    );
    check('realtime: sse reconnects after the retry hint with Last-Event-ID', !resumed.timedOut && resumed.message?.data === 'after 2' && sseSeen.length === 2 && sseSeen[0].lastEventId === null && sseSeen[1].lastEventId === '2', sseSeen);
    const sseAfter = await run<RealtimeConnectionSummary>('realtime.connection.get', { id: sseConn.id }, ws.id);
    check('realtime: sse summary tracks the last event id and sent the right headers', sseAfter.status === 'open' && sseAfter.lastEventId === '3' && sseSeen[0].accept.includes('text/event-stream') && sseSeen[0].method === 'GET');
    const sseInfo = sseLog.find((m) => m.kind === 'info');
    check('realtime: sse reconnect used the server retry hint', /Reconnecting in 200 ms/.test(sseInfo?.data ?? ''), sseInfo?.data);
    await run('realtime.disconnect', { id: sseConn.id }, ws.id);
    await run('realtime.connection.save', { connection: { id: sseConn.id, url: `http://127.0.0.1:${ssePort}/echo`, method: 'POST', body: '{"subscribe":"{{token}}"}' } }, ws.id);
    const echoEventWait = run<RtWait>('realtime.message.wait', { id: sseConn.id, event: 'echo', timeoutMs: 5000 }, ws.id);
    await run('realtime.connect', { id: sseConn.id }, ws.id);
    const echoEvent = await echoEventWait;
    check('realtime: sse can POST a body and streams the answer', echoEvent.message?.data === '{"subscribe":"s3cret"}' && sseSeen.at(-1)?.method === 'POST', echoEvent.message?.data);
    await run('realtime.disconnect', { id: sseConn.id }, ws.id);
    await run('realtime.connection.save', { connection: { id: sseConn.id, url: `http://127.0.0.1:${ssePort}/missing`, method: 'GET' } }, ws.id);
    const sse404 = await run<RealtimeConnectionSummary>('realtime.connect', { id: sseConn.id }, ws.id);
    check('realtime: a non-2xx stream answer is an error without reconnect', sse404.status === 'disconnected' && /HTTP 404/.test(sse404.error ?? '') && (sse404.error ?? '').includes('no such stream'), sse404.error);
    await run('realtime.connection.save', { connection: { id: sseConn.id, url: `http://127.0.0.1:${ssePort}/plain` } }, ws.id);
    const ssePlain = await run<RealtimeConnectionSummary>('realtime.connect', { id: sseConn.id }, ws.id);
    check('realtime: a wrong content type is reported', ssePlain.status === 'disconnected' && /text\/event-stream/.test(ssePlain.error ?? ''), ssePlain.error);
    const sseCleared = await run<{ cleared: number }>('realtime.message.clear', { id: sseConn.id }, ws.id);
    check('realtime: clear drops the log', sseCleared.cleared > 0 && (await run<RealtimeMessage[]>('realtime.message.list', { id: sseConn.id }, ws.id)).length === 0, sseCleared);
    await run('realtime.connection.save', { connection: { id: sseConn.id, url: `http://127.0.0.1:${ssePort}/events` } }, ws.id);
    // Leave the websocket connected for the MCP and UI checks below.
    await run('realtime.connect', { id: wsConn.id }, ws.id);
    await new Promise((r) => setTimeout(r, 1200));
    check('realtime: message log persisted under .quiver/local', (await fs.readdir(path.join(folder, '.quiver', 'local'))).includes(`realtime-messages-${wsConn.id}.json`));

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

    // ---------- MCP inspector: project config import, stdio, Streamable HTTP and SSE servers, tools, resources, prompts, log ----------
    const untilStatus = async (id: string, status: McpServerSummary['status'], timeout = 5000): Promise<McpServerSummary> => {
      const deadline = Date.now() + timeout;
      for (;;) {
        const s = await run<McpServerSummary>('mcp.server.get', { id }, ws.id);
        if (s.status === status || Date.now() > deadline) return s;
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    const untilTools = async (id: string, pred: (tools: McpTool[]) => boolean, timeout = 3000): Promise<McpTool[]> => {
      const deadline = Date.now() + timeout;
      for (;;) {
        const list = await run<McpTool[]>('mcp.tool.list', { id }, ws.id);
        if (pred(list) || Date.now() > deadline) return list;
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    const textOf = (outcome: { result: { content: McpToolCallOutcome['result']['content'] } } | null | undefined): string => (outcome?.result.content[0] ? (contentText(outcome.result.content[0]) ?? '') : '');
    await fs.writeFile(
      path.join(folder, '.mcp.json'),
      JSON.stringify(
        {
          mcpServers: {
            'smoke-stdio': { command: fakeStdio.node, args: [fakeStdio.script, '--flag', 'value with space'], env: { SMOKE_MCP_VAR: 'from-mcp-json' } },
            'smoke-http': { type: 'http', url: fakeMcp.httpUrl, headers: { Authorization: 'Bearer ${SMOKE_MCP_TOKEN:-fallback-token}' } },
          },
        },
        null,
        2,
      ),
    );
    await fs.mkdir(path.join(folder, '.vscode'), { recursive: true });
    await fs.writeFile(path.join(folder, '.vscode', 'mcp.json'), `{\n  // legacy transport\n  "servers": {\n    "smoke-sse": { "type": "sse", "url": "${fakeMcp.sseUrl}", },\n  },\n}\n`);
    const discovered = await run<McpConfigFile[]>('mcp.server.discover', {}, ws.id);
    check(
      'mcp inspector: discovers servers in .mcp.json and .vscode/mcp.json',
      discovered.length === 2 &&
        discovered[0].file === '.mcp.json' &&
        discovered[0].servers.map((s) => s.name).join() === 'smoke-stdio,smoke-http' &&
        discovered[1].servers[0]?.transport === 'sse' &&
        discovered.every((f) => f.error === null && f.servers.every((s) => !s.imported)),
      discovered.map((f) => [f.file, f.error, f.servers.map((s) => s.name)]),
    );
    const importedServers = await run<McpServerSummary[]>('mcp.server.import', {}, ws.id);
    const stdioServer = importedServers.find((s) => s.name === 'smoke-stdio')!;
    const httpImported = importedServers.find((s) => s.name === 'smoke-http')!;
    const sseServer = importedServers.find((s) => s.name === 'smoke-sse')!;
    check(
      'mcp inspector: import saves one server per entry with its origin',
      importedServers.length === 3 && importedServers.every((s) => s.importedFrom) && stdioServer?.env[0]?.key === 'SMOKE_MCP_VAR' && stdioServer.args.length === 3 && httpImported?.headers[0]?.key === 'Authorization' && sseServer?.transport === 'sse',
      importedServers.map((s) => [s.name, s.transport, s.importedFrom]),
    );
    check('mcp inspector: definitions committed to the project', (await fs.stat(path.join(folder, '.quiver', 'mcp-servers', `${stdioServer.id}.json`))).isFile());
    const reimported = await run<McpServerSummary[]>('mcp.server.import', { file: '.mcp.json' }, ws.id);
    check(
      'mcp inspector: re-import updates instead of duplicating',
      reimported.length === 2 && reimported.every((s) => [stdioServer.id, httpImported.id].includes(s.id)) && (await run<McpConfigFile[]>('mcp.server.discover', {}, ws.id)).every((f) => f.servers.every((s) => s.imported)),
      reimported.map((s) => s.id),
    );

    const stdioOpen = await run<McpServerSummary>('mcp.connect', { id: stdioServer.id }, ws.id);
    check(
      'mcp inspector: stdio server starts and initializes',
      stdioOpen.status === 'connected' && stdioOpen.serverInfo?.name === 'smoke-stdio' && typeof stdioOpen.pid === 'number' && stdioOpen.pid > 0 && stdioOpen.toolCount === 2 && capabilityLabels(stdioOpen.capabilities).includes('tools'),
      { status: stdioOpen.status, error: stdioOpen.error, info: stdioOpen.serverInfo, pid: stdioOpen.pid, tools: stdioOpen.toolCount },
    );
    const stdioTools = await run<McpTool[]>('mcp.tool.list', { id: stdioServer.id }, ws.id);
    check('mcp inspector: stdio tools listed with annotations', stdioTools.map((t) => t.name).join() === 'env_echo,exit' && stdioTools[0].annotations?.readOnlyHint === true, stdioTools.map((t) => t.name));
    const envEcho = await run<McpToolCallOutcome>('mcp.tool.call', { id: stdioServer.id, name: 'env_echo' }, ws.id);
    const envEchoData = JSON.parse(textOf(envEcho) || '{}') as { var: string | null; cwd: string; argv: string[] };
    check(
      'mcp inspector: process got the env, cwd and quoted args',
      envEchoData.var === 'from-mcp-json' && path.relative(folder, envEchoData.cwd ?? '') === '' && envEchoData.argv?.join('|') === '--flag|value with space' && envEcho.durationMs >= 0,
      envEchoData,
    );
    const stdioLog = await run<McpLogEntry[]>('mcp.log.list', { id: stdioServer.id }, ws.id);
    check(
      'mcp inspector: log has stderr, the handshake, and the call pair with timing',
      stdioLog.some((e) => e.kind === 'stderr' && e.data.includes('[fake-mcp] started')) &&
        stdioLog.some((e) => e.direction === 'out' && e.kind === 'request' && e.method === 'initialize') &&
        stdioLog.some((e) => e.direction === 'in' && e.kind === 'response' && e.method === 'tools/call' && e.durationMs !== null && e.ok === true) &&
        stdioLog.some((e) => e.direction === 'system' && e.kind === 'open' && e.data.includes('smoke-stdio 0.1.0')),
      stdioLog.map((e) => `${e.direction}:${e.kind}:${e.method ?? ''}`),
    );
    const unknownTool = await host.invoke('mcp.tool.call', { id: stdioServer.id, name: 'nope' }, { caller: 'ui', workspaceId: ws.id });
    check('mcp inspector: a JSON-RPC error becomes REQUEST_FAILED with the server message', !unknownTool.ok && unknownTool.error.code === 'REQUEST_FAILED' && unknownTool.error.message.includes('Unknown tool nope'), unknownTool.ok ? 'ok?' : unknownTool.error.message);
    const errorLogged = await run<McpLogEntry[]>('mcp.log.list', { id: stdioServer.id, kind: 'error' }, ws.id);
    check('mcp inspector: log filters by kind and marks error responses', errorLogged.length === 1 && errorLogged[0].ok === false && errorLogged[0].method === 'tools/call' && errorLogged[0].direction === 'in', errorLogged.map((e) => e.data.slice(0, 80)));
    await run('mcp.tool.call', { id: stdioServer.id, name: 'exit', arguments: { code: 3 } }, ws.id);
    const stdioGone = await untilStatus(stdioServer.id, 'disconnected');
    check('mcp inspector: a stdio server that exits is reported', stdioGone.status === 'disconnected' && (stdioGone.error ?? '').includes('exited') && stdioGone.pid === null, { status: stdioGone.status, error: stdioGone.error });

    const httpServer = await run<McpServerSummary>(
      'mcp.server.save',
      { server: { name: 'smoke http', transport: 'http', url: fakeMcp.httpUrl, auth: { type: 'bearer', token: '{{token}}' }, headers: [{ id: 'h1', key: 'X-Smoke', value: '{{token}}', enabled: true }] } },
      ws.id,
    );
    check('mcp inspector: server saved with defaults', httpServer.status === 'disconnected' && httpServer.logLimit === 500 && httpServer.autoConnect === false && httpServer.toolCount === 0 && httpServer.serverInfo === null);
    const httpOpen = await run<McpServerSummary>('mcp.connect', { id: httpServer.id }, ws.id);
    check(
      'mcp inspector: streamable http server initializes with info, protocol, capabilities and instructions',
      httpOpen.status === 'connected' &&
        httpOpen.serverInfo?.name === 'smoke-http' &&
        httpOpen.serverInfo.version === '1.2.3' &&
        /^\d{4}-\d{2}-\d{2}$/.test(httpOpen.protocolVersion ?? '') &&
        capabilityLabels(httpOpen.capabilities).includes('logging') &&
        httpOpen.instructions === 'Use echo to test the connection.' &&
        httpOpen.toolCount === 4 &&
        httpOpen.resourceCount === 2 &&
        httpOpen.promptCount === 1,
      { status: httpOpen.status, error: httpOpen.error, protocol: httpOpen.protocolVersion, caps: capabilityLabels(httpOpen.capabilities), counts: [httpOpen.toolCount, httpOpen.resourceCount, httpOpen.promptCount] },
    );
    check('mcp inspector: auth and headers resolved from the environment reach the server', fakeMcp.authSeen.includes('Bearer s3cret') && fakeMcp.headersSeen.includes('s3cret'), { auth: fakeMcp.authSeen, headers: fakeMcp.headersSeen });
    const httpTools = await run<McpTool[]>('mcp.tool.list', { id: httpServer.id }, ws.id);
    const echoTool = httpTools.find((t) => t.name === 'echo');
    check(
      'mcp inspector: tools carry schemas, annotations and output schema',
      echoTool?.inputSchema.properties?.text !== undefined && echoTool.inputSchema.required?.includes('text') === true && echoTool.annotations?.readOnlyHint === true && echoTool.outputSchema?.properties?.echoed !== undefined && echoTool.title === 'Echo',
      echoTool,
    );
    check('mcp inspector: argument skeleton from the schema', JSON.stringify(skeletonFromSchema(echoTool?.inputSchema)) === '{"text":""}', skeletonFromSchema(echoTool?.inputSchema));
    const echoCall = await run<McpToolCallOutcome>('mcp.tool.call', { id: httpServer.id, name: 'echo', arguments: { text: 'hi' } }, ws.id);
    check('mcp inspector: tool call returns content and structured content', textOf(echoCall) === 'echo:hi' && echoCall.result.structuredContent?.echoed === 'hi' && !echoCall.result.isError && echoCall.durationMs >= 0, echoCall);
    const failCall = await run<McpToolCallOutcome>('mcp.tool.call', { id: httpServer.id, name: 'fail' }, ws.id);
    check('mcp inspector: a tool error is returned with isError', failCall.result.isError === true && textOf(failCall) === 'nope', failCall.result);
    const badArgs = await run<McpToolCallOutcome>('mcp.tool.call', { id: httpServer.id, name: 'add', arguments: { a: 'x' } }, ws.id);
    check('mcp inspector: invalid arguments come back as a tool error naming the validation', badArgs.result.isError === true && /validation|invalid/i.test(textOf(badArgs)), textOf(badArgs).slice(0, 160));
    const notifyCall = await run<McpToolCallOutcome>('mcp.tool.call', { id: httpServer.id, name: 'notify' }, ws.id);
    const httpToolsAfter = await untilTools(httpServer.id, (t) => t.some((x) => x.name === 'dynamic'));
    check('mcp inspector: tools/list_changed refreshes the cached tools', textOf(notifyCall) === 'notified' && httpToolsAfter.some((t) => t.name === 'dynamic'), httpToolsAfter.map((t) => t.name));
    const logMsgs = await run<McpLogEntry[]>('mcp.log.list', { id: httpServer.id, kind: 'log' }, ws.id);
    check('mcp inspector: server log messages are recorded as log entries', logMsgs.length >= 1 && logMsgs[0].direction === 'in' && logMsgs[0].method === 'notifications/message' && logMsgs[0].data.includes('hello from the server'), logMsgs.map((e) => e.data.slice(0, 100)));
    const resources = await run<{ resources: McpResource[]; templates: McpResourceTemplate[] }>('mcp.resource.list', { id: httpServer.id }, ws.id);
    check(
      'mcp inspector: resources and templates listed',
      resources.resources.map((r) => r.uri).join() === 'smoke://greeting' && resources.templates.map((t) => t.uriTemplate).join() === 'smoke://users/{id}' && resources.templates[0].mimeType === 'application/json',
      resources,
    );
    const greetingRes = await run<McpReadResourceResult & { durationMs: number }>('mcp.resource.read', { id: httpServer.id, uri: 'smoke://greeting' }, ws.id);
    check('mcp inspector: resource read returns text', greetingRes.contents[0]?.text === 'hello, inspector' && greetingRes.contents[0].mimeType === 'text/plain' && greetingRes.durationMs >= 0, greetingRes);
    const userRes = await run<McpReadResourceResult>('mcp.resource.read', { id: httpServer.id, uri: expandUriTemplate('smoke://users/{id}', { id: '7' }) }, ws.id);
    check('mcp inspector: template expanded and read', (JSON.parse(userRes.contents[0]?.text ?? '{}') as { id: string }).id === '7', userRes);
    const prompts = await run<McpPrompt[]>('mcp.prompt.list', { id: httpServer.id }, ws.id);
    check('mcp inspector: prompts listed with arguments', prompts[0]?.name === 'summarize' && prompts[0].arguments?.some((a) => a.name === 'topic' && a.required) === true && prompts[0].arguments.some((a) => a.name === 'tone' && !a.required), prompts);
    const prompt = await run<McpPromptResult & { durationMs: number }>('mcp.prompt.get', { id: httpServer.id, name: 'summarize', arguments: { topic: 'ports', tone: 'dry' } }, ws.id);
    check('mcp inspector: prompt rendered', prompt.messages[0]?.role === 'user' && contentText(prompt.messages[0].content) === 'Summarize ports in a dry tone' && prompt.description === 'Summary of ports', prompt);
    const pong = await run<{ durationMs: number }>('mcp.ping', { id: httpServer.id }, ws.id);
    const rawPing = await run<{ result: unknown; durationMs: number }>('mcp.request', { id: httpServer.id, method: 'ping' }, ws.id);
    check('mcp inspector: ping and raw requests answer', pong.durationMs >= 0 && rawPing.durationMs >= 0 && typeof rawPing.result === 'object', { pong, rawPing });
    await run('mcp.logging.level', { id: httpServer.id, level: 'debug' }, ws.id);
    const outRequests = await run<McpLogEntry[]>('mcp.log.list', { id: httpServer.id, direction: 'out', kind: 'request' }, ws.id);
    const readResponses = await run<McpLogEntry[]>('mcp.log.list', { id: httpServer.id, method: 'resources/read', kind: 'response' }, ws.id);
    check(
      'mcp inspector: log filters by direction and method, responses carry their request method',
      outRequests.length > 5 && outRequests.every((e) => e.direction === 'out') && outRequests.some((e) => e.method === 'logging/setLevel') && readResponses.length === 2 && readResponses.every((e) => e.durationMs !== null && e.ok === true),
      { out: outRequests.map((e) => e.method), reads: readResponses.length },
    );
    const httpClosed = await run<McpServerSummary>('mcp.disconnect', { id: httpServer.id }, ws.id);
    check('mcp inspector: disconnect ends the session and keeps the log', httpClosed.status === 'disconnected' && httpClosed.error === null && httpClosed.logCount > 10 && fakeMcp.sessions() === 0, { status: httpClosed.status, log: httpClosed.logCount, sessions: fakeMcp.sessions() });
    check('mcp inspector: log persisted under .quiver/local', (await fs.readdir(path.join(folder, '.quiver', 'local'))).includes(`mcp-log-${httpServer.id}.json`));
    const clearedLog = await run<{ cleared: number }>('mcp.log.clear', { id: httpServer.id }, ws.id);
    check('mcp inspector: clear drops the log', clearedLog.cleared > 0 && (await run<McpLogEntry[]>('mcp.log.list', { id: httpServer.id }, ws.id)).length === 0, clearedLog);

    const sseMcpOpen = await run<McpServerSummary>('mcp.connect', { id: sseServer.id }, ws.id);
    const sseEcho = sseMcpOpen.status === 'connected' ? await run<McpToolCallOutcome>('mcp.tool.call', { id: sseServer.id, name: 'echo', arguments: { text: 'sse' } }, ws.id) : null;
    check('mcp inspector: legacy sse transport connects and calls tools', sseMcpOpen.status === 'connected' && textOf(sseEcho) === 'echo:sse', { status: sseMcpOpen.status, error: sseMcpOpen.error });
    await run('mcp.disconnect', { id: sseServer.id }, ws.id);

    const deadMcp = await run<McpServerSummary>('mcp.server.save', { server: { name: 'smoke dead', transport: 'http', url: 'http://127.0.0.1:1/mcp' } }, ws.id);
    const deadMcpOpen = await run<McpServerSummary>('mcp.connect', { id: deadMcp.id }, ws.id);
    check('mcp inspector: an unreachable http server reports the failure', deadMcpOpen.status === 'disconnected' && typeof deadMcpOpen.error === 'string' && deadMcpOpen.error.length > 0, deadMcpOpen.error);
    await run('mcp.server.save', { server: { id: deadMcp.id, transport: 'stdio', command: 'quiver-no-such-command-xyz' } }, ws.id);
    const noCmdOpen = await run<McpServerSummary>('mcp.connect', { id: deadMcp.id }, ws.id);
    check('mcp inspector: a missing executable reports the spawn error', noCmdOpen.status === 'disconnected' && /ENOENT|not found|no such/i.test(noCmdOpen.error ?? ''), noCmdOpen.error);
    await run('mcp.server.save', { server: { id: deadMcp.id, transport: 'http', url: 'http://127.0.0.1:{{nope}}/mcp' } }, ws.id);
    const unresolvedMcp = await host.invoke('mcp.connect', { id: deadMcp.id }, { caller: 'ui', workspaceId: ws.id });
    check('mcp inspector: unresolved variables are reported before connecting', !unresolvedMcp.ok && unresolvedMcp.error.code === 'UNRESOLVED_VARIABLES');
    await run('mcp.server.delete', { id: deadMcp.id }, ws.id);
    check('mcp inspector: delete removes the definition', !(await run<McpServerSummary[]>('mcp.server.list', {}, ws.id)).some((s) => s.id === deadMcp.id));

    const selfServer = await run<McpServerSummary>('mcp.server.save', { server: { name: 'Quiver (this app)', transport: 'http', url: `http://127.0.0.1:${mcpPort}/mcp?workspace=${encodeURIComponent(folder)}` } }, ws.id);
    const selfOpen = await run<McpServerSummary>('mcp.connect', { id: selfServer.id }, ws.id);
    const selfTools = selfOpen.status === 'connected' ? await run<McpTool[]>('mcp.tool.list', { id: selfServer.id }, ws.id) : [];
    const selfCurrent = selfOpen.status === 'connected' ? await run<McpToolCallOutcome>('mcp.tool.call', { id: selfServer.id, name: 'workspace_current' }, ws.id) : null;
    check(
      'mcp inspector: connects to Quiver itself and sees its own tools',
      selfOpen.status === 'connected' && selfOpen.serverInfo?.name === 'quiver' && selfTools.some((t) => t.name === 'mcp_tool_call') && selfTools.some((t) => t.name === 'api_request_send') && textOf(selfCurrent).includes(JSON.stringify(folder).slice(1, -1)),
      { status: selfOpen.status, error: selfOpen.error, tools: selfTools.length, current: textOf(selfCurrent).slice(0, 120) },
    );
    await run('mcp.connect', { id: httpServer.id }, ws.id);

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
      ['teleport_status', 'teleport_db_list', 'teleport_db_connect', 'teleport_kube_list', 'teleport_pin', 'teleport_cluster_add'].every((n) => names.includes(n)) && !names.includes('teleport_login_cancel'),
      { total: names.length, teleport: names.filter((n) => n.startsWith('teleport')) },
    );
    const mcpTeleport = await rpc('tools/call', { name: 'teleport_status', arguments: {} });
    const mcpTeleportText = mcpTeleport.result?.content?.[0]?.text ?? '';
    const mcpTeleportStatus = mcpTeleportText.startsWith('{') ? (JSON.parse(mcpTeleportText) as TeleportStatus) : null;
    check('mcp reads teleport status with every cluster', mcpTeleportStatus?.state === 'logged-in' && mcpTeleportStatus.clusters.length === 2, mcpTeleportText.slice(0, 200) || mcpTeleport.error);
    const mcpDbs = await rpc('tools/call', { name: 'teleport_db_list', arguments: {} });
    check('mcp lists teleport databases across clusters', (JSON.parse(mcpDbs.result?.content?.[0]?.text ?? '[]') as unknown[]).length === 6);
    for (const tool of ['teleport_login', 'teleport_logout', 'teleport_kube_login', 'teleport_db_disconnect', 'teleport_cluster_remove']) {
      const blockedTool = await rpc('tools/call', {
        name: tool,
        arguments: tool === 'teleport_kube_login' ? { cluster: 'prod-eks' } : tool === 'teleport_db_disconnect' ? { database: 'smoke-redis' } : tool === 'teleport_cluster_remove' ? { proxy: second } : {},
      });
      check(`mcp blocks ${tool} by default`, blockedTool.result?.isError === true && (blockedTool.result.content?.[0]?.text ?? '').includes('MUTATION_BLOCKED'));
    }
    const mcpConnect = await rpc('tools/call', { name: 'teleport_db_connect', arguments: { database: 'smoke-redis' } });
    check('mcp can open a teleport tunnel for reads', mcpConnect.result?.isError !== true && (JSON.parse(mcpConnect.result?.content?.[0]?.text ?? '{}') as ConnectOut).tunnel?.port > 0, mcpConnect.result?.content?.[0]?.text?.slice(0, 200));
    const mcpPin = await rpc('tools/call', { name: 'teleport_pin', arguments: { proxy: second, kind: 'db', name: 'second-mysql', pinned: true } });
    check('mcp can pin a resource', mcpPin.result?.isError !== true && (JSON.parse(mcpPin.result?.content?.[0]?.text ?? '[]') as TeleportPin[]).length === 3, mcpPin.result?.content?.[0]?.text?.slice(0, 200));
    check('mcp lists mock tools', ['mock_server_list', 'mock_server_save', 'mock_route_save', 'mock_request_list', 'mock_request_wait', 'mock_request_replay'].every((n) => names.includes(n)), names.filter((n) => n.startsWith('mock')));
    const mcpMockRequests = await rpc('tools/call', { name: 'mock_request_list', arguments: { serverId: mock.id, limit: 5 } });
    check('mcp reads captured requests', mcpMockRequests.result?.isError !== true && (JSON.parse(mcpMockRequests.result?.content?.[0]?.text ?? '[]') as unknown[]).length === 3, mcpMockRequests.result?.content?.[0]?.text?.slice(0, 120));
    for (const [tool, args] of [
      ['mock_server_delete', { id: mock.id }],
      ['mock_server_stop', { id: mock.id }],
      ['mock_request_clear', { serverId: mock.id }],
    ] as const) {
      const blockedMock = await rpc('tools/call', { name: tool, arguments: args });
      check(`mcp blocks ${tool} by default`, blockedMock.result?.isError === true && (blockedMock.result.content?.[0]?.text ?? '').includes('MUTATION_BLOCKED'));
    }
    const mcpMockRoute = await rpc('tools/call', { name: 'mock_route_save', arguments: { serverId: mock.id, route: { method: 'GET', path: '/from-agent', body: '{"agent":true}' } } });
    const agentRoute = await fetch(`${base}/from-agent`);
    check('mcp can add a mock route that serves immediately', mcpMockRoute.result?.isError !== true && agentRoute.status === 200 && ((await agentRoute.json()) as { agent: boolean }).agent === true, mcpMockRoute.result?.content?.[0]?.text?.slice(0, 120));
    await fetch(`${base}/from-agent`, { method: 'DELETE' });
    check(
      'mcp lists realtime and graphql tools',
      ['realtime_connection_list', 'realtime_connect', 'realtime_send', 'realtime_message_wait', 'api_graphql_introspect', 'api_graphql_schema'].every((n) => names.includes(n)),
      names.filter((n) => n.startsWith('realtime')),
    );
    const mcpSchema = await rpc('tools/call', { name: 'api_graphql_schema', arguments: { requestId: gqlSaved.id } });
    check('mcp reads the cached graphql schema as SDL', (mcpSchema.result?.content?.[0]?.text ?? '').includes('type User'), mcpSchema.result?.content?.[0]?.text?.slice(0, 80));
    const mcpWait = rpc('tools/call', { name: 'realtime_message_wait', arguments: { id: wsConn.id, contains: 'echo:agent', timeoutMs: 5000 } });
    const mcpSend = await rpc('tools/call', { name: 'realtime_send', arguments: { id: wsConn.id, data: 'agent' } });
    const mcpWaited = JSON.parse((await mcpWait).result?.content?.[0]?.text ?? '{}') as { message?: RealtimeMessage; timedOut?: boolean };
    check('mcp can send over a websocket and wait for the answer', mcpSend.result?.isError !== true && mcpWaited.message?.data === 'echo:agent', mcpWaited);
    for (const [tool, args] of [
      ['realtime_disconnect', { id: wsConn.id }],
      ['realtime_message_clear', { id: wsConn.id }],
      ['realtime_connection_delete', { id: wsConn.id }],
    ] as const) {
      const blockedRt = await rpc('tools/call', { name: tool, arguments: args });
      check(`mcp blocks ${tool} by default`, blockedRt.result?.isError === true && (blockedRt.result.content?.[0]?.text ?? '').includes('MUTATION_BLOCKED'));
    }
    check(
      'mcp lists inspector tools',
      ['mcp_server_list', 'mcp_server_import', 'mcp_connect', 'mcp_tool_list', 'mcp_tool_call', 'mcp_resource_read', 'mcp_prompt_get', 'mcp_log_list'].every((n) => names.includes(n)),
      names.filter((n) => n.startsWith('mcp_')),
    );
    const agentEcho = await rpc('tools/call', { name: 'mcp_tool_call', arguments: { id: httpServer.id, name: 'echo', arguments: { text: 'agent' } } });
    check('mcp lets agents call tools annotated read-only', agentEcho.result?.isError !== true && (agentEcho.result?.content?.[0]?.text ?? '').includes('echo:agent'), agentEcho.result?.content?.[0]?.text?.slice(0, 120));
    const agentAdd = await rpc('tools/call', { name: 'mcp_tool_call', arguments: { id: httpServer.id, name: 'add', arguments: { a: 1, b: 2 } } });
    check('mcp blocks tools without readOnlyHint by default', agentAdd.result?.isError === true && (agentAdd.result.content?.[0]?.text ?? '').includes('MUTATION_BLOCKED'), agentAdd.result?.content?.[0]?.text?.slice(0, 120));
    for (const [tool, args] of [
      ['mcp_disconnect', { id: httpServer.id }],
      ['mcp_log_clear', { id: httpServer.id }],
      ['mcp_request', { id: httpServer.id, method: 'ping' }],
      ['mcp_server_delete', { id: httpServer.id }],
    ] as const) {
      const blockedMcp = await rpc('tools/call', { name: tool, arguments: args });
      check(`mcp blocks ${tool} by default`, blockedMcp.result?.isError === true && (blockedMcp.result.content?.[0]?.text ?? '').includes('MUTATION_BLOCKED'));
    }

    // ---------- Env files: discovery, parsing, masking, editing, compare, profiles, backups, Quiver environments ----------
    const envRoot = folder;
    const envOriginal = ['# App', 'APP_NAME=smoke', 'PORT=3000', 'DB_PASSWORD="p@ss word" # keep', "API_TOKEN='tok_123'", 'DATABASE_URL=postgres://app:secret@db/app', 'EMPTY=', 'MULTI="line one', 'line two"', 'PORT=3001', ''].join('\n');
    await fs.writeFile(path.join(envRoot, '.env'), envOriginal);
    await fs.writeFile(path.join(envRoot, '.env.example'), ['APP_NAME=', 'PORT=3000', 'DB_PASSWORD=', 'API_TOKEN=', 'DATABASE_URL=', 'FEATURE_FLAG=false # new in the example', 'NEW_KEY=hello', ''].join('\n'));
    await fs.writeFile(path.join(envRoot, '.env.staging'), 'APP_NAME=smoke-staging\nPORT=4000\n');
    await fs.writeFile(path.join(envRoot, '.env.local'), 'LOCAL_ONLY=1\n');
    await fs.mkdir(path.join(envRoot, 'apps', 'web'), { recursive: true });
    await fs.writeFile(path.join(envRoot, 'apps', 'web', '.env'), 'VITE_API=http://localhost\r\n');
    await fs.mkdir(path.join(envRoot, 'node_modules', 'pkg'), { recursive: true });
    await fs.writeFile(path.join(envRoot, 'node_modules', 'pkg', '.env'), 'IGNORED=1\n');
    await fs.writeFile(path.join(envRoot, 'docker.env'), 'COMPOSE_PROJECT=smoke\n');
    // A repository where .env is committed (the mistake the warning exists for) and .env.local is ignored.
    const gitConfig = path.join(hooksFolder, 'gitconfig');
    await fs.writeFile(gitConfig, '[user]\n\tname = smoke\n\temail = smoke@example.com\n[commit]\n\tgpgsign = false\n[core]\n\tautocrlf = false\n\thooksPath = /dev/null\n');
    const git = async (...args: string[]) => {
      try {
        await promisify(execFile)('git', args, { cwd: envRoot, windowsHide: true, env: { ...process.env, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1' } });
        return true;
      } catch {
        return false;
      }
    };
    await fs.writeFile(path.join(envRoot, '.gitignore'), '.env.local\n.env.*.local\nnode_modules/\n.quiver/local/\n');
    const hasGit = (await git('init', '-q')) && (await git('add', '.env', '.gitignore')) && (await git('commit', '-q', '-m', 'init'));
    console.log(`env files: git ${hasGit ? 'available, .env committed' : 'not available, git checks skipped'}`);

    const envFiles = await run<EnvFileSummary[]>('env.file.list', {}, ws.id);
    check('env files: finds dotenv files up to four folders deep, ordered by kind, skipping node_modules', envFiles.map((f) => f.path).join() === '.env,.env.local,.env.staging,.env.example,docker.env,apps/web/.env', envFiles.map((f) => f.path));
    const envMain = envFiles.find((f) => f.path === '.env')!;
    check('env files: summary counts effective keys, secrets and empties', envMain.kind === 'main' && envMain.keys === 7 && envMain.secrets === 3 && envMain.empty === 1 && envMain.invalid === 0, { keys: envMain.keys, secrets: envMain.secrets, empty: envMain.empty });
    const envOf = (p: string) => envFiles.find((f) => f.path === p);
    check('env files: kinds and profile names', envOf('.env.staging')?.profile === 'staging' && envOf('.env.staging')?.kind === 'profile' && envOf('.env.example')?.kind === 'example' && envOf('.env.local')?.kind === 'local' && envOf('docker.env')?.kind === 'other', envFiles.map((f) => [f.path, f.kind, f.profile]));
    if (hasGit) {
      check(
        'env files: git status flags the committed .env and the unignored profile, not the ignored local file or the example',
        envMain.warning === 'tracked' && envOf('.env.local')?.warning === null && envOf('.env.local')?.git?.ignored === true && envOf('.env.staging')?.warning === 'unignored' && envOf('.env.example')?.warning === null,
        envFiles.map((f) => [f.path, f.git, f.warning]),
      );
    }
    const envRead = await run<EnvFileContent>('env.file.read', { path: '.env' }, ws.id);
    const envEntry = (key: string) => envRead.entries.find((e) => e.key === key && !e.shadowed);
    check(
      'env files: read parses quotes, escapes, comments, multiline values and duplicates',
      envEntry('DB_PASSWORD')?.value === 'p@ss word' && envEntry('DB_PASSWORD')?.comment === 'keep' && envEntry('DB_PASSWORD')?.quote === '"' && envEntry('API_TOKEN')?.value === 'tok_123' && envEntry('MULTI')?.value === 'line one\nline two' && envEntry('PORT')?.value === '3001' && envRead.entries.filter((e) => e.key === 'PORT')[0].shadowed === true && envRead.masked === false,
      envRead.entries.map((e) => [e.key, e.value, e.shadowed]),
    );
    check('env files: secrets detected by key and by credentials in a URL', envEntry('DB_PASSWORD')?.secret === true && envEntry('API_TOKEN')?.secret === true && envEntry('DATABASE_URL')?.secret === true && envEntry('APP_NAME')?.secret === false);
    const agentRead = await host.invoke('env.file.read', { path: '.env' }, { caller: 'mcp', workspaceId: ws.id });
    const agentContent = agentRead.ok ? (agentRead.result as EnvFileContent) : null;
    check(
      'env files: agents get secret values masked in the entries and in the text',
      agentContent?.masked === true && agentContent.entries.find((e) => e.key === 'DB_PASSWORD')?.value === '••••••••' && agentContent.text.includes('DB_PASSWORD="••••••••" # keep') && agentContent.text.includes('APP_NAME=smoke') && !agentContent.text.includes('tok_123') && !agentContent.text.includes('app:secret@'),
      agentContent?.text.split('\n').slice(0, 6),
    );
    const agentReveal = await host.invoke('env.file.read', { path: '.env', reveal: true }, { caller: 'mcp', workspaceId: ws.id });
    check('env files: reveal is gated for agents like a mutation', !agentReveal.ok && agentReveal.error.code === 'MUTATION_BLOCKED', agentReveal.ok ? 'ok?' : agentReveal.error.code);
    const afterSet = await run<EnvFileSummary & { set: string[] }>('env.file.set', { path: '.env', entries: [{ key: 'DB_PASSWORD', value: 'new pass' }, { key: 'ADDED', value: 'x y', comment: 'added by smoke' }] }, ws.id);
    const setText = await fs.readFile(path.join(envRoot, '.env'), 'utf8');
    check(
      'env files: set rewrites the effective line in place, keeps everything else and appends new keys',
      afterSet.keys === 8 && setText.includes('DB_PASSWORD="new pass" # keep') && setText.startsWith('# App\n') && setText.endsWith('ADDED="x y" # added by smoke\n') && setText.includes('MULTI="line one\nline two"') && setText.split('\n').filter((l) => l.startsWith('PORT=')).length === 2,
      setText,
    );
    const badKey = await host.invoke('env.file.set', { path: '.env', entries: [{ key: 'bad key', value: '1' }] }, { caller: 'ui', workspaceId: ws.id });
    const outsideEnv = await host.invoke('env.file.read', { path: '../.env' }, { caller: 'ui', workspaceId: ws.id });
    const notEnv = await host.invoke('env.file.write', { path: 'package.json', text: '{}' }, { caller: 'ui', workspaceId: ws.id });
    check(
      'env files: invalid keys, paths outside the project and files not named like env files are refused',
      !badKey.ok && badKey.error.code === 'INVALID_INPUT' && !outsideEnv.ok && outsideEnv.error.code === 'INVALID_INPUT' && !notEnv.ok && notEnv.error.code === 'INVALID_INPUT',
      [badKey.ok ? 'ok?' : badKey.error.message, outsideEnv.ok ? 'ok?' : outsideEnv.error.message, notEnv.ok ? 'ok?' : notEnv.error.message],
    );
    const afterUnset = await run<EnvFileSummary & { removed: string[] }>('env.file.unset', { path: '.env', keys: ['PORT', 'NOPE'] }, ws.id);
    check('env files: unset removes every occurrence of a key', afterUnset.removed.join() === 'PORT' && afterUnset.keys === 7 && !(await fs.readFile(path.join(envRoot, '.env'), 'utf8')).includes('PORT='), afterUnset.removed);
    const envDiff = await run<EnvDiff>('env.file.diff', { path: '.env', against: '.env.example' }, ws.id);
    check(
      'env files: diff against the example lists missing, extra, empty and different keys',
      envDiff.missing.join() === 'PORT,FEATURE_FLAG,NEW_KEY' && envDiff.extra.join() === 'EMPTY,MULTI,ADDED' && envDiff.empty.length === 0 && envDiff.different.includes('APP_NAME') && envDiff.same.length === 0,
      envDiff,
    );
    const synced = await run<{ added: string[] }>('env.file.sync', { path: '.env', from: '.env.example', keys: ['FEATURE_FLAG', 'NEW_KEY'] }, ws.id);
    const syncedText = await fs.readFile(path.join(envRoot, '.env'), 'utf8');
    check(
      'env files: sync appends the chosen missing keys with the example values under a source comment',
      synced.added.join() === 'FEATURE_FLAG,NEW_KEY' && syncedText.includes('\n# Added from .env.example\nFEATURE_FLAG=false # new in the example\nNEW_KEY=hello\n'),
      syncedText.split('\n').slice(-4),
    );
    const envBackups = await run<EnvBackup[]>('env.backup.list', { path: '.env' }, ws.id);
    check('env files: every change kept a backup naming its cause, newest first', envBackups.length === 3 && envBackups[0].reason.startsWith('added FEATURE_FLAG') && envBackups[1].reason === 'removed PORT' && envBackups[2].reason === 'set DB_PASSWORD, ADDED', envBackups.map((b) => b.reason));
    await run('env.file.write', { path: '.env', text: 'APP_NAME=rewritten\n' }, ws.id);
    const restored = await run<EnvFileSummary>('env.backup.restore', { path: '.env', id: envBackups[2].id }, ws.id);
    check(
      'env files: restoring a backup brings the old text back and keeps the current one as a backup',
      (await fs.readFile(path.join(envRoot, '.env'), 'utf8')) === envOriginal && restored.keys === 7 && (await run<EnvBackup[]>('env.backup.list', { path: '.env' }, ws.id)).length === 5,
      restored.keys,
    );
    const envGroups = await run<EnvProfileGroup[]>('env.profile.list', {}, ws.id);
    check('env files: profiles grouped per folder, none active', envGroups.length === 1 && envGroups[0].dir === '' && envGroups[0].main === '.env' && envGroups[0].profiles.map((p) => p.name).join() === 'staging' && envGroups[0].profiles[0].active === false, envGroups);
    const switched = await run<{ main: EnvFileSummary; from: string; backup: EnvBackup | null }>('env.profile.use', { path: '.env.staging' }, ws.id);
    const envGroupsAfter = await run<EnvProfileGroup[]>('env.profile.list', {}, ws.id);
    check(
      'env files: switching a profile copies it over .env, backs the old one up and marks it active',
      switched.from === '.env.staging' && switched.backup !== null && (await fs.readFile(path.join(envRoot, '.env'), 'utf8')) === 'APP_NAME=smoke-staging\nPORT=4000\n' && envGroupsAfter[0].profiles[0].active === true,
      { from: switched.from, backup: switched.backup?.reason, active: envGroupsAfter[0].profiles[0].active },
    );
    const mainAsProfile = await host.invoke('env.profile.use', { path: '.env' }, { caller: 'ui', workspaceId: ws.id });
    check('env files: .env itself cannot be used as a profile', !mainAsProfile.ok && mainAsProfile.error.code === 'INVALID_INPUT');
    await run('env.backup.restore', { path: '.env', id: switched.backup!.id }, ws.id);
    type ImportOutcome = { environment: Environment; created: boolean; added: number; updated: number };
    const envImported = await run<ImportOutcome>('env.file.import', { path: '.env', name: 'from dotenv' }, ws.id);
    const envImportedVar = (key: string) => envImported.environment.variables.find((v) => v.key === key);
    check(
      'env files: import creates an environment, flagging secret-looking keys as secrets',
      envImported.created && envImported.added === 7 && envImported.updated === 0 && envImportedVar('DB_PASSWORD')?.secret === true && envImportedVar('DB_PASSWORD')?.value === 'p@ss word' && envImportedVar('DATABASE_URL')?.secret === true && envImportedVar('APP_NAME')?.secret === false && envImportedVar('PORT')?.value === '3001',
      envImported.environment.variables.map((v) => [v.key, v.secret]),
    );
    const envImportedFile = JSON.parse(await fs.readFile(path.join(envRoot, '.quiver', 'environments', `${envImported.environment.id}.json`), 'utf8')) as Environment;
    check('env files: the committed environment file carries no secret value', envImportedFile.variables.find((v) => v.key === 'DB_PASSWORD')?.value === '' && envImportedFile.variables.find((v) => v.key === 'APP_NAME')?.value === 'smoke');
    const envReimported = await run<ImportOutcome>('env.file.import', { path: '.env.staging', name: 'From Dotenv' }, ws.id);
    check(
      'env files: re-import into the same environment (name case-insensitive) updates without duplicating',
      !envReimported.created && envReimported.updated === 2 && envReimported.added === 0 && envReimported.environment.variables.length === 7 && envReimported.environment.variables.find((v) => v.key === 'PORT')?.value === '4000' && envReimported.environment.id === envImported.environment.id,
      { created: envReimported.created, updated: envReimported.updated, added: envReimported.added },
    );
    const agentImport = await host.invoke('env.file.import', { path: '.env', environmentId: envImported.environment.id }, { caller: 'mcp', workspaceId: ws.id });
    check('env files: agents get the imported environment with secrets masked', agentImport.ok && (agentImport.result as ImportOutcome).environment.variables.find((v) => v.key === 'DB_PASSWORD')?.value === '••••••••', agentImport.ok ? 'ok' : agentImport.error.message);
    const exported = await run<{ file: EnvFileSummary; exported: number }>('env.file.export', { environmentId: envImported.environment.id, path: 'exported.env' }, ws.id);
    const exportedText = await fs.readFile(path.join(envRoot, 'exported.env'), 'utf8');
    check(
      'env files: export writes a new file with a header and every enabled variable, secrets included',
      exported.exported === 7 && exported.file.kind === 'other' && exportedText.startsWith('# Exported from the Quiver environment "from dotenv"\n') && exportedText.includes('DB_PASSWORD="p@ss word"') && exportedText.includes('PORT=3001') && exportedText.includes('MULTI="line one\\nline two"'),
      exportedText,
    );
    await run('env.file.export', { environmentId: envImported.environment.id, path: '.env.example', includeSecrets: false }, ws.id);
    const exampleText = await fs.readFile(path.join(envRoot, '.env.example'), 'utf8');
    check(
      'env files: exporting into an existing file updates keys in place, appends the rest and can leave secrets empty',
      exampleText.includes('APP_NAME=smoke\nPORT=3001\nDB_PASSWORD=\nAPI_TOKEN=\nDATABASE_URL=\nFEATURE_FLAG=false # new in the example\nNEW_KEY=hello\n') && exampleText.endsWith('EMPTY=\nMULTI="line one\\nline two"\n'),
      exampleText,
    );
    const createdEnv = await run<EnvFileSummary>('env.file.create', { path: 'apps/web/.env.example', from: 'apps/web/.env', values: 'clear' }, ws.id);
    check('env files: create from another file can clear the values and keeps its line endings', createdEnv.path === 'apps/web/.env.example' && createdEnv.kind === 'example' && (await fs.readFile(path.join(envRoot, 'apps', 'web', '.env.example'), 'utf8')) === 'VITE_API=\r\n', createdEnv.path);
    const dupCreate = await host.invoke('env.file.create', { path: 'apps/web/.env.example' }, { caller: 'ui', workspaceId: ws.id });
    check('env files: create refuses to overwrite', !dupCreate.ok && dupCreate.error.code === 'INVALID_INPUT', dupCreate.ok ? 'ok?' : dupCreate.error.message);
    const deletedEnv = await run<{ deleted: boolean; backup: EnvBackup | null }>('env.file.delete', { path: 'exported.env' }, ws.id);
    check('env files: delete removes the file and keeps its content as a backup', deletedEnv.deleted && deletedEnv.backup?.reason === 'deleted' && (await fs.stat(path.join(envRoot, 'exported.env')).catch(() => null)) === null);
    const revived = await run<EnvFileSummary>('env.backup.restore', { path: 'exported.env', id: deletedEnv.backup!.id }, ws.id);
    check('env files: a deleted file comes back from its backup', revived.keys === 7 && (await fs.readFile(path.join(envRoot, 'exported.env'), 'utf8')) === exportedText);
    await run('env.file.delete', { path: 'exported.env' }, ws.id);

    // Env files over MCP: tools listed, secrets masked, writes gated.
    check(
      'mcp lists env tools',
      ['env_file_list', 'env_file_read', 'env_file_set', 'env_file_diff', 'env_file_sync', 'env_profile_list', 'env_profile_use', 'env_backup_list', 'env_file_import', 'env_file_export'].every((n) => names.includes(n)),
      names.filter((n) => n.startsWith('env_')),
    );
    const agentEnv = await rpc('tools/call', { name: 'env_file_read', arguments: { path: '.env' } });
    const agentEnvText = agentEnv.result?.content?.[0]?.text ?? '';
    check('mcp masks env secrets for agents', agentEnv.result?.isError !== true && agentEnvText.includes('••••••••') && agentEnvText.includes('APP_NAME') && !agentEnvText.includes('p@ss word') && !agentEnvText.includes('tok_123'), agentEnvText.slice(0, 160));
    for (const [tool, args] of [
      ['env_file_read', { path: '.env', reveal: true }],
      ['env_file_set', { path: '.env', entries: [{ key: 'X', value: '1' }] }],
      ['env_file_write', { path: '.env', text: '' }],
      ['env_file_unset', { path: '.env', keys: ['APP_NAME'] }],
      ['env_file_create', { path: '.env.new' }],
      ['env_file_delete', { path: '.env' }],
      ['env_file_sync', { path: '.env', from: '.env.example' }],
      ['env_profile_use', { path: '.env.staging' }],
      ['env_backup_restore', { path: '.env', id: 'x' }],
      ['env_file_export', { path: '.env', environmentId: envImported.environment.id }],
    ] as const) {
      const blockedEnv = await rpc('tools/call', { name: tool, arguments: args });
      check(`mcp blocks ${tool} by default`, blockedEnv.result?.isError === true && (blockedEnv.result.content?.[0]?.text ?? '').includes('MUTATION_BLOCKED'));
    }
    check('env files: .env untouched by the blocked calls', (await fs.readFile(path.join(envRoot, '.env'), 'utf8')) === envOriginal);

    // Updater: a dev build reports that it cannot update itself, and the mutating commands are gated for agents.
    const updateState = await run<UpdateState>('app.update.check', {}, null);
    check(
      'update: dev build reports unsupported',
      updateState.supported === false && updateState.status === 'idle' && updateState.current === host.api.version && Boolean(updateState.reason),
      updateState,
    );
    const infoWithUpdate = await run<{ version: string; update: UpdateState }>('app.info', {}, null);
    check('update: app.info carries the updater state', infoWithUpdate.update?.supported === false && infoWithUpdate.version === updateState.current);
    for (const tool of ['app_update_download', 'app_update_install']) {
      const blockedUpdate = await rpc('tools/call', { name: tool, arguments: {} });
      check(`mcp blocks ${tool} by default`, blockedUpdate.result?.isError === true && (blockedUpdate.result.content?.[0]?.text ?? '').includes('MUTATION_BLOCKED'));
    }

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

    // Theme: the brand palette is the default, and a palette saved in config recolours the running UI in both modes.
    {
      const cssVar = (name: string) => win.webContents.executeJavaScript(`getComputedStyle(document.documentElement).getPropertyValue('${name}').trim()`) as Promise<string>;
      const isDark = () => win.webContents.executeJavaScript(`document.documentElement.classList.contains('dark')`) as Promise<boolean>;
      const setDark = (dark: boolean) => win.webContents.executeJavaScript(`document.documentElement.classList.toggle('dark', ${dark})`);
      const waitFor = async (predicate: () => Promise<boolean>) => {
        for (let i = 0; i < 40 && !(await predicate()); i++) await new Promise((r) => setTimeout(r, 50));
      };
      check('theme: default palette in config', host.config.get().palette === DEFAULT_PALETTE, host.config.get().palette);
      const mode = (await isDark()) ? 'dark' : 'light';
      check('theme: default palette applied', (await cssVar('--accent')) === resolvePalette(DEFAULT_PALETTE)[mode].accent, await cssVar('--accent'));
      await run('config.update', { patch: { palette: 'signal-blue' } }, null);
      const blue = resolvePalette('signal-blue');
      await waitFor(async () => (await cssVar('--accent')) === blue[mode].accent);
      check('theme: palette change recolours the UI', (await cssVar('--accent')) === blue[mode].accent, await cssVar('--accent'));
      await setDark(mode === 'light');
      const other = mode === 'light' ? 'dark' : 'light';
      check('theme: palette follows the dark class', (await cssVar('--canvas')) === blue[other].canvas, await cssVar('--canvas'));
      await setDark(mode === 'dark');
      await run('config.update', { patch: { palette: 'no-such-palette' } }, null);
      await waitFor(async () => (await cssVar('--accent')) === resolvePalette(DEFAULT_PALETTE)[mode].accent);
      check('theme: unknown palette falls back to the default', (await cssVar('--accent')) === resolvePalette(DEFAULT_PALETTE)[mode].accent, await cssVar('--accent'));
      await run('config.update', { patch: { palette: DEFAULT_PALETTE } }, null);
    }

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

      // Teleport module: one section per cluster, pinned resources from both, tunnels, kube clusters.
      const clickedTeleport = await js(
        `(() => { const btn = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || b.title || '') === 'Teleport'); if (btn) btn.click(); return Boolean(btn); })()`,
      );
      check('ui: teleport module button', clickedTeleport === true);
      await wait(1500);
      const clusterRows = await js(`[...document.querySelectorAll('[data-testid=teleport-cluster]')].map((r) => [r.getAttribute('data-proxy'), r.getAttribute('data-state')])`);
      check('ui: both clusters listed as logged in', Array.isArray(clusterRows) && clusterRows.length === 2 && clusterRows.every((r: string[]) => r[1] === 'logged-in'), clusterRows);
      const clusterText = await js(`[...document.querySelectorAll('[data-testid=teleport-cluster]')].map((r) => r.textContent).join(' | ')`);
      check('ui: cluster headers show name, user and countdown', typeof clusterText === 'string' && clusterText.includes('smoke.teleport.local') && clusterText.includes('second.teleport.local') && clusterText.includes('smoke-user') && /\d+h \d+m/.test(clusterText), clusterText);
      const pinRows = await js(`[...document.querySelectorAll('[data-testid=teleport-pin]')].map((r) => r.textContent)`);
      check('ui: pinned resources from both clusters', Array.isArray(pinRows) && pinRows.length === 3 && pinRows.some((t: string) => t.includes('smoke-redis')) && pinRows.some((t: string) => t.includes('eu-eks')) && pinRows.some((t: string) => t.includes('second-mysql')), pinRows);
      const dbRows = await js(`document.querySelectorAll('[data-testid=teleport-db]').length`);
      check('ui: databases of both clusters listed', dbRows === 6, dbRows);
      const tunnelShown = await js(`[...document.querySelectorAll('[data-testid=teleport-db]')].find((r) => r.textContent.includes('smoke-redis'))?.textContent ?? ''`);
      check('ui: running tunnel shown on its database row', typeof tunnelShown === 'string' && /:\d+/.test(tunnelShown) && tunnelShown.includes('as default'), tunnelShown);
      const kubeRows = await js(`[...document.querySelectorAll('[data-testid=teleport-kube]')].map((r) => r.textContent)`);
      check('ui: kube clusters of both clusters with the active one', Array.isArray(kubeRows) && kubeRows.length === 3 && kubeRows.some((t: string) => t.includes('dev-eks') && t.includes('active')) && kubeRows.some((t: string) => t.includes('eu-eks')), kubeRows);
      await shot('09-teleport-dark');
      await js(`document.documentElement.classList.remove('dark')`);
      await wait(300);
      await shot('10-teleport-light');
      const clickedUnpin = await js(
        `(() => { const row = [...document.querySelectorAll('[data-testid=teleport-pin]')].find((r) => r.textContent.includes('second-mysql')); const btn = row && row.querySelector('button[aria-label="Unpin"]'); if (btn) btn.click(); return Boolean(btn); })()`,
      );
      check('ui: unpin button on a pinned row', clickedUnpin === true);
      await wait(1000);
      const pinsAfter = await js(`document.querySelectorAll('[data-testid=teleport-pin]').length`);
      check('ui: unpin removes the row', pinsAfter === 2, pinsAfter);
      const clickedStop = await js(
        `(() => { const row = [...document.querySelectorAll('[data-testid=teleport-db]')].find((r) => r.textContent.includes('smoke-redis')); const btn = row && [...row.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Stop'); if (btn) btn.click(); return Boolean(btn); })()`,
      );
      check('ui: stop button on the tunnel row', clickedStop === true);
      await wait(1500);
      const afterStop = await js(`[...document.querySelectorAll('[data-testid=teleport-db]')].find((r) => r.textContent.includes('smoke-redis'))?.textContent ?? ''`);
      check('ui: row shows Connect after stopping', typeof afterStop === 'string' && !/:\d+/.test(afterStop), afterStop);
      const clickedConnect = await js(
        `(() => { const row = [...document.querySelectorAll('[data-testid=teleport-pin]')].find((r) => r.textContent.includes('smoke-redis')); if (row) row.click(); return Boolean(row); })()`,
      );
      check('ui: connect from the pinned row', clickedConnect === true);
      await wait(2500);
      const revealed = await js(`(() => { const aside = document.querySelector('aside'); return aside ? aside.textContent.includes('Databases') && aside.textContent.includes('smoke-redis') : false; })()`);
      check('ui: connect reveals the connection in the Databases tree', revealed === true);
      const keysTabOpen = await js(`Boolean(document.querySelector('[data-tab-type="db.redis"]'))`);
      check('ui: connect opens the key browser', keysTabOpen === true);
      await shot('11-teleport-revealed-light');

      // Mock servers module: server rows, route editor, live request list with detail.
      const clickedMock = await js(
        `(() => { const btn = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || b.title || '') === 'Mock servers'); if (btn) btn.click(); return Boolean(btn); })()`,
      );
      check('ui: mock servers module button', clickedMock === true);
      await wait(800);
      const mockRows = await js(`[...document.querySelectorAll('[data-testid=mock-server]')].map((r) => [r.textContent, r.getAttribute('data-running')])`);
      check(
        'ui: server row shows name, port and running state',
        Array.isArray(mockRows) && mockRows.length === 1 && mockRows[0][0].includes('smoke mock') && mockRows[0][0].includes(`:${mock.port}`) && mockRows[0][1] === 'true',
        mockRows,
      );
      const clickedServer = await js(`(() => { const row = document.querySelector('[data-testid=mock-server]'); if (row) row.click(); return Boolean(row); })()`);
      check('ui: server row opens its tab', clickedServer === true);
      await wait(1000);
      const routeItems = await js(`document.querySelectorAll('[data-testid=mock-route-item]').length`);
      check('ui: routes listed in the tab', routeItems === 5, routeItems);
      const clickedRoute = await js(
        `(() => { const el = [...document.querySelectorAll('[data-testid=mock-route-item]')].find((r) => r.textContent.includes('/users/:id')); if (el) el.click(); return Boolean(el); })()`,
      );
      check('ui: route item clickable', clickedRoute === true);
      await wait(500);
      const routePath = await js(`document.querySelector('[data-testid=mock-route-path]')?.value ?? null`);
      check('ui: route editor shows the selected route', routePath === '/users/:id', routePath);
      const shownUrl = await js(`document.querySelector('[data-testid=mock-server-url]')?.textContent ?? ''`);
      check('ui: tab header shows the listening url', shownUrl === base, shownUrl);
      await shot('12-mock-routes-light');
      const clickedRequestsTab = await js(
        `(() => { const btn = [...document.querySelectorAll('[role=tab]')].find((b) => b.textContent.startsWith('Requests')); if (btn) btn.click(); return Boolean(btn); })()`,
      );
      check('ui: requests view tab', clickedRequestsTab === true);
      await wait(1000);
      const requestRows = await js(`[...document.querySelectorAll('[data-testid=mock-request]')].map((r) => r.textContent)`);
      check(
        'ui: captured requests listed newest first',
        Array.isArray(requestRows) && requestRows.length === 5 && requestRows[0].includes('/from-agent') && requestRows[2].includes('/missing') && requestRows[2].includes('404') && requestRows[4].includes('/users/1?q=ui'),
        requestRows,
      );
      await fetch(`${base}/live`, { method: 'PATCH' });
      await wait(900);
      const liveRows = await js(`document.querySelectorAll('[data-testid=mock-request]').length`);
      check('ui: request list updates live', liveRows === 6, liveRows);
      const clickedRequest = await js(
        `(() => { const el = [...document.querySelectorAll('[data-testid=mock-request]')].find((r) => r.textContent.includes('/echo')); if (el) el.click(); return Boolean(el); })()`,
      );
      check('ui: request row clickable', clickedRequest === true);
      await wait(700);
      const detailText = await js(`document.querySelector('[data-testid=mock-request-detail]')?.textContent ?? ''`);
      check('ui: request detail shows method, url, outcome and body', typeof detailText === 'string' && detailText.includes('POST') && detailText.includes('/echo') && detailText.includes('route') && detailText.includes('Ada'), String(detailText).slice(0, 200));
      await shot('13-mock-requests-light');
      await js(`document.documentElement.classList.add('dark')`);
      await wait(300);
      await shot('14-mock-requests-dark');
      await js(`document.documentElement.classList.remove('dark')`);
      await wait(200);

      // Realtime module: connection rows, live message log, composer.
      const clickedRealtime = await js(
        `(() => { const btn = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || b.title || '') === 'Realtime'); if (btn) btn.click(); return Boolean(btn); })()`,
      );
      check('ui: realtime module button', clickedRealtime === true);
      await wait(800);
      const rtRows = await js(`[...document.querySelectorAll('[data-testid=realtime-connection]')].map((r) => [r.textContent, r.getAttribute('data-status')])`);
      check(
        'ui: connection rows show kind, name and status',
        Array.isArray(rtRows) &&
          rtRows.length === 2 &&
          rtRows.some((r: string[]) => r[0].includes('WS') && r[0].includes('smoke ws') && r[1] === 'open') &&
          rtRows.some((r: string[]) => r[0].includes('SSE') && r[0].includes('smoke sse') && r[1] === 'disconnected'),
        rtRows,
      );
      const clickedWsRow = await js(
        `(() => { const row = [...document.querySelectorAll('[data-testid=realtime-connection]')].find((r) => r.textContent.includes('smoke ws')); if (row) row.click(); return Boolean(row); })()`,
      );
      check('ui: websocket row opens its tab', clickedWsRow === true);
      await wait(1000);
      const rtStatus = await js(`document.querySelector('[data-testid=realtime-status]')?.textContent ?? ''`);
      check('ui: tab header shows connected with the subprotocol', typeof rtStatus === 'string' && rtStatus.includes('connected') && rtStatus.includes('quiver.v1'), rtStatus);
      const rtMessages = await js(`[...document.querySelectorAll('[data-testid=realtime-message]')].map((r) => r.getAttribute('data-direction') + ':' + r.textContent)`);
      check(
        'ui: message log lists system, received and sent entries',
        Array.isArray(rtMessages) &&
          rtMessages.length >= 4 &&
          rtMessages.some((t: string) => t.startsWith('system:') && t.includes('Connected')) &&
          rtMessages.some((t: string) => t.startsWith('in:') && t.includes('echo:agent')) &&
          rtMessages.some((t: string) => t.startsWith('out:') && t.includes('agent')),
        Array.isArray(rtMessages) ? rtMessages.slice(-4) : rtMessages,
      );
      for (const socket of wsSockets) socket.send('server push');
      await wait(900);
      const pushed = await js(`[...document.querySelectorAll('[data-testid=realtime-message]')].some((r) => r.textContent.includes('server push'))`);
      check('ui: message log updates live', pushed === true);
      const typed = await js(
        `(() => { const content = document.querySelector('[data-testid=realtime-composer] .cm-content'); if (!content) return false; content.focus(); return document.execCommand('insertText', false, 'from the ui'); })()`,
      );
      check('ui: composer accepts text', typed === true);
      await wait(200);
      const clickedRtSend = await js(`(() => { const btn = document.querySelector('[data-testid=realtime-send]'); if (btn && !btn.disabled) { btn.click(); return true; } return false; })()`);
      check('ui: send button enabled while connected', clickedRtSend === true);
      await wait(900);
      const uiEcho = await js(`[...document.querySelectorAll('[data-testid=realtime-message]')].filter((r) => r.textContent.includes('from the ui')).map((r) => r.getAttribute('data-direction'))`);
      check('ui: sent message and its echo appear', Array.isArray(uiEcho) && uiEcho.includes('out') && uiEcho.includes('in'), uiEcho);
      await shot('15-realtime-light');
      await js(`document.documentElement.classList.add('dark')`);
      await wait(300);
      await shot('16-realtime-dark');
      await js(`document.documentElement.classList.remove('dark')`);
      await wait(200);

      // GraphQL: request row label, body editor with schema status, docs explorer.
      const clickedApi = await js(
        `(() => { const btn = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || b.title || '') === 'API client'); if (btn) btn.click(); return Boolean(btn); })()`,
      );
      check('ui: api module button', clickedApi === true);
      await wait(500);
      const gqlRowLabel = await js(
        `(() => { const row = [...document.querySelectorAll('[role=button]')].find((r) => r.textContent.includes('smoke graphql')); if (!row) return null; const label = row.textContent.slice(0, 3); row.click(); return label; })()`,
      );
      check('ui: graphql request row is labelled GQL', gqlRowLabel === 'GQL', gqlRowLabel);
      await wait(1000);
      const clickedBodyTab = await js(
        `(() => { const pane = [...document.querySelectorAll('[data-tab-type="api.request"]')].find((el) => !el.classList.contains('hidden')); const btn = pane && [...pane.querySelectorAll('[role=tab]')].find((b) => b.textContent.startsWith('Body')); if (btn) btn.click(); return Boolean(btn); })()`,
      );
      check('ui: body section tab', clickedBodyTab === true);
      await wait(1500);
      const gqlQueryText = await js(`document.querySelector('[data-testid=graphql-query] .cm-content')?.textContent ?? ''`);
      check('ui: graphql editor shows the query', typeof gqlQueryText === 'string' && gqlQueryText.includes('hello(name: $name)'), gqlQueryText);
      const gqlStatus = await js(`document.querySelector('[data-testid=graphql-schema-status]')?.textContent ?? ''`);
      check('ui: schema status shows the cached schema', typeof gqlStatus === 'string' && /Schema: \d+ types/.test(gqlStatus), gqlStatus);
      await shot('17-graphql-light');
      const clickedDocs = await js(`(() => { const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Docs'); if (btn) btn.click(); return Boolean(btn); })()`);
      check('ui: docs button opens the schema explorer', clickedDocs === true);
      await wait(1000);
      const typeNames = await js(`[...document.querySelectorAll('[data-testid=graphql-type]')].map((b) => b.textContent)`);
      check('ui: schema explorer lists root and object types', Array.isArray(typeNames) && typeNames.includes('Query') && typeNames.includes('Mutation') && typeNames.includes('User'), typeNames);
      const clickedUser = await js(`(() => { const btn = [...document.querySelectorAll('[data-testid=graphql-type]')].find((b) => b.textContent === 'User'); if (btn) btn.click(); return Boolean(btn); })()`);
      await wait(400);
      const userDetail = await js(`document.querySelector('[data-testid=graphql-type-detail]')?.textContent ?? ''`);
      check(
        'ui: type detail shows fields, description and deprecation',
        clickedUser === true && typeof userDetail === 'string' && userDetail.includes('A person') && userDetail.includes('name') && userDetail.includes('Deprecated'),
        String(userDetail).slice(0, 160),
      );
      await shot('18-graphql-schema-light');

      // MCP inspector: server rows, tools list, a tool call from the UI, the traffic log.
      const clickedMcp = await js(
        `(() => { const btn = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || b.title || '') === 'MCP inspector'); if (btn) btn.click(); return Boolean(btn); })()`,
      );
      check('ui: mcp inspector module button', clickedMcp === true);
      await wait(800);
      const mcpRows = await js(`[...document.querySelectorAll('[data-testid=mcp-server]')].map((r) => [r.textContent, r.getAttribute('data-status')])`);
      check(
        'ui: server rows show transport, name and status',
        Array.isArray(mcpRows) &&
          mcpRows.length === 5 &&
          mcpRows.some((r: string[]) => r[0].includes('HTTP') && r[0].includes('smoke http') && r[1] === 'connected') &&
          mcpRows.some((r: string[]) => r[0].includes('CMD') && r[0].includes('smoke-stdio') && r[1] === 'disconnected') &&
          mcpRows.some((r: string[]) => r[0].includes('SSE') && r[0].includes('smoke-sse')),
        mcpRows,
      );
      const clickedHttpRow = await js(
        `(() => { const row = [...document.querySelectorAll('[data-testid=mcp-server]')].find((r) => r.textContent.includes('smoke http')); if (row) row.click(); return Boolean(row); })()`,
      );
      check('ui: server row opens its tab', clickedHttpRow === true);
      await wait(1200);
      const mcpStatus = await js(`document.querySelector('[data-testid=mcp-status]')?.textContent ?? ''`);
      check('ui: tab header shows connected with the server name and version', typeof mcpStatus === 'string' && mcpStatus.includes('connected') && mcpStatus.includes('smoke-http 1.2.3'), mcpStatus);
      const toolNames = await js(`[...document.querySelectorAll('[data-testid=mcp-tool]')].map((b) => b.textContent)`);
      check('ui: tools listed', Array.isArray(toolNames) && toolNames.length === 4 && toolNames.some((t: string) => t.startsWith('echo')), toolNames);
      const clickedEcho = await js(`(() => { const btn = [...document.querySelectorAll('[data-testid=mcp-tool]')].find((b) => b.textContent.startsWith('echo')); if (btn) btn.click(); return Boolean(btn); })()`);
      await wait(600);
      const argsText = await js(`document.querySelector('[data-testid=mcp-tool-args] .cm-content')?.textContent ?? ''`);
      check('ui: arguments prefilled from the schema', clickedEcho === true && typeof argsText === 'string' && argsText.replace(/\s/g, '') === '{"text":""}', argsText);
      const typedArgs = await js(
        `(() => { const content = document.querySelector('[data-testid=mcp-tool-args] .cm-content'); if (!content) return false; content.focus(); document.execCommand('selectAll'); return document.execCommand('insertText', false, '{"text":"from the ui"}'); })()`,
      );
      check('ui: arguments editor accepts text', typedArgs === true);
      await wait(200);
      const clickedCall = await js(`(() => { const btn = document.querySelector('[data-testid=mcp-tool-call]'); if (btn && !btn.disabled) { btn.click(); return true; } return false; })()`);
      await wait(1200);
      const resultText = await js(`document.querySelector('[data-testid=mcp-tool-result]')?.textContent ?? ''`);
      check(
        'ui: tool result shows content, structured content and timing',
        clickedCall === true && typeof resultText === 'string' && resultText.includes('echo:from the ui') && resultText.includes('structured') && /\d+ ms/.test(resultText),
        String(resultText).slice(0, 200),
      );
      await shot('19-mcp-tools-light');
      const clickedLogTab = await js(
        `(() => { const pane = [...document.querySelectorAll('[data-tab-type="mcp.server"]')].find((el) => !el.classList.contains('hidden')); const btn = pane && [...pane.querySelectorAll('[role=tab]')].find((b) => b.textContent.startsWith('Log')); if (btn) btn.click(); return Boolean(btn); })()`,
      );
      check('ui: log tab', clickedLogTab === true);
      await wait(800);
      const logRows = await js(`[...document.querySelectorAll('[data-testid=mcp-log-entry]')].map((r) => r.getAttribute('data-direction') + ':' + r.getAttribute('data-kind') + ':' + r.textContent)`);
      check(
        'ui: log lists the call pair with method and timing',
        Array.isArray(logRows) &&
          logRows.some((t: string) => t.startsWith('out:request:') && t.includes('tools/call')) &&
          logRows.some((t: string) => t.startsWith('in:response:') && t.includes('tools/call') && /\d+ ms/.test(t)),
        Array.isArray(logRows) ? logRows.slice(-3) : logRows,
      );
      await shot('20-mcp-log-light');
      await js(`document.documentElement.classList.add('dark')`);
      await wait(300);
      await shot('21-mcp-log-dark');
      await js(`document.documentElement.classList.remove('dark')`);
      await wait(200);

      // Env files: sidebar rows with kinds and git warnings, masked values, reveal, inline edits, the watcher, compare view.
      const clickedEnvModule = await js(
        `(() => { const btn = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || b.title || '') === 'Env files'); if (btn) btn.click(); return Boolean(btn); })()`,
      );
      check('ui: env files module button', clickedEnvModule === true);
      await wait(1200);
      const envRows = await js(`[...document.querySelectorAll('[data-testid=env-file]')].map((r) => [r.getAttribute('data-path'), r.getAttribute('data-kind'), r.getAttribute('data-warning')])`);
      check(
        'ui: env file rows show every file with its kind and git warning',
        Array.isArray(envRows) &&
          envRows.length === 7 &&
          envRows.some((r: string[]) => r[0] === '.env' && r[1] === 'main' && (!hasGit || r[2] === 'tracked')) &&
          envRows.some((r: string[]) => r[0] === '.env.staging' && r[1] === 'profile') &&
          envRows.some((r: string[]) => r[0] === 'apps/web/.env.example' && r[1] === 'example'),
        envRows,
      );
      const clickedEnvRow = await js(`(() => { const row = document.querySelector('[data-testid=env-file][data-path=".env"]'); if (row) row.click(); return Boolean(row); })()`);
      await wait(1200);
      const envValueRows = await js(`[...document.querySelectorAll('[data-testid=env-entry]')].map((r) => r.getAttribute('data-key') + ':' + r.getAttribute('data-masked') + ':' + r.querySelector('[data-testid=env-value]').textContent)`);
      check(
        'ui: secret-looking values are masked, the others shown',
        clickedEnvRow === true && Array.isArray(envValueRows) && envValueRows.includes('DB_PASSWORD:true:••••••••') && envValueRows.includes('API_TOKEN:true:••••••••') && envValueRows.includes('APP_NAME:false:smoke') && envValueRows.includes('EMPTY:false:(empty)'),
        envValueRows,
      );
      const envHeader = await js(`(document.querySelector('[data-testid=env-counts]')?.textContent ?? '') + '|' + (document.querySelector('[data-testid=env-warning]')?.textContent ?? '')`);
      check('ui: tab header shows counts and the git warning', typeof envHeader === 'string' && envHeader.startsWith('7 keys · 3 secret · 1 empty') && (!hasGit || envHeader.endsWith('committed to git')), envHeader);
      await shot('22-env-keys-light');
      const clickedReveal = await js(`(() => { const btn = document.querySelector('[data-testid=env-reveal]'); if (btn) btn.click(); return Boolean(btn); })()`);
      await wait(300);
      const revealedRows = await js(`[...document.querySelectorAll('[data-testid=env-entry]')].map((r) => r.getAttribute('data-key') + ':' + r.querySelector('[data-testid=env-value]').textContent)`);
      check('ui: reveal shows the real values', clickedReveal === true && Array.isArray(revealedRows) && revealedRows.includes('DB_PASSWORD:p@ss word') && revealedRows.includes('API_TOKEN:tok_123'), revealedRows);
      const startedEdit = await js(`(() => { const row = document.querySelector('[data-testid=env-entry][data-key="APP_NAME"]'); const btn = row && row.querySelector('[data-testid=env-value]'); if (btn) btn.click(); return Boolean(btn); })()`);
      await wait(300);
      const typedValue = await js(
        `(() => { const input = document.querySelector('[data-testid=env-value-input]'); if (!input) return false; const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(input, 'edited-in-ui'); input.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`,
      );
      await wait(100);
      const clickedValueSave = await js(`(() => { const btn = document.querySelector('[data-testid=env-value-save]'); if (btn) btn.click(); return Boolean(btn); })()`);
      await wait(1200);
      const editedOnDisk = await fs.readFile(path.join(envRoot, '.env'), 'utf8');
      check(
        'ui: editing a value inline rewrites that line only',
        startedEdit === true && typedValue === true && clickedValueSave === true && editedOnDisk.includes('APP_NAME=edited-in-ui') && editedOnDisk.includes('DB_PASSWORD="p@ss word" # keep') && editedOnDisk.startsWith('# App\n'),
        editedOnDisk.split('\n').slice(0, 3),
      );
      const typedNewKey = await js(
        `(() => { const k = document.querySelector('[data-testid=env-add-key]'); const v = document.querySelector('[data-testid=env-add-value]'); if (!k || !v) return false; const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(k, 'FROM_UI'); k.dispatchEvent(new Event('input', { bubbles: true })); setter.call(v, 'yes'); v.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`,
      );
      await wait(200);
      const clickedAddKey = await js(`(() => { const btn = document.querySelector('[data-testid=env-add]'); if (btn && !btn.disabled) { btn.click(); return true; } return false; })()`);
      await wait(1200);
      check('ui: adding a key appends it to the file', typedNewKey === true && clickedAddKey === true && (await fs.readFile(path.join(envRoot, '.env'), 'utf8')).endsWith('FROM_UI=yes\n'));
      await fs.appendFile(path.join(envRoot, '.env'), 'FROM_DISK=1\n');
      await wait(2000);
      const watched = await js(`[...document.querySelectorAll('[data-testid=env-entry]')].some((r) => r.getAttribute('data-key') === 'FROM_DISK')`);
      check('ui: a change made on disk shows up on its own', watched === true);
      const clickedCompare = await js(
        `(() => { const pane = [...document.querySelectorAll('[data-tab-type="env.file"]')].find((el) => !el.classList.contains('hidden')); const btn = pane && [...pane.querySelectorAll('[role=tab]')].find((b) => b.textContent.startsWith('Compare')); if (btn) btn.click(); return Boolean(btn); })()`,
      );
      await wait(1200);
      const compareAgainst = await js(`document.querySelector('[data-testid=env-compare-select]')?.value ?? ''`);
      const missingKeys = await js(`[...document.querySelectorAll('[data-testid=env-compare-missing] li')].map((li) => li.textContent.replace(/Add$/, '').trim())`);
      check('ui: compare view defaults to the example and lists the missing keys', clickedCompare === true && compareAgainst === '.env.example' && Array.isArray(missingKeys) && missingKeys.join() === 'FEATURE_FLAG,NEW_KEY', { compareAgainst, missingKeys });
      await shot('23-env-compare-light');
      await js(`document.documentElement.classList.add('dark')`);
      await js(
        `(() => { const pane = [...document.querySelectorAll('[data-tab-type="env.file"]')].find((el) => !el.classList.contains('hidden')); const btn = pane && [...pane.querySelectorAll('[role=tab]')].find((b) => b.textContent.startsWith('Keys')); if (btn) btn.click(); })()`,
      );
      await wait(500);
      await shot('24-env-keys-dark');
      await js(`document.documentElement.classList.remove('dark')`);
      await wait(200);

      // Settings: the About section shows the version and says that a dev build does not update itself.
      await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', ctrlKey: true, bubbles: true }))`);
      await wait(600);
      const aboutVersion = await js(
        `(() => { const el = document.querySelector('[data-testid=about-version]'); if (el) el.scrollIntoView(); return el ? el.textContent : null; })()`,
      );
      check('ui: about shows the running version', typeof aboutVersion === 'string' && aboutVersion.includes(host.api.version), aboutVersion);
      const updateNote = await js(`(() => { const el = document.querySelector('[data-testid=update-note]'); return el ? el.textContent : null; })()`);
      check('ui: about says updates are off in dev builds', typeof updateNote === 'string' && updateNote.includes('installed builds'), updateNote);
      const markInTitle = await js(`Boolean(document.querySelector('header [data-testid=quiver-mark]'))`);
      check('ui: title bar shows the logo mark', markInTitle === true);
      await wait(200);
      await shot('25-settings-about-light');

      // Settings: the palette picker lists every brand palette and applies the one clicked.
      const paletteCount = await js(`document.querySelectorAll('[data-testid=palette-option]').length`);
      check('ui: settings lists the palettes', paletteCount === 6, paletteCount);
      await js(`(() => { const el = document.querySelector('[data-testid=palette-option][data-palette=ember]'); el.scrollIntoView({ block: 'center' }); el.click(); })()`);
      await wait(500);
      const emberAccent = await js(`getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()`);
      const emberMode = (await js(`document.documentElement.classList.contains('dark')`)) ? 'dark' : 'light';
      await js(`document.documentElement.classList.remove('dark')`);
      await wait(200);
      check('ui: clicking a palette applies it', emberAccent === resolvePalette('ember')[emberMode].accent && host.config.get().palette === 'ember', { emberAccent, saved: host.config.get().palette });
      await shot('26-settings-palette-ember-light');
      await js(`document.documentElement.classList.add('dark')`);
      await wait(200);
      await shot('27-settings-palette-ember-dark');
      await js(`document.documentElement.classList.remove('dark')`);
      await js(`document.querySelector('[data-testid=palette-option][data-palette=${DEFAULT_PALETTE}]').click()`);
      await wait(300);
    }

    const outSecond = await run<TeleportStatus>('teleport.logout', { proxy: second }, null);
    check(
      'teleport: logout of one cluster keeps the other',
      clusterOf(outSecond, second)?.state === 'logged-out' && clusterOf(outSecond, first)?.state === 'logged-in' && !outSecond.tunnels.some((t) => t.proxy === second),
      outSecond.clusters.map((c) => [c.proxy, c.state]),
    );
    const removed = await run<TeleportStatus>('teleport.cluster.remove', { proxy: second }, null);
    check('teleport: cluster remove drops it and its pins', removed.clusters.length === 1 && removed.pins.every((p) => p.proxy === first), { clusters: removed.clusters.map((c) => c.proxy), pins: removed.pins });
    const loggedOut = await run<TeleportStatus>('teleport.logout', {}, null);
    check('teleport: logout of all clears every session and tunnel', loggedOut.state === 'logged-out' && loggedOut.clusters.every((c) => c.state === 'logged-out') && loggedOut.tunnels.length === 0, { state: loggedOut.state, tunnels: loggedOut.tunnels.length });
    check('renderer has no console errors', errors.length === 0, errors);
    win.destroy();
  } catch (err) {
    check(`unexpected error: ${(err as Error).message}`, false);
    console.error(err);
  } finally {
    echo.close();
    gql.close();
    sse.closeAllConnections();
    sse.close();
    for (const socket of wsSockets) socket.terminate();
    wss.close();
    wsHttp.closeAllConnections();
    wsHttp.close();
    await fakeRedis.close();
    await fakeMcp.close();
    await fs.rm(folder, { recursive: true, force: true }).catch(() => {});
    await fs.rm(hooksFolder, { recursive: true, force: true }).catch(() => {});
    await fs.rm(tshDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(mcpDir, { recursive: true, force: true }).catch(() => {});
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
