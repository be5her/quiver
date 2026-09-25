import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CommandRegistry, defaultGlobalConfig, type HostApi, type WorkspaceApi } from '@quiver/core';
import { mainModules } from '@quiver/modules/main';
import { describe, expect, it } from 'vitest';
import { buildMcpServer, toolNameFor } from './index';

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

describe('MCP tool surface', () => {
  it('exposes every visible command from every module as a tool', async () => {
    const registry = new CommandRegistry();
    for (const mod of mainModules) registry.registerModule(mod);
    const host = fakeHost();
    const server = buildMcpServer({ registry, host, port: 0, version: 'test', resolveWorkspace: async () => undefined }, undefined);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    const names = new Set(tools.map((t) => t.name));

    const visible = registry.list().filter((c) => !c.hidden);
    const missing = visible.map((c) => toolNameFor(c.id)).filter((n) => !names.has(n));
    expect(missing).toEqual([]);
    expect(names.has('teleport_status')).toBe(true);
    expect(names.has('teleport_login_cancel')).toBe(false);
    expect(names.has('config_update')).toBe(false);

    const status = tools.find((t) => t.name === 'teleport_status')!;
    expect(status.annotations?.readOnlyHint).toBe(true);
    const login = tools.find((t) => t.name === 'teleport_login')!;
    expect(login.annotations?.destructiveHint).toBe(true);
    const query = tools.find((t) => t.name === 'db_query_run')!;
    expect(query.description).toContain('Read-only calls always work');
    await client.close();
    await server.close();
  });
});
