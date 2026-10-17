import { promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { buildSchema, graphql as executeGraphql } from 'graphql';
import type { WebSocket as WsSocket } from 'ws';
import { startFakeGrafana } from './fake-grafana';
import { startFakeMcpHttp, writeFakeMcpStdio } from './fake-mcp';
import { startFakeRedis } from './fake-redis';
import { writeFakeTsh } from './fake-tsh';

export type Fixtures = Awaited<ReturnType<typeof startFixtures>>;

/**
 * The local servers and fake programs the parts talk to. They start together before any part runs (it takes well under
 * a second) so that every part finds them, whichever parts were picked.
 */
export async function startFixtures() {
  const echo = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      // `/slow?ms=N` answers after N milliseconds, for timeouts and cancelling a send.
      const slow = /^\/slow\b.*[?&]ms=(\d+)/.exec(req.url ?? '');
      const answer = () => {
        if (res.destroyed) return;
        res.writeHead(200, { 'content-type': 'application/json', 'x-echo': 'yes' });
        res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body }));
      };
      if (slow) setTimeout(answer, Number(slow[1]));
      else answer();
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
  /** What the GraphQL endpoint saw last. */
  const gqlState = { authSeen: null as string | null, lastMethod: '' };
  const gql = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      void (async () => {
        gqlState.authSeen = req.headers.authorization ?? null;
        gqlState.lastMethod = req.method ?? '';
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
  const fakeGrafana = await startFakeGrafana();
  const tshDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quiver-smoke-tsh-'));
  const fakeTsh = await writeFakeTsh(tshDir, fakeRedis.port);
  // The fake's stand-in for ~/.kube/config: what kubectl in the user's terminal would use.
  const previousKubeconfig = process.env.KUBECONFIG;
  process.env.KUBECONFIG = fakeTsh.homeKubeconfig;
  // MCP servers for the inspector: a stdio script, plus Streamable HTTP and legacy SSE endpoints in process.
  const mcpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quiver-smoke-mcp-'));
  const fakeStdio = await writeFakeMcpStdio(mcpDir);
  const fakeMcp = await startFakeMcpHttp();

  return {
    echoPort,
    gqlPort,
    gqlState,
    ssePort,
    sseSeen,
    wsPort,
    wsSockets,
    fakeRedis,
    fakeGrafana,
    fakeTsh,
    mcpDir,
    fakeStdio,
    fakeMcp,
    async close() {
      echo.close();
      gql.close();
      sse.closeAllConnections();
      sse.close();
      for (const socket of wsSockets) socket.terminate();
      wss.close();
      wsHttp.closeAllConnections();
      wsHttp.close();
      await fakeRedis.close();
      await fakeGrafana.close();
      await fakeMcp.close();
      if (previousKubeconfig === undefined) delete process.env.KUBECONFIG;
      else process.env.KUBECONFIG = previousKubeconfig;
      await fs.rm(tshDir, { recursive: true, force: true }).catch(() => {});
      await fs.rm(mcpDir, { recursive: true, force: true }).catch(() => {});
    },
  };
}
