import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defaultGlobalConfig } from './defaults';
import { QuiverError } from './errors';
import { CommandRegistry, defineCommand } from './registry';
import type { CommandContext, HostApi, WorkspaceApi } from './types';

function fakeHost(overrides: Partial<ReturnType<typeof defaultGlobalConfig>['mcp']> = {}): HostApi {
  const config = defaultGlobalConfig();
  config.mcp = { ...config.mcp, ...overrides };
  return {
    version: 'test',
    config: { get: () => config, update: async () => config },
    workspaces: { list: () => [], get: () => undefined, open: async () => ({}) as WorkspaceApi, close: async () => {} },
    secrets: { available: false, encrypt: (s) => s, decrypt: (s) => s },
    emit: () => {},
  };
}

const echo = defineCommand({
  id: 'test.echo',
  title: 'Echo',
  description: 'returns input',
  scope: 'global',
  input: z.object({ text: z.string() }),
  handler: async ({ text }) => ({ text }),
});

const destroy = defineCommand({
  id: 'test.destroy',
  title: 'Destroy',
  description: 'mutates',
  scope: 'workspace',
  mutating: true,
  input: z.object({}),
  handler: async () => 'done',
});

const maybe = defineCommand({
  id: 'test.maybe',
  title: 'Maybe',
  description: 'mutates only when asked',
  scope: 'global',
  mutating: async ({ write }) => write,
  input: z.object({ write: z.boolean() }),
  handler: async ({ write }) => (write ? 'wrote' : 'read'),
});

describe('CommandRegistry', () => {
  const registry = new CommandRegistry();
  registry.registerModule({ id: 'test', commands: [echo, destroy, maybe] });

  it('validates input and runs handlers', async () => {
    const ctx: CommandContext = { caller: 'ui', host: fakeHost() };
    await expect(registry.execute('test.echo', { text: 'hi' }, ctx)).resolves.toEqual({ text: 'hi' });
    await expect(registry.execute('test.echo', { text: 1 }, ctx)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('refuses workspace commands without a workspace', async () => {
    await expect(registry.execute('test.destroy', {}, { caller: 'ui', host: fakeHost() })).rejects.toMatchObject({
      code: 'NO_WORKSPACE',
    });
  });

  it('blocks mutating commands for MCP callers unless allowed', async () => {
    const ws = { id: 'w' } as WorkspaceApi;
    await expect(registry.execute('test.destroy', {}, { caller: 'mcp', host: fakeHost(), workspace: ws })).rejects.toBeInstanceOf(
      QuiverError,
    );
    await expect(
      registry.execute('test.destroy', {}, { caller: 'mcp', host: fakeHost({ allowMutating: true }), workspace: ws }),
    ).resolves.toBe('done');
  });

  it('decides conditional mutations per call', async () => {
    const ctx: CommandContext = { caller: 'mcp', host: fakeHost() };
    await expect(registry.execute('test.maybe', { write: false }, ctx)).resolves.toBe('read');
    await expect(registry.execute('test.maybe', { write: true }, ctx)).rejects.toMatchObject({ code: 'MUTATION_BLOCKED' });
    await expect(registry.execute('test.maybe', { write: true }, { ...ctx, caller: 'ui' })).resolves.toBe('wrote');
    expect(registry.list().find((c) => c.id === 'test.maybe')).toMatchObject({ mutating: true, conditional: true });
  });

  it('lists metadata and rejects duplicates', () => {
    expect(registry.list().map((c) => c.id)).toEqual(['test.echo', 'test.destroy', 'test.maybe']);
    expect(() => registry.register('test', echo)).toThrow(/twice/);
  });
});
