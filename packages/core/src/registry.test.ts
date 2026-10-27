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

/** Refuses calls to a "locked" target whatever the user would answer, so they must never be asked about. */
const guarded = defineCommand({
  id: 'test.guarded',
  title: 'Guarded',
  description: 'refuses locked targets',
  scope: 'global',
  mutating: true,
  input: z.object({ target: z.string() }),
  beforeApproval: async ({ target }) => {
    if (target === 'locked') throw new QuiverError('MUTATION_BLOCKED', 'locked', { reason: 'locked' });
  },
  handler: async ({ target }) => target,
});

describe('CommandRegistry', () => {
  const registry = new CommandRegistry();
  registry.registerModule({ id: 'test', commands: [echo, destroy, maybe, secret, guarded] });

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

  it('runs a command’s beforeApproval check before asking, and refuses without asking when it throws', async () => {
    const asked: ApprovalRequest[] = [];
    const host = (rules: { match: string; action: 'allow' | 'ask' | 'deny' }[] = []) =>
      fakeHost({ permissions: { mode: 'ask', rules } }, (request) => {
        asked.push(request);
        return { approved: true, how: 'once' };
      });
    const trace: ExecuteTrace = {};
    await expect(registry.execute('test.guarded', { target: 'locked' }, { caller: 'mcp', host: host() }, trace)).rejects.toMatchObject({ code: 'MUTATION_BLOCKED', details: { reason: 'locked' } });
    expect(trace.decision).toBe('refused');
    expect(asked).toHaveLength(0);
    await expect(registry.execute('test.guarded', { target: 'open' }, { caller: 'mcp', host: host() })).resolves.toBe('open');
    expect(asked).toHaveLength(1);
    // Only before asking: an allowed call goes straight to the handler, which makes its own checks.
    await expect(registry.execute('test.guarded', { target: 'locked' }, { caller: 'mcp', host: host([{ match: 'test.guarded', action: 'allow' }]) })).resolves.toBe('locked');
    await expect(registry.execute('test.guarded', { target: 'locked' }, { caller: 'ui', host: host() })).resolves.toBe('locked');
    expect(asked).toHaveLength(1);
  });

  it('applies workspace rules, from the config, before global ones', async () => {
    const permissions = { mode: 'read-only' as const, rules: [{ match: 'test.destroy', action: 'allow' as const }] };
    await expect(registry.execute('test.destroy', {}, { caller: 'mcp', host: fakeHost({ permissions }), workspace: workspaceWithRules([]) })).resolves.toBe('done');
    const denying = fakeHost({ permissions, workspaceRules: { w: [{ match: 'test.*', action: 'deny' }], other: [] } });
    await expect(registry.execute('test.destroy', {}, { caller: 'mcp', host: denying, workspace: workspaceWithRules([]) })).rejects.toMatchObject({
      details: { reason: 'rule', level: 'workspace' },
    });
  });

  it('lets a workspace allow reach only workspace commands, while its deny reaches every command', async () => {
    const allowAll = fakeHost({ workspaceRules: { w: [{ match: '*', action: 'allow' }] } });
    await expect(registry.execute('test.destroy', {}, { caller: 'mcp', host: allowAll, workspace: workspaceWithRules([]) })).resolves.toBe('done');
    // test.secret is a global command: the workspace allow does not count, so read-only refuses it.
    await expect(registry.execute('test.secret', { password: 'x' }, { caller: 'mcp', host: allowAll, workspace: workspaceWithRules([]) })).rejects.toMatchObject({
      details: { reason: 'read-only' },
    });
    const denyAll = fakeHost({ permissions: { mode: 'allow', rules: [] }, workspaceRules: { w: [{ match: '*', action: 'deny' }] } });
    await expect(registry.execute('test.secret', { password: 'x' }, { caller: 'mcp', host: denyAll, workspace: workspaceWithRules([]) })).rejects.toMatchObject({
      details: { reason: 'rule', level: 'workspace' },
    });
  });

  it('decides again after the user allows a call, so a pause or a stricter policy set meanwhile wins', async () => {
    const host = fakeHost({ permissions: { mode: 'ask', rules: [] } }, () => {
      host.config.get().mcp.permissions = { mode: 'ask', rules: [{ match: 'test.destroy', action: 'deny' }] };
      return { approved: true, how: 'once' };
    });
    const trace: ExecuteTrace = {};
    await expect(registry.execute('test.destroy', {}, { caller: 'mcp', host, workspace: workspaceWithRules([]) }, trace)).rejects.toMatchObject({ details: { reason: 'rule' } });
    expect(trace.decision).toBe('refused');
    const pausing = fakeHost({ permissions: { mode: 'ask', rules: [] } }, () => {
      pausing.config.get().mcp.paused = true;
      return { approved: true, how: 'once' };
    });
    await expect(registry.execute('test.destroy', {}, { caller: 'mcp', host: pausing, workspace: workspaceWithRules([]) })).rejects.toMatchObject({ details: { reason: 'paused' } });
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
    expect(registry.list().map((c) => c.id)).toEqual(['test.echo', 'test.destroy', 'test.maybe', 'test.secret', 'test.guarded']);
    expect(() => registry.register('test', echo)).toThrow(/twice/);
  });
});

