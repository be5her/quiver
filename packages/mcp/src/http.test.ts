import { createServer } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CommandRegistry, QuiverError, defaultGlobalConfig, defineCommand, type HostApi, type WorkspaceApi } from '@quiver/core';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { startMcpServer, type McpCallObserver, type RunningMcpServer } from './index';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

function fakeHost(): HostApi {
  const config = defaultGlobalConfig();
  return {
    version: 'test',
    config: { get: () => config, update: async () => config },
    workspaces: { list: () => [], get: () => undefined, open: async () => ({}) as WorkspaceApi, close: async () => {} },
    secrets: { available: false, encrypt: (s) => s, decrypt: (s) => s },
    emit: () => {},
  };
}

type Begun = Parameters<McpCallObserver['begin']>[0];
type Finished = Parameters<McpCallObserver['finish']>[1];

describe('MCP server over HTTP', () => {
  let running: RunningMcpServer | undefined;
  afterEach(async () => {
    await running?.close();
    running = undefined;
  });

  async function start() {
    const registry = new CommandRegistry();
    registry.registerModule({
      id: 'test',
      commands: [
        defineCommand({ id: 'test.add', title: 'Add', description: 'Adds two numbers.', scope: 'global', input: z.object({ a: z.number(), b: z.number() }), handler: async ({ a, b }) => ({ sum: a + b }) }),
        defineCommand({
          id: 'test.fail',
          title: 'Fail',
          description: 'Always fails.',
          scope: 'global',
          input: z.object({}),
          handler: async () => {
            throw new QuiverError('NOT_FOUND', 'nothing here');
          },
        }),
      ],
    });
    const begun: Begun[] = [];
    const finished: Finished[] = [];
    const workspace = { id: 'w1', name: 'demo', path: '/tmp/demo' } as WorkspaceApi;
    running = await startMcpServer({
      registry,
      host: fakeHost(),
      port: await freePort(),
      version: 'test',
      resolveWorkspace: async (hint) => (hint ? workspace : undefined),
      calls: {
        begin: (call) => {
          begun.push(call);
          return String(begun.length);
        },
        finish: (_id, outcome) => void finished.push(outcome),
      },
    });
    return { url: running.url, begun, finished };
  }

  it('tells the observer who called which tool, and what it answered', async () => {
    const { url, begun, finished } = await start();
    const client = new Client({ name: 'test-agent', version: '1.2.3' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${url}?workspace=demo`)));

    const sum = await client.callTool({ name: 'test_add', arguments: { a: 2, b: 3 } });
    expect(JSON.parse((sum.content as { text: string }[])[0].text)).toEqual({ sum: 5 });
    expect(begun).toEqual([{ agent: { name: 'test-agent', version: '1.2.3', userAgent: expect.any(String) }, workspace: { id: 'w1', name: 'demo', path: '/tmp/demo' }, tool: 'test_add', arguments: { a: 2, b: 3 } }]);
    expect(finished).toEqual([{ ok: true, result: { sum: 5 }, durationMs: expect.any(Number) }]);

    await client.callTool({ name: 'test_fail', arguments: {} });
    expect(finished[1]).toMatchObject({ ok: false, result: { code: 'NOT_FOUND', message: 'nothing here' } });

    // Calls that never reach a handler are reported as well: invalid arguments and tools that do not exist.
    await client.callTool({ name: 'test_add', arguments: { a: 'x' } }).catch(() => undefined);
    await client.callTool({ name: 'test_nope', arguments: {} }).catch(() => undefined);
    expect(begun.map((c) => c.tool)).toEqual(['test_add', 'test_fail', 'test_add', 'test_nope']);
    expect(finished.map((f) => f.ok)).toEqual([true, false, false, false]);
    expect(begun.every((c) => c.agent.name === 'test-agent')).toBe(true);
    await client.close();
  });

  it('names a client that skips the handshake after its User-Agent, without a workspace', async () => {
    const { url, begun, finished } = await start();
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'user-agent': 'curl-agent/8.0' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'test_add', arguments: { a: 1, b: 1 } } }),
    });
    expect(res.headers.get('mcp-session-id')).toBeNull();
    expect(((await res.json()) as { id: number }).id).toBe(7);
    expect(begun[0]).toMatchObject({ agent: { name: 'curl-agent', version: '8.0' }, workspace: null });
    expect(finished[0]).toMatchObject({ ok: true, result: { sum: 2 } });
  });

  it('observes nothing but tool calls', async () => {
    const { url, begun } = await start();
    const client = new Client({ name: 'test-agent', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    await client.listTools();
    await client.ping();
    expect(begun).toEqual([]);
    await client.close();
  });
});
