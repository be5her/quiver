import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defaultGlobalConfig } from './defaults';
import { QuiverError } from './errors';
import type { ApprovalOutcome, ApprovalRequest } from './approvals';
import { CommandRegistry, defineCommand, type ExecuteTrace } from './registry';
import { REDACTED } from './redact';
import type { CommandContext, HostApi, WorkspaceApi } from './types';

function fakeHost(overrides: Partial<ReturnType<typeof defaultGlobalConfig>['mcp']> = {}, approve?: (request: ApprovalRequest) => ApprovalOutcome): HostApi {
  const config = defaultGlobalConfig();
  config.mcp = { ...config.mcp, ...overrides };
  return {
    version: 'test',
    config: { get: () => config, update: async () => config },
    workspaces: { list: () => [], get: () => undefined, open: async () => ({}) as WorkspaceApi, close: async () => {} },
    secrets: { available: false, encrypt: (s) => s, decrypt: (s) => s },
    approvals: approve ? { request: async (request) => approve(request) } : undefined,
    emit: () => {},
  };
}

/** A workspace that holds these rules in its project folder (`.quiver/local`), where Quiver must not read them from. */
function workspaceWithRules(rules: unknown): WorkspaceApi {
  return {
    id: 'w',
    name: 'w',
    path: '/w',
    store: { readLocal: async (name: string, fallback: unknown) => (name === 'agent-permissions' ? { rules } : fallback) },
  } as unknown as WorkspaceApi;
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

const secret = defineCommand({
  id: 'test.secret',
  title: 'Secret',
  description: 'takes a password',
  scope: 'global',
  mutating: true,
  input: z.object({ password: z.string() }),
  handler: async () => 'stored',
});

describe('CommandRegistry', () => {
  const registry = new CommandRegistry();
  registry.registerModule({ id: 'test', commands: [echo, destroy, maybe, secret] });

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
    const ws = workspaceWithRules([]);
    await expect(registry.execute('test.destroy', {}, { caller: 'mcp', host: fakeHost(), workspace: ws })).rejects.toBeInstanceOf(
      QuiverError,
    );
    await expect(
      registry.execute('test.destroy', {}, { caller: 'mcp', host: fakeHost({ permissions: { mode: 'allow', rules: [] } }), workspace: ws }),
    ).resolves.toBe('done');
  });

  it('says why an agent was refused', async () => {
    const ws = workspaceWithRules([]);
    const run = (host: HostApi, id = 'test.destroy', input: unknown = {}) =>
      registry.execute(id, input, { caller: 'mcp', host, workspace: ws }).then(
        () => null,
        (err: QuiverError) => ({ code: err.code, reason: (err.details as { reason?: string }).reason }),
      );
    expect(await run(fakeHost())).toEqual({ code: 'MUTATION_BLOCKED', reason: 'read-only' });
    expect(await run(fakeHost({ paused: true }), 'test.echo', { text: 'x' })).toEqual({ code: 'MUTATION_BLOCKED', reason: 'paused' });
    expect(await run(fakeHost({ permissions: { mode: 'allow', rules: [{ match: 'test.*', action: 'deny' }] } }), 'test.echo', { text: 'x' })).toEqual({ code: 'MUTATION_BLOCKED', reason: 'rule' });
    expect(await run(fakeHost({ permissions: { mode: 'ask', rules: [] } }))).toEqual({ code: 'MUTATION_BLOCKED', reason: 'no-approver' });
  });

  it('asks the user, with the agent and masked arguments, and follows the answer', async () => {
    const asked: ApprovalRequest[] = [];
    const answering = (outcome: ApprovalOutcome, permissions: ReturnType<typeof defaultGlobalConfig>['mcp']['permissions'] = { mode: 'ask', rules: [] }) =>
      fakeHost({ permissions }, (request) => {
        asked.push(request);
        return outcome;
      });
    const agent = { name: 'claude-code', version: '2.1.0', userAgent: null };
    const ws = workspaceWithRules([]);
    const approvedTrace: ExecuteTrace = {};
    await expect(registry.execute('test.destroy', {}, { caller: 'mcp', host: answering({ approved: true, how: 'once' }), workspace: ws, agent }, approvedTrace)).resolves.toBe('done');
    expect(approvedTrace.decision).toBe('approved');
    expect(asked[0]).toMatchObject({ agent, commandId: 'test.destroy', title: 'Destroy', mutating: true, workspace: { id: 'w', name: 'w', path: '/w' } });

    const deniedTrace: ExecuteTrace = {};
    await expect(registry.execute('test.destroy', {}, { caller: 'mcp', host: answering({ approved: false, reason: 'denied' }), workspace: ws }, deniedTrace)).rejects.toMatchObject({
      code: 'MUTATION_BLOCKED',
      details: { reason: 'denied' },
    });
    expect(deniedTrace.decision).toBe('denied');
    await expect(registry.execute('test.destroy', {}, { caller: 'mcp', host: answering({ approved: false, reason: 'approval-timeout' }), workspace: ws })).rejects.toMatchObject({
      details: { reason: 'approval-timeout' },
    });

    // A rule can ask about a read-only command too; arguments named like a credential are masked.
    await registry.execute('test.echo', { text: 'x' }, { caller: 'mcp', host: answering({ approved: true, how: 'once' }, { mode: 'allow', rules: [{ match: 'test.echo', action: 'ask' }] }) });
    expect(asked.at(-1)).toMatchObject({ commandId: 'test.echo', mutating: false, input: { text: 'x' }, workspace: null });
    await registry.execute('test.secret', { password: 'hunter22' }, { caller: 'mcp', host: answering({ approved: true, how: 'once' }) });
    expect(asked.at(-1)?.input).toEqual({ password: REDACTED });
  });

  it('applies workspace rules, from the config, before global ones', async () => {
    const permissions = { mode: 'read-only' as const, rules: [{ match: 'test.destroy', action: 'allow' as const }] };
    await expect(registry.execute('test.destroy', {}, { caller: 'mcp', host: fakeHost({ permissions }), workspace: workspaceWithRules([]) })).resolves.toBe('done');
    const denying = fakeHost({ permissions, workspaceRules: { w: [{ match: 'test.*', action: 'deny' }], other: [] } });
    await expect(registry.execute('test.destroy', {}, { caller: 'mcp', host: denying, workspace: workspaceWithRules([]) })).rejects.toMatchObject({
      details: { reason: 'rule', level: 'workspace' },
    });
  });

  it('ignores a rules file in the project folder, which anyone who can commit could have written', async () => {
    const ws = workspaceWithRules([{ match: '*', action: 'allow' }]);
    await expect(registry.execute('test.destroy', {}, { caller: 'mcp', host: fakeHost(), workspace: ws })).rejects.toMatchObject({ details: { reason: 'read-only' } });
  });

  it('passes the caller’s abort signal to the approval, and says when it was paused or cancelled', async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const host = (reason: 'paused' | 'cancelled'): HostApi => ({
      ...fakeHost({ permissions: { mode: 'ask', rules: [] } }),
      approvals: {
        request: async (_request, signal) => {
          signals.push(signal);
          return { approved: false, reason };
        },
      },
    });
    const signal = new AbortController().signal;
    const trace: ExecuteTrace = {};
    await expect(registry.execute('test.destroy', {}, { caller: 'mcp', host: host('cancelled'), workspace: workspaceWithRules([]), signal }, trace)).rejects.toMatchObject({
      details: { reason: 'cancelled' },
    });
    expect(trace.decision).toBe('cancelled');
    expect(signals[0]).toBe(signal);
    await expect(registry.execute('test.destroy', {}, { caller: 'mcp', host: host('paused'), workspace: workspaceWithRules([]) })).rejects.toMatchObject({ details: { reason: 'paused' } });
  });

  it('never gates the UI or the CLI', async () => {
    const host = fakeHost({ paused: true, permissions: { mode: 'read-only', rules: [{ match: '*', action: 'deny' }] } });
    await expect(registry.execute('test.destroy', {}, { caller: 'ui', host, workspace: workspaceWithRules([]) })).resolves.toBe('done');
    await expect(registry.execute('test.destroy', {}, { caller: 'cli', host, workspace: workspaceWithRules([]) })).resolves.toBe('done');
  });

  it('decides conditional mutations per call', async () => {
    const ctx: CommandContext = { caller: 'mcp', host: fakeHost() };
    await expect(registry.execute('test.maybe', { write: false }, ctx)).resolves.toBe('read');
    await expect(registry.execute('test.maybe', { write: true }, ctx)).rejects.toMatchObject({ code: 'MUTATION_BLOCKED' });
    await expect(registry.execute('test.maybe', { write: true }, { ...ctx, caller: 'ui' })).resolves.toBe('wrote');
    expect(registry.list().find((c) => c.id === 'test.maybe')).toMatchObject({ mutating: true, conditional: true });
  });

  it('lists metadata and rejects duplicates', () => {
    expect(registry.list().map((c) => c.id)).toEqual(['test.echo', 'test.destroy', 'test.maybe', 'test.secret']);
    expect(() => registry.register('test', echo)).toThrow(/twice/);
  });
});
