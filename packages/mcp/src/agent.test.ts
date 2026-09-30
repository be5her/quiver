import { describe, expect, it } from 'vitest';
import { agentFromUserAgent, decodeAgentSession, encodeAgentSession, identifyAgent, rpcMessages, toolCallOutcome } from './agent';

describe('agent sessions', () => {
  it('carry the client name and version in a header-safe id', () => {
    const id = encodeAgentSession({ name: 'claude-code', version: '2.1.0' });
    expect(id).toMatch(/^quiver\.[A-Za-z0-9_-]+\.[0-9a-f]{32}$/);
    expect(decodeAgentSession(id)).toEqual({ name: 'claude-code', version: '2.1.0' });
    expect(encodeAgentSession({ name: 'claude-code', version: '2.1.0' })).not.toBe(id);
  });

  it('keep names that are not ASCII and cut overlong ones', () => {
    expect(decodeAgentSession(encodeAgentSession({ name: 'agént ✓', version: null }))).toEqual({ name: 'agént ✓', version: null });
    expect(decodeAgentSession(encodeAgentSession({ name: 'x'.repeat(500), version: '1' }))?.name).toHaveLength(100);
  });

  it('reject ids that are not theirs', () => {
    expect(decodeAgentSession('')).toBeNull();
    expect(decodeAgentSession('3f2c9a4e-uuid')).toBeNull();
    expect(decodeAgentSession('quiver.not-json.abc')).toBeNull();
    expect(decodeAgentSession(`quiver.${Buffer.from('[42]').toString('base64url')}.abc`)).toBeNull();
  });
});

describe('agentFromUserAgent', () => {
  it('reads the first product and its version', () => {
    expect(agentFromUserAgent('claude-code/2.1.0 (cli)')).toEqual({ name: 'claude-code', version: '2.1.0', userAgent: 'claude-code/2.1.0 (cli)' });
    expect(agentFromUserAgent('node')).toEqual({ name: 'node', version: null, userAgent: 'node' });
    expect(agentFromUserAgent(undefined)).toEqual({ name: 'unknown', version: null, userAgent: null });
  });
});

describe('identifyAgent', () => {
  const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'cursor', version: '3.0' } } };
  const call = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'app_info' } };

  it('takes the client info of an initialize request and hands out a session for it', () => {
    const { agent, sessionId } = identifyAgent({ 'user-agent': 'node' }, rpcMessages(init));
    expect(agent).toEqual({ name: 'cursor', version: '3.0', userAgent: 'node' });
    expect(decodeAgentSession(sessionId!)).toEqual({ name: 'cursor', version: '3.0' });
  });

  it('recognises the session on later requests, in a batch too', () => {
    const { sessionId } = identifyAgent({}, rpcMessages(init));
    const later = identifyAgent({ 'mcp-session-id': sessionId!, 'user-agent': 'node' }, rpcMessages([call, call]));
    expect(later).toEqual({ agent: { name: 'cursor', version: '3.0', userAgent: 'node' }, sessionId: null });
  });

  it('falls back to the User-Agent without a session or with a foreign one', () => {
    expect(identifyAgent({ 'user-agent': 'my-agent/1.0' }, rpcMessages(call)).agent.name).toBe('my-agent');
    expect(identifyAgent({ 'mcp-session-id': 'someone-elses', 'user-agent': 'my-agent/1.0' }, rpcMessages(call)).agent.name).toBe('my-agent');
    expect(identifyAgent({}, rpcMessages(null)).agent.name).toBe('unknown');
  });
});

describe('toolCallOutcome', () => {
  const text = (value: string, isError?: boolean) => ({ id: 1, result: { content: [{ type: 'text', text: value }], isError } });

  it('gives a JSON text block back as its value', () => {
    expect(toolCallOutcome(text('{"rows":[1,2]}'))).toEqual({ ok: true, result: { rows: [1, 2] } });
    expect(toolCallOutcome(text('plain words'))).toEqual({ ok: true, result: 'plain words' });
  });

  it('marks tool errors and JSON-RPC errors as failed', () => {
    expect(toolCallOutcome(text('{"code":"MUTATION_BLOCKED"}', true))).toEqual({ ok: false, result: { code: 'MUTATION_BLOCKED' } });
    expect(toolCallOutcome({ id: 1, error: { code: -32602, message: 'Tool nope not found' } })).toEqual({ ok: false, result: { code: -32602, message: 'Tool nope not found' } });
  });

  it('keeps other content as it was sent', () => {
    const content = [
      { type: 'text', text: 'a' },
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
    ];
    expect(toolCallOutcome({ id: 1, result: { content } })).toEqual({ ok: true, result: content });
    expect(toolCallOutcome({ id: 1, result: {} })).toEqual({ ok: true, result: {} });
  });
});
