import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { toErrorPayload, type CommandRegistry, type HostApi, type WorkspaceApi } from '@quiver/core';
import { z } from 'zod';

export interface McpServerOptions {
  registry: CommandRegistry;
  host: HostApi;
  port: number;
  version: string;
  /** Map the `workspace` query parameter (a path or id) or the default choice to a session. */
  resolveWorkspace(hint: string | null): Promise<WorkspaceApi | undefined>;
  onCall?(entry: { tool: string; workspaceId?: string; ok: boolean; durationMs: number; at: string }): void;
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
      const server = buildMcpServer(opts, workspace);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, await readJsonBody(req));
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