describe('CommandRegistry and command actions', () => {
  const statement = defineCommand({
    id: 'test.sql',
    title: 'Run SQL',
    description: 'runs a statement',
    scope: 'global',
    mutating: ({ sql }) => !sql.startsWith('SELECT'),
    actions: {
      list: ['select', 'ddl', 'other'],
      of: ({ sql }) => {
        if (sql.includes('BOOM')) throw new Error('cannot tell');
        return sql.startsWith('SELECT') ? 'select' : sql.startsWith('CREATE') ? 'ddl' : 'other';
      },
      describe: { ddl: 'schema changes' },
    },
    input: z.object({ sql: z.string() }),
    handler: async ({ sql }) => sql,
  });
  const registry = new CommandRegistry();
  registry.registerModule({ id: 'test', commands: [statement, echo] });
  const agent = { name: 'claude-code', version: '1', userAgent: null };
  type Permissions = ReturnType<typeof defaultGlobalConfig>['mcp']['permissions'];
  const run = (permissions: Permissions, sql: string, trace: ExecuteTrace = {}, approve?: (request: ApprovalRequest) => ApprovalOutcome, name = agent.name) =>
    registry.execute('test.sql', { sql }, { caller: 'mcp', host: fakeHost({ permissions }, approve), agent: { ...agent, name } }, trace);

  it('decides each call with its action, and says which action and rule refused it', async () => {
    const permissions: Permissions = { mode: 'allow', rules: [{ match: 'test.sql#ddl', action: 'deny' }] };
    const trace: ExecuteTrace = {};
    await expect(run(permissions, 'CREATE TABLE t', trace)).rejects.toMatchObject({
      code: 'MUTATION_BLOCKED',
      message: expect.stringContaining('"test.sql" (ddl)'),
      details: { reason: 'rule', action: 'ddl', rule: { match: 'test.sql#ddl', action: 'deny' }, level: 'global' },
    });
    expect(trace).toEqual({ decision: 'refused', action: 'ddl' });
    const allowed: ExecuteTrace = {};
    await expect(run(permissions, 'INSERT 1', allowed)).resolves.toBe('INSERT 1');
    expect(allowed).toEqual({ decision: 'allowed', action: 'other' });
    await expect(run(permissions, 'SELECT 1')).resolves.toBe('SELECT 1');
    await expect(run({ mode: 'read-only', rules: [] }, 'INSERT 1')).rejects.toMatchObject({ details: { reason: 'read-only', action: 'other' } });
  });

  it('asks with the action in the request', async () => {
    const asked: ApprovalRequest[] = [];
    await run({ mode: 'allow', rules: [{ match: 'test.sql#ddl', action: 'ask' }] }, 'CREATE TABLE t', {}, (request) => {
      asked.push(request);
      return { approved: true, how: 'once' };
    });
    await run({ mode: 'allow', rules: [{ match: 'test.sql#ddl', action: 'ask' }] }, 'INSERT 1', {}, (request) => {
      asked.push(request);
      return { approved: true, how: 'once' };
    });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ commandId: 'test.sql', action: 'ddl', agent: { name: 'claude-code' } });
  });

  it('applies a rule for an agent to that agent only', async () => {
    const permissions: Permissions = { mode: 'allow', rules: [{ match: 'test.sql', action: 'deny', agent: 'cursor' }] };
    await expect(run(permissions, 'INSERT 1', {}, undefined, 'claude-code')).resolves.toBe('INSERT 1');
    await expect(run(permissions, 'INSERT 1', {}, undefined, 'cursor')).rejects.toMatchObject({ details: { reason: 'rule', rule: { agent: 'cursor' } } });
  });

  it('applies only the command-level rules when the action cannot be told, and logs that once', async () => {
    const warn = console.warn;
    const warned: unknown[] = [];
    console.warn = (...args: unknown[]) => void warned.push(args);
    try {
      const trace: ExecuteTrace = {};
      // The action rule cannot match a call without an action; the command rule does.
      await expect(run({ mode: 'allow', rules: [{ match: 'test.sql#other', action: 'deny' }] }, 'BOOM', trace)).resolves.toBe('BOOM');
      expect(trace).toEqual({ decision: 'allowed' });
      await expect(run({ mode: 'allow', rules: [{ match: 'test.sql', action: 'deny' }] }, 'BOOM')).rejects.toMatchObject({ details: { reason: 'rule' } });
      // Never the default for reads: a call its own mutating calls a read gets the mode, as it may be any action.
      await expect(run({ mode: 'read-only', rules: [] }, 'SELECT BOOM')).rejects.toMatchObject({ details: { reason: 'read-only' } });
      await expect(run({ mode: 'read-only', rules: [] }, 'SELECT 1')).resolves.toBe('SELECT 1');
      expect(warned).toHaveLength(1);
    } finally {
      console.warn = warn;
    }
  });

  it('lists the commands that declare actions', () => {
    expect(registry.listActions()).toEqual([{ commandId: 'test.sql', actions: ['select', 'ddl', 'other'], describe: { ddl: 'schema changes' } }]);
  });
});
