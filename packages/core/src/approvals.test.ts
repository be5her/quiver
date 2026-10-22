import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentApprovals, maskArguments, type ApprovalRequest } from './approvals';
import { REDACTED } from './redact';

const request = (agent: string, commandId: string): ApprovalRequest => ({
  agent: { name: agent, version: '1', userAgent: null },
  workspace: null,
  commandId,
  title: commandId,
  input: {},
  mutating: true,
});

afterEach(() => {
  vi.useRealTimers();
});

describe('AgentApprovals', () => {
  it('waits for the answer and lists what waits, oldest first', async () => {
    const changes: number[] = [];
    const requested: string[] = [];
    const approvals = new AgentApprovals({ onChange: (p) => changes.push(p.length), onRequest: (p) => requested.push(p.commandId) });
    const first = approvals.request(request('claude', 'todo.remove'));
    const second = approvals.request(request('claude', 'git.push'));
    expect(approvals.list().map((p) => p.commandId)).toEqual(['todo.remove', 'git.push']);
    expect(requested).toEqual(['todo.remove', 'git.push']);
    const [a, b] = approvals.list();
    approvals.respond(a.id, 'once');
    approvals.respond(b.id, 'deny');
    await expect(first).resolves.toEqual({ approved: true, how: 'once' });
    await expect(second).resolves.toEqual({ approved: false, reason: 'denied' });
    expect(approvals.list()).toEqual([]);
    expect(changes).toEqual([1, 2, 1, 0]);
    expect(() => approvals.respond(a.id, 'once')).toThrow(/No approval/);
  });

  it('refuses a call nobody answers in time', async () => {
    vi.useFakeTimers();
    const approvals = new AgentApprovals({ timeoutMs: 1000 });
    const call = approvals.request(request('claude', 'todo.remove'));
    expect(approvals.list()[0].expiresAt).toBe(new Date(Date.parse(approvals.list()[0].at) + 1000).toISOString());
    vi.advanceTimersByTime(1001);
    await expect(call).resolves.toEqual({ approved: false, reason: 'approval-timeout' });
    expect(approvals.list()).toEqual([]);
  });

  it('remembers a tool allowed for the session per agent, and lets that agent’s waiting calls through', async () => {
    const approvals = new AgentApprovals();
    const one = approvals.request(request('claude', 'todo.remove'));
    const two = approvals.request(request('claude', 'todo.remove'));
    const other = approvals.request(request('cursor', 'todo.remove'));
    approvals.respond(approvals.list()[0].id, 'session');
    await expect(one).resolves.toEqual({ approved: true, how: 'session' });
    await expect(two).resolves.toEqual({ approved: true, how: 'session' });
    expect(approvals.list().map((p) => p.agent.name)).toEqual(['cursor']);
    await expect(approvals.request(request('claude', 'todo.remove'))).resolves.toEqual({ approved: true, how: 'granted' });
    expect(approvals.isGranted('claude', 'todo.remove')).toBe(true);
    expect(approvals.isGranted('claude', 'git.push')).toBe(false);
    expect(approvals.grants()).toEqual([{ agent: 'claude', commandId: 'todo.remove' }]);
    approvals.respond(approvals.list()[0].id, 'deny');
    await expect(other).resolves.toMatchObject({ approved: false });
    approvals.clearGrants();
    expect(approvals.isGranted('claude', 'todo.remove')).toBe(false);
  });

  it('lets every agent’s waiting calls to the tool through when it is allowed for good', async () => {
    const approvals = new AgentApprovals();
    const one = approvals.request(request('claude', 'todo.remove'));
    const other = approvals.request(request('cursor', 'todo.remove'));
    const unrelated = approvals.request(request('cursor', 'git.push'));
    approvals.respond(approvals.list()[0].id, 'always');
    await expect(one).resolves.toEqual({ approved: true, how: 'always' });
    await expect(other).resolves.toEqual({ approved: true, how: 'always' });
    expect(approvals.list().map((p) => p.commandId)).toEqual(['git.push']);
    // Allowing for good writes a rule; it is not a session grant.
    expect(approvals.isGranted('claude', 'todo.remove')).toBe(false);
    approvals.respond(approvals.list()[0].id, 'deny');
    await unrelated;
  });
});

describe('maskArguments', () => {
  it('masks credentials by name, in rows and in URLs, and leaves the rest', () => {
    const masked = maskArguments({
      token: 'eyJhbGciOi',
      key: 'shared-secret',
      title: 'hello',
      count: 3,
      connection: { host: 'db', password: 'hunter22', url: 'postgres://me:hunter22@db/app?sslmode=require' },
      headers: [
        { key: 'Authorization', value: 'Bearer abcdef' },
        { key: 'Accept', value: 'application/json' },
      ],
      variables: [{ key: 'region', value: 'eu', secret: true }],
      link: 'https://example.com/x?api_key=abc123&page=2',
      auth: { type: 'bearer', token: '{{token}}' },
    }) as Record<string, any>;
    expect(masked.token).toBe(REDACTED);
    expect(masked.key).toBe(REDACTED);
    expect(masked.title).toBe('hello');
    expect(masked.count).toBe(3);
    expect(masked.connection.password).toBe(REDACTED);
    expect(masked.connection.url).toBe(`postgres://me:${REDACTED}@db/app?sslmode=require`);
    expect(masked.headers[0]).toEqual({ key: 'Authorization', value: REDACTED });
    expect(masked.headers[1]).toEqual({ key: 'Accept', value: 'application/json' });
    expect(masked.variables[0].value).toBe(REDACTED);
    expect(masked.link).toBe(`https://example.com/x?api_key=${REDACTED}&page=2`);
    // A {{variable}} names a secret rather than holding one.
    expect(masked.auth).toEqual({ type: 'bearer', token: '{{token}}' });
  });

  it('cuts very long strings', () => {
    const masked = maskArguments({ body: 'x'.repeat(5000) }) as { body: string };
    expect(masked.body.length).toBeLessThan(4100);
    expect(masked.body).toContain('1000 more characters');
  });
});
