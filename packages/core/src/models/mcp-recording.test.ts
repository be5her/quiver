import { describe, expect, it } from 'vitest';
import { MCP_RECORDING_FORMAT, McpRecorder, mcpAgentLabel, mcpRecordingFileName, type McpAgent, type McpRecordingStatus } from './mcp-recording';

const agent: McpAgent = { name: 'claude-code', version: '2.1.0', userAgent: 'claude-code/2.1.0' };
const workspace = { id: 'w1', name: 'demo', path: '/tmp/demo' };

function recorder(options: ConstructorParameters<typeof McpRecorder>[0] = {}) {
  let tick = 0;
  const changes: McpRecordingStatus[] = [];
  const rec = new McpRecorder({ now: () => `2026-09-30T10:00:0${tick++}.000Z`, onChange: (s) => changes.push(s), ...options });
  const call = (tool: string, args: unknown = {}) => rec.begin({ agent, workspace, tool, arguments: args });
  return { rec, call, changes };
}

describe('McpRecorder', () => {
  it('keeps calls only while recording', () => {
    const { rec, call } = recorder();
    expect(rec.status()).toEqual({ state: 'idle', startedAt: null, endedAt: null, limitReached: false, count: 0, bytes: 0, savedTo: null });
    expect(call('app_info')).toBeNull();

    expect(rec.start()).toMatchObject({ state: 'recording', startedAt: '2026-09-30T10:00:00.000Z' });
    const first = call('app_info');
    rec.pause();
    expect(call('db_query_run')).toBeNull();
    rec.resume();
    const second = call('todo_list');
    expect(rec.end()).toMatchObject({ state: 'ended', count: 2, endedAt: expect.any(String) });
    expect(call('todo_add')).toBeNull();
    expect(rec.list().map((c) => [c.id, c.tool])).toEqual([
      [first, 'app_info'],
      [second, 'todo_list'],
    ]);
  });

  it('completes a call with its result, duration and size', () => {
    const { rec, call } = recorder();
    rec.start();
    const id = call('db_query_run', { query: 'SELECT 1' })!;
    expect(rec.get(id)).toMatchObject({ ok: null, result: null, durationMs: null, arguments: { query: 'SELECT 1' }, agent, workspace });
    expect(rec.list()[0]).toMatchObject({ preview: '{"query":"SELECT 1"}', size: 20 });
    expect(rec.list()[0]).not.toHaveProperty('arguments');

    rec.finish(id, { ok: true, result: { rows: [[1]] }, durationMs: 12.5 });
    expect(rec.get(id)).toMatchObject({ ok: true, result: { rows: [[1]] }, durationMs: 12.5, size: 20 + 14 });
    expect(rec.status().bytes).toBe(34);

    // A second answer for the same call, or one for a call nobody kept, changes nothing.
    rec.finish(id, { ok: false, result: 'late', durationMs: 99 });
    rec.finish('nope', { ok: true, result: 1, durationMs: 1 });
    expect(rec.get(id)?.ok).toBe(true);
    expect(rec.status().bytes).toBe(34);
  });

  it('still completes a running call after pause or end, but not after a new recording started', () => {
    const { rec, call } = recorder();
    rec.start();
    const running = call('teleport_kube_query')!;
    rec.end();
    rec.finish(running, { ok: false, result: { code: 'TIMEOUT' }, durationMs: 3000 });
    expect(rec.get(running)).toMatchObject({ ok: false, result: { code: 'TIMEOUT' } });

    const stale = call('app_info');
    expect(stale).toBeNull();
    rec.start();
    rec.finish(running, { ok: true, result: 'late', durationMs: 1 });
    expect(rec.status().count).toBe(0);
    expect(call('app_info')).not.toBe(running);
  });

  it('starting again or clearing drops the previous recording', () => {
    const { rec, call } = recorder();
    rec.start();
    call('app_info');
    rec.end();
    rec.markSaved('/tmp/out.json');
    expect(rec.status()).toMatchObject({ state: 'ended', count: 1, savedTo: '/tmp/out.json' });
    expect(rec.start()).toMatchObject({ state: 'recording', count: 0, bytes: 0, savedTo: null, endedAt: null });
    call('app_info');
    expect(rec.clear()).toEqual({ state: 'idle', startedAt: null, endedAt: null, limitReached: false, count: 0, bytes: 0, savedTo: null });
  });

  it('ignores transitions that do not apply', () => {
    const { rec, changes } = recorder();
    expect(rec.pause().state).toBe('idle');
    expect(rec.resume().state).toBe('idle');
    expect(rec.end().state).toBe('idle');
    expect(changes).toEqual([]);
    rec.start();
    expect(rec.resume().state).toBe('recording');
    rec.end();
    expect(rec.pause().state).toBe('ended');
  });

  it('ends itself at the call limit and at the size limit, keeping what it has', () => {
    const byCount = recorder({ maxCalls: 2 });
    byCount.rec.start();
    byCount.call('a');
    const last = byCount.call('b')!;
    expect(byCount.rec.status()).toMatchObject({ state: 'ended', limitReached: true, count: 2 });
    expect(byCount.call('c')).toBeNull();
    byCount.rec.finish(last, { ok: true, result: 'done', durationMs: 1 });
    expect(byCount.rec.get(last)?.result).toBe('done');

    const bySize = recorder({ maxBytes: 100 });
    bySize.rec.start();
    const big = bySize.call('a')!;
    expect(bySize.rec.status().state).toBe('recording');
    bySize.rec.finish(big, { ok: true, result: 'x'.repeat(200), durationMs: 1 });
    expect(bySize.rec.status()).toMatchObject({ state: 'ended', limitReached: true, count: 1 });
  });

  it('reports every change', () => {
    const { rec, call, changes } = recorder();
    rec.start();
    const id = call('app_info')!;
    rec.finish(id, { ok: true, result: {}, durationMs: 1 });
    rec.pause();
    rec.resume();
    rec.end();
    expect(changes.map((s) => `${s.state}:${s.count}`)).toEqual(['recording:0', 'recording:1', 'recording:1', 'paused:1', 'recording:1', 'ended:1']);
  });

  it('exports the calls with their bodies', () => {
    const { rec, call } = recorder();
    rec.start();
    const id = call('tools_uuid_generate', { count: 1 })!;
    rec.finish(id, { ok: true, result: ['a-b'], durationMs: 2 });
    rec.end();
    const file = rec.export('0.3.0');
    expect(file).toMatchObject({ format: MCP_RECORDING_FORMAT, version: 1, quiver: '0.3.0', startedAt: '2026-09-30T10:00:00.000Z', endedAt: expect.any(String) });
    expect(file.calls).toEqual([{ id, at: expect.any(String), agent, workspace, tool: 'tools_uuid_generate', arguments: { count: 1 }, ok: true, result: ['a-b'], durationMs: 2, size: 18 }]);
    expect(JSON.parse(JSON.stringify(file))).toEqual(file);
  });

  it('survives arguments that are not JSON', () => {
    const { rec, call } = recorder();
    rec.start();
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    const id = call('odd', loop)!;
    expect(rec.list()[0]).toMatchObject({ preview: '', size: 0 });
    rec.finish(id, { ok: true, result: undefined, durationMs: 1 });
    expect(rec.get(id)).toMatchObject({ ok: true, result: null });
  });
});

describe('helpers', () => {
  it('names the file after the local start time', () => {
    const local = new Date(2026, 8, 30, 14, 32, 5);
    expect(mcpRecordingFileName(local.toISOString())).toBe('quiver-mcp-recording-20260930-143205.json');
    expect(mcpRecordingFileName(null)).toMatch(/^quiver-mcp-recording-\d{8}-\d{6}\.json$/);
  });

  it('labels an agent with its version when it has one', () => {
    expect(mcpAgentLabel(agent)).toBe('claude-code 2.1.0');
    expect(mcpAgentLabel({ name: 'node', version: null, userAgent: 'node' })).toBe('node');
  });
});
