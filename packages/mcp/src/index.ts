import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { toErrorPayload, type CommandRegistry, type HostApi, type McpAgent, type WorkspaceApi, type WorkspaceInfo } from '@quiver/core';
import { z } from 'zod';
import { SESSION_HEADER, identifyAgent, rpcMessages, toolCallOutcome, type RpcMessage } from './agent';

/** Sees every tools/call request that reaches the server and what it answered, e.g. a recorder. */
export interface McpCallObserver {
  /** Returns an id to finish the call with, or null when the call is of no interest. */
  begin(call: { agent: McpAgent; workspace: WorkspaceInfo | null; tool: string; arguments: unknown }): string | null;
  finish(id: string, outcome: { ok: boolean; result: unknown; durationMs: number }): void;
}

export interface McpServerOptions {
  registry: CommandRegistry;
  host: HostApi;
  port: number;
  version: string;
  /** Map the `workspace` query parameter (a path or id) or the default choice to a session. */
  resolveWorkspace(hint: string | null): Promise<WorkspaceApi | undefined>;
  onCall?(entry: { tool: string; workspaceId?: string; ok: boolean; durationMs: number; at: string }): void;
  calls?: McpCallObserver;
}

export interface RunningMcpServer {
  port: number;
  url: string;
  close(): Promise<void>;
}

export const MCP_PATH = '/mcp';

export function toolNameFor(commandId: string): string {
  return commandId.replace(/[^A-Za-z0-9_-]/g, '_');
}

/**
 * Build a fresh McpServer bound to one workspace. Servers are cheap, so the HTTP layer
 * creates one per request (stateless mode) which sidesteps session bookkeeping entirely.
 */
export function buildMcpServer(opts: McpServerOptions, workspace: WorkspaceApi | undefined): McpServer {
  const server = new McpServer({ name: 'quiver', version: opts.version });

  server.registerTool(
    'workspace_current',
    {
      title: 'Current workspace',
      description: 'Returns the workspace this MCP session is bound to. Pass ?workspace=<path> on the MCP URL to choose one.',
      inputSchema: z.object({}),
    },
    async () => text({ workspace: workspace ? { id: workspace.id, name: workspace.name, path: workspace.path } : null, open: opts.host.workspaces.list() }),
  );

  for (const meta of opts.registry.list()) {
    if (meta.hidden) continue;
    const entry = opts.registry.get(meta.id);
    if (!entry) continue;
    const description = [
      meta.description,
      meta.scope === 'workspace' ? 'Runs against the bound workspace.' : '',
      meta.conditional
        ? 'Read-only calls always work; calls that change data need "allow mutations" in Quiver settings.'
        : meta.mutating
          ? 'Mutating: requires "allow mutations" in Quiver settings.'
          : '',
    ]
      .filter(Boolean)
      .join(' ');

    server.registerTool(
      toolNameFor(meta.id),
      {
        title: meta.title,
        description,
        inputSchema: entry.command.input,
        annotations: { readOnlyHint: !meta.mutating, destructiveHint: meta.mutating && !meta.conditional, openWorldHint: meta.id.startsWith('api.request.send') },
      },
      async (args: unknown) => {
        const started = performance.now();
        const at = new Date().toISOString();
        try {
          const result = await opts.registry.execute(meta.id, args, { caller: 'mcp', host: opts.host, workspace });
          opts.onCall?.({ tool: meta.id, workspaceId: workspace?.id, ok: true, durationMs: performance.now() - started, at });
          return text(result);
        } catch (err) {
          opts.onCall?.({ tool: meta.id, workspaceId: workspace?.id, ok: false, durationMs: performance.now() - started, at });
          const payload = toErrorPayload(err);
          return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], isError: true };
        }
      },
    );
  }

  return server;
}

function text(value: unknown) {
  return { content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2) }] };
}

/**
 * Reports the tools/call requests of one HTTP request to the observer, and their responses as the
 * transport sends them. The returned function closes whatever is still unanswered when the connection ends.
 */
function observeCalls(observer: McpCallObserver, messages: RpcMessage[], agent: McpAgent, workspace: WorkspaceApi | undefined, transport: StreamableHTTPServerTransport): () => void {
  const pending = new Map<string | number, { id: string; started: number }>();
  for (const message of messages) {
    if (message.method !== 'tools/call' || message.id === undefined || message.id === null) continue;
    const id = observer.begin({
      agent,
      workspace: workspace ? { id: workspace.id, name: workspace.name, path: workspace.path } : null,
      tool: String(message.params?.name ?? ''),
      arguments: message.params?.arguments ?? {},
    });
    if (id) pending.set(message.id, { id, started: performance.now() });
  }
  if (pending.size === 0) return () => {};
  const send = transport.send.bind(transport);
  transport.send = (message, options) => {
    const reply = message as RpcMessage;
    const key = reply.method === undefined ? reply.id : undefined;
    const call = key !== undefined && key !== null ? pending.get(key) : undefined;
    if (call) {
      pending.delete(key!);
      observer.finish(call.id, { ...toolCallOutcome(reply), durationMs: performance.now() - call.started });
    }
    return send(message, options);
  };
  return () => {
    for (const call of pending.values()) observer.finish(call.id, { ok: false, result: { error: 'The connection closed before the call was answered.' }, durationMs: performance.now() - call.started });
    pending.clear();
  };
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : undefined;
}

export async function startMcpServer(opts: McpServerOptions): Promise<RunningMcpServer> {
  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${opts.port}`);
    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, name: 'quiver', version: opts.version }));
      return;
    }
    if (url.pathname !== MCP_PATH) {
      res.writeHead(404).end('Not found');
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' }).end('Quiver MCP runs in stateless mode: send POST requests only.');
      return;
    }
    try {
      const workspace = await opts.resolveWorkspace(url.searchParams.get('workspace'));
      const body = await readJsonBody(req);
      const messages = rpcMessages(body);
      // No session is kept: the id only tells later requests which client this is, for whoever observes the calls.
      const { agent, sessionId } = identifyAgent(req.headers, messages);
      if (sessionId) res.setHeader(SESSION_HEADER, sessionId);
      const server = buildMcpServer(opts, workspace);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      const closeCalls = opts.calls ? observeCalls(opts.calls, messages, agent, workspace, transport) : undefined;
      res.on('close', () => {
        closeCalls?.();
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: toErrorPayload(err) }));
      }
    }
  };

  const httpServer: Server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(opts.port, '127.0.0.1', () => {
      httpServer.off('error', reject);
      resolve();
    });
  });

  return {
    port: opts.port,
    url: `http://127.0.0.1:${opts.port}${MCP_PATH}`,
    close: () =>
      new Promise<void>((resolve) => {
        httpServer.closeAllConnections?.();
        httpServer.close(() => resolve());
      }),
  };
}
