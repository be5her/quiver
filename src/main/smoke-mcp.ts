import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import path from 'node:path';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { findNode } from './smoke-tsh';

export interface FakeMcpStdio {
  /** Absolute path of the node binary, usable as the server command. */
  node: string;
  script: string;
}

/**
 * A stand-in MCP server over stdio with no dependencies: it answers initialize, ping, tools/list and
 * tools/call, writes to stderr, and can exit on request so the inspector's process handling is covered.
 */
export async function writeFakeMcpStdio(dir: string): Promise<FakeMcpStdio> {
  const script = path.join(dir, 'fake-mcp.cjs');
  await fs.writeFile(script, FAKE_STDIO_SOURCE, 'utf8');
  return { node: findNode(), script };
}

const FAKE_STDIO_SOURCE = String.raw`
const readline = require('node:readline');
process.stderr.write('[fake-mcp] started\n');
const tools = [
  { name: 'env_echo', description: 'Returns SMOKE_MCP_VAR, the working directory and the arguments', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  { name: 'exit', description: 'Exits the server process', inputSchema: { type: 'object', properties: { code: { type: 'integer' } }, required: ['code'] } },
];
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = message;
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'smoke-stdio', version: '0.1.0' } } });
    return;
  }
  if (method === 'notifications/initialized') return;
  if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools } });
  if (method === 'tools/call') {
    if (params.name === 'env_echo') {
      const text = JSON.stringify({ var: process.env.SMOKE_MCP_VAR ?? null, cwd: process.cwd(), argv: process.argv.slice(2) });
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
    }
    if (params.name === 'exit') {
      process.stderr.write('[fake-mcp] exiting\n');
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'bye' }] } });
      setTimeout(() => process.exit((params.arguments && params.arguments.code) || 0), 50);
      return;
    }
    return send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'Unknown tool ' + params.name } });
  }
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } });
});
rl.on('close', () => process.exit(0));
`;

export interface FakeMcpHttp {
  port: number;
  httpUrl: string;
  sseUrl: string;
  /** Authorization header values seen on the Streamable HTTP endpoint. */
  authSeen: string[];
  /** X-Smoke header values seen on the Streamable HTTP endpoint. */
  headersSeen: string[];
  /** Open Streamable HTTP sessions. */
  sessions(): number;
  close(): Promise<void>;
}

/** One McpServer per session: tools with annotations and an output schema, a resource, a template, a prompt, logging. */
function buildFakeServer(): McpServer {
  const server = new McpServer({ name: 'smoke-http', version: '1.2.3' }, { instructions: 'Use echo to test the connection.', capabilities: { logging: {} } });
  let dynamic = false;
  server.registerTool(
    'echo',
    { title: 'Echo', description: 'Returns the text it was given', inputSchema: { text: z.string().describe('What to echo') }, outputSchema: { echoed: z.string() }, annotations: { readOnlyHint: true } },
    async ({ text }) => ({ content: [{ type: 'text', text: `echo:${text}` }], structuredContent: { echoed: text } }),
  );
  server.registerTool('add', { description: 'Adds two numbers', inputSchema: { a: z.number(), b: z.number() } }, async ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }] }));
  server.registerTool('fail', { description: 'Always reports a tool error', inputSchema: {} }, async () => ({ content: [{ type: 'text', text: 'nope' }], isError: true }));
  server.registerTool('notify', { description: 'Sends a log message and registers one more tool', inputSchema: {}, annotations: { readOnlyHint: true } }, async () => {
    await server.sendLoggingMessage({ level: 'info', logger: 'smoke', data: 'hello from the server' });
    if (!dynamic) {
      dynamic = true;
      server.registerTool('dynamic', { description: 'Appeared after notify', inputSchema: {} }, async () => ({ content: [{ type: 'text', text: 'dynamic' }] }));
    }
    return { content: [{ type: 'text', text: 'notified' }] };
  });
  server.registerResource('greeting', 'smoke://greeting', { title: 'Greeting', description: 'A static text resource', mimeType: 'text/plain' }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: 'text/plain', text: 'hello, inspector' }],
  }));
  server.registerResource('user', new ResourceTemplate('smoke://users/{id}', { list: undefined }), { title: 'User', description: 'A user by id', mimeType: 'application/json' }, async (uri, variables) => ({
    contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify({ id: String(variables.id), name: `user ${String(variables.id)}` }) }],
  }));
  server.registerPrompt('summarize', { title: 'Summarize', description: 'Summarize a topic', argsSchema: { topic: z.string().describe('The topic'), tone: z.string().optional().describe('Optional tone') } }, ({ topic, tone }) => ({
    description: `Summary of ${topic}`,
    messages: [{ role: 'user', content: { type: 'text', text: `Summarize ${topic}${tone ? ` in a ${tone} tone` : ''}` } }],
  }));
  return server;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  if (req.method !== 'POST') return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : undefined;
}

/** Streamable HTTP (stateful sessions) on `/mcp` and the legacy SSE transport on `/sse` + `/messages`. */
export async function startFakeMcpHttp(): Promise<FakeMcpHttp> {
  const authSeen: string[] = [];
  const headersSeen: string[] = [];
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const sseSessions = new Map<string, SSEServerTransport>();

  const handle = async (req: IncomingMessage, res: import('node:http').ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/mcp') {
      if (req.headers.authorization && !authSeen.includes(req.headers.authorization)) authSeen.push(req.headers.authorization);
      const smoke = req.headers['x-smoke'];
      if (typeof smoke === 'string' && !headersSeen.includes(smoke)) headersSeen.push(smoke);
      const sessionId = req.headers['mcp-session-id'];
      const existing = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;
      if (existing) {
        await existing.handleRequest(req, res, await readJsonBody(req));
        return;
      }
      if (req.method !== 'POST') {
        res.writeHead(400, { 'content-type': 'text/plain' }).end('no session');
        return;
      }
      const body = await readJsonBody(req);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, transport);
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      await buildFakeServer().connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }
    if (url.pathname === '/sse' && req.method === 'GET') {
      const transport = new SSEServerTransport('/messages', res);
      sseSessions.set(transport.sessionId, transport);
      transport.onclose = () => sseSessions.delete(transport.sessionId);
      await buildFakeServer().connect(transport);
      return;
    }
    if (url.pathname === '/messages' && req.method === 'POST') {
      const transport = sseSessions.get(url.searchParams.get('sessionId') ?? '');
      if (!transport) {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('no session');
        return;
      }
      await transport.handlePostMessage(req, res, await readJsonBody(req));
      return;
    }
    res.writeHead(404).end();
  };

  const httpServer: Server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(String(err));
    });
  });
  await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', () => r()));
  const port = (httpServer.address() as { port: number }).port;

  return {
    port,
    httpUrl: `http://127.0.0.1:${port}/mcp`,
    sseUrl: `http://127.0.0.1:${port}/sse`,
    authSeen,
    headersSeen,
    sessions: () => sessions.size,
    close: async () => {
      for (const t of [...sessions.values(), ...sseSessions.values()]) await t.close().catch(() => undefined);
      httpServer.closeAllConnections();
      await new Promise<void>((r) => httpServer.close(() => r()));
    },
  };
}
