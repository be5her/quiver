import { createServer } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CommandRegistry, defaultGlobalConfig, defineCommand, type AgentPermissionRule, type CommandContext, type GlobalConfig, type HostApi, type WorkspaceApi } from '@quiver/core';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildMcpServer, startMcpServer, type McpCallEntry, type McpSession, type RunningMcpServer } from './index';

function fakeHost(mcp: Partial<GlobalConfig['mcp']> = {}): HostApi {
  const config = defaultGlobalConfig();
  config.mcp = { ...config.mcp, ...mcp };
  return {
    version: 'test',
    config: { get: () => config, update: async () => config },
    workspaces: { list: () => [], get: () => undefined, open: async () => ({}) as WorkspaceApi, close: async () => {} },
    secrets: { available: false, encrypt: (s) => s, decrypt: (s) => s },
    emit: () => {},
  };
}

const seen: CommandContext[] = [];

function registry(): CommandRegistry {
  const r = new CommandRegistry();
  const handler = async (_input: unknown, ctx: CommandContext) => {
    seen.push(ctx);
    return 'ok';
  };
  r.registerModule({
    id: 'test',
    commands: [
      defineCommand({ id: 'test.read', title: 'Read', description: 'Reads.', scope: 'global', input: z.object({}), handler }),
      defineCommand({ id: 'test.write', title: 'Write', description: 'Writes.', scope: 'global', mutating: true, input: z.object({}), handler }),
      defineCommand({ id: 'test.maybe', title: 'Maybe', description: 'Sometimes writes.', scope: 'global', mutating: () => false, input: z.object({}), handler }),
      defineCommand({ id: 'other.read', title: 'Other', description: 'Reads elsewhere.', scope: 'global', input: z.object({}), handler }),
    ],
  });
  return r;
}

async function tools(host: HostApi, session: McpSession = {}) {
  const server = buildMcpServer({ registry: registry(), host, port: 0, version: 'test', resolveWorkspace: async () => undefined }, undefined, session);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientTransport);
  const { tools: list } = await client.listTools();
  await client.close();
  await server.close();
  return Object.fromEntries(list.map((t) => [t.name, t.description ?? '']));
}

describe('MCP tools and agent permissions', () => {
  it('describes what each tool gets under the mode', async () => {
    const readOnly = await tools(fakeHost());
    expect(readOnly.test_read).toBe('Reads.');
    expect(readOnly.test_write).toContain('Mutating: refused until the user allows it');
    expect(readOnly.test_maybe).toContain('Read-only calls always work; calls that change data are refused');
    const ask = await tools(fakeHost({ permissions: { mode: 'ask', rules: [] } }));
    expect(ask.test_write).toContain('Mutating: asks the user first.');
    expect(ask.test_maybe).toContain('calls that change data ask the user first');
    const allow = await tools(fakeHost({ permissions: { mode: 'allow', rules: [{ match: 'test.read', action: 'ask' }] } }));
    expect(allow.test_write).toContain('Mutating.');
    expect(allow.test_read).toContain('Asks the user first.');
  });

  it('leaves out the tools a deny rule refuses, globally or for the workspace, but not those the mode refuses', async () => {
    const rules: AgentPermissionRule[] = [{ match: 'test.write', action: 'deny' }];
    const globalDeny = await tools(fakeHost({ permissions: { mode: 'read-only', rules } }));
    expect(Object.keys(globalDeny).sort()).toEqual(['other_read', 'test_maybe', 'test_read', 'workspace_current']);
    const workspaceDeny = await tools(fakeHost(), { workspaceRules: [{ match: 'test.*', action: 'deny' }] });
    expect(Object.keys(workspaceDeny).sort()).toEqual(['other_read', 'workspace_current']);
    const readOnly = await tools(fakeHost());
    expect(Object.keys(readOnly)).toContain('test_write');
  });

  it('keeps the tool list while paused', async () => {
    expect(Object.keys(await tools(fakeHost({ paused: true })))).toHaveLength(5);
  });
});

describe('MCP calls and agent permissions over HTTP', () => {
  let running: RunningMcpServer | undefined;
  afterEach(async () => {
    await running?.close();
    running = undefined;
    seen.length = 0;
  });

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

  async function start(host: HostApi, rules: AgentPermissionRule[] = []) {
    const calls: McpCallEntry[] = [];
    const workspace = {
      id: 'w1',
      name: 'demo',
      path: '/tmp/demo',
      store: { readLocal: async (name: string, fallback: unknown) => (name === 'agent-permissions' ? { rules } : fallback) },
    } as unknown as WorkspaceApi;
    running = await startMcpServer({ registry: registry(), host, port: await freePort(), version: 'test', resolveWorkspace: async () => workspace, onCall: (entry) => void calls.push(entry) });
    const client = new Client({ name: 'claude-code', version: '2.1.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(running.url)));
    return { client, calls };
  }

  const errorOf = (result: Awaited<ReturnType<Client['callTool']>>) => JSON.parse((result.content as { text: string }[])[0].text) as { code: string; details?: { reason?: string } };

  it('hands the agent to the command and reports the decision', async () => {
    const { client, calls } = await start(fakeHost());
    await client.callTool({ name: 'test_read', arguments: {} });
    expect(seen[0].agent).toMatchObject({ name: 'claude-code', version: '2.1.0' });
    const refused = await client.callTool({ name: 'test_write', arguments: {} });
    expect(refused.isError).toBe(true);
    expect(errorOf(refused)).toMatchObject({ code: 'MUTATION_BLOCKED', details: { reason: 'read-only' } });
    expect(calls.map((c) => [c.tool, c.ok, c.decision, c.agent.name, c.workspaceId])).toEqual([
      ['test.read', true, 'allowed', 'claude-code', 'w1'],
      ['test.write', false, 'refused', 'claude-code', 'w1'],
    ]);
    await client.close();
  });

  it('applies the workspace rules to the list and to calls', async () => {
    const { client } = await start(fakeHost({ permissions: { mode: 'allow', rules: [] } }), [{ match: 'other.*', action: 'deny' }]);
    const { tools: list } = await client.listTools();
    expect(list.map((t) => t.name)).not.toContain('other_read');
    const refused = await client.callTool({ name: 'other_read', arguments: {} });
    expect(refused.isError).toBe(true);
    await client.close();
  });

  it('refuses every call while paused, the workspace tool included', async () => {
    const { client, calls } = await start(fakeHost({ paused: true }));
    expect(errorOf(await client.callTool({ name: 'test_read', arguments: {} }))).toMatchObject({ details: { reason: 'paused' } });
    expect(errorOf(await client.callTool({ name: 'workspace_current', arguments: {} }))).toMatchObject({ details: { reason: 'paused' } });
    expect(calls[0]).toMatchObject({ decision: 'paused', ok: false });
    expect(seen).toEqual([]);
    await client.close();
  });
});
