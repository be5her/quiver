import { describe, expect, it } from 'vitest';
import {
  RealtimeConnectionDraftSchema,
  RealtimeConnectionSchema,
  applyAuth,
  createSseParser,
  describeConnection,
  newRealtimeConnection,
  toHttpUrl,
  toWebSocketUrl,
  type SseEvent,
} from './realtime';
import { compact } from './mock';

describe('url helpers', () => {
  it('maps between http and ws schemes and adds a default one', () => {
    expect(toWebSocketUrl('https://api.example.com/socket')).toBe('wss://api.example.com/socket');
    expect(toWebSocketUrl('http://localhost:3000')).toBe('ws://localhost:3000');
    expect(toWebSocketUrl('wss://x.y/z')).toBe('wss://x.y/z');
    expect(toWebSocketUrl(' localhost:8080/ws ')).toBe('ws://localhost:8080/ws');
    expect(toHttpUrl('wss://x.y/events')).toBe('https://x.y/events');
    expect(toHttpUrl('ws://x.y/events')).toBe('http://x.y/events');
    expect(toHttpUrl('http://x.y')).toBe('http://x.y');
    expect(toHttpUrl('x.y/stream')).toBe('http://x.y/stream');
  });
});

describe('applyAuth', () => {
  it('adds bearer, basic and api-key auth without overriding an explicit header', () => {
    expect(applyAuth({ type: 'bearer', token: 't' }, [], 'ws://x')).toEqual({ headers: [['Authorization', 'Bearer t']], url: 'ws://x' });
    expect(applyAuth({ type: 'bearer', token: 't' }, [['authorization', 'custom']], 'ws://x').headers).toEqual([['authorization', 'custom']]);
    expect(applyAuth({ type: 'basic', username: 'u', password: 'p' }, [], 'ws://x').headers).toEqual([['Authorization', 'Basic dTpw']]);
    expect(applyAuth({ type: 'basic', username: 'ü', password: 'p' }, [], 'ws://x').headers[0][1]).toBe(`Basic ${Buffer.from('ü:p', 'utf8').toString('base64')}`);
    expect(applyAuth({ type: 'apikey', key: 'X-Key', value: 'k', in: 'header' }, [], 'ws://x').headers).toEqual([['X-Key', 'k']]);
    expect(applyAuth({ type: 'apikey', key: 'key', value: 'a b', in: 'query' }, [], 'ws://x/p').url).toBe('ws://x/p?key=a%20b');
    expect(applyAuth({ type: 'apikey', key: 'key', value: 'v', in: 'query' }, [], 'ws://x/p?z=1').url).toBe('ws://x/p?z=1&key=v');
    expect(applyAuth({ type: 'none' }, [['A', '1']], 'ws://x')).toEqual({ headers: [['A', '1']], url: 'ws://x' });
  });
});

describe('sse parser', () => {
  const collect = (chunks: string[]): SseEvent[] => {
    const parser = createSseParser();
    return chunks.flatMap((c) => parser.push(c));
  };

  it('dispatches on blank lines with default event name and joined data', () => {
    const events = collect(['data: hello\n\n', 'event: tick\ndata: {"n":1}\nid: 7\n\n', 'data: line one\ndata: line two\n\n']);
    expect(events).toEqual([
      { event: 'message', data: 'hello', id: null, retry: null },
      { event: 'tick', data: '{"n":1}', id: '7', retry: null },
      { event: 'message', data: 'line one\nline two', id: '7', retry: null },
    ]);
  });

  it('handles CRLF, CR, comments, retry, missing values and chunk boundaries', () => {
    const events = collect([': ping\r\n', 'retry: 250\r\nda', 'ta: a\r\ndata\r\n', '\r', '\ndata:b\rdata: c\n\n']);
    expect(events).toEqual([
      { event: 'message', data: 'a\n', id: null, retry: 250 },
      { event: 'message', data: 'b\nc', id: null, retry: null },
    ]);
  });

  it('drops events without data, ignores ids with NUL and remembers the last id', () => {
    const parser = createSseParser();
    expect(parser.push('event: noop\n\n')).toEqual([]);
    expect(parser.push('id: 1\ndata: x\n\n')[0].id).toBe('1');
    expect(parser.lastEventId).toBe('1');
    expect(parser.push('id: bad\0\ndata: y\n\n')[0].id).toBe('1');
    expect(parser.push('id: 2\n\n')).toEqual([]);
    expect(parser.lastEventId).toBe('2');
    expect(parser.retryMs).toBeNull();
    expect(parser.push('retry: 500\n\n')).toEqual([]);
    expect(parser.retryMs).toBe(500);
    expect(parser.push('data: after\n\n')[0].retry).toBeNull();
    expect(parser.retryMs).toBe(500);
    expect(createSseParser().push('﻿data: z\n\n')[0].data).toBe('z');
  });
});

describe('schemas', () => {
  it('fills defaults and keeps drafts free of them', () => {
    const conn = newRealtimeConnection({ name: 'chat', url: 'ws://localhost' });
    expect(conn.kind).toBe('websocket');
    expect(conn.reconnect).toBe(true);
    expect(conn.logLimit).toBe(500);
    expect(conn.auth).toEqual({ type: 'none' });
    expect(RealtimeConnectionSchema.safeParse({ ...conn, logLimit: 1 }).success).toBe(false);
    const draft = RealtimeConnectionDraftSchema.parse({ id: 'c', url: 'wss://x' });
    expect(compact(draft)).toEqual({ id: 'c', url: 'wss://x' });
    expect(RealtimeConnectionSchema.parse({ ...conn, ...compact(draft) })).toMatchObject({ name: 'chat', url: 'wss://x', kind: 'websocket' });
  });

  it('describes a connection by kind and host', () => {
    expect(describeConnection({ kind: 'websocket', url: 'wss://chat.example.com/room?x=1' })).toBe('WS chat.example.com');
    expect(describeConnection({ kind: 'sse', url: 'http://localhost:3000/events' })).toBe('SSE localhost:3000');
    expect(describeConnection({ kind: 'sse', url: '' })).toBe('SSE');
  });
});
