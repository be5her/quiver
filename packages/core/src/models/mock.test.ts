import { describe, expect, it } from 'vitest';
import {
  MockRouteDraftSchema,
  MockRouteSchema,
  MockServerDraftSchema,
  MockServerSchema,
  capturedToCurl,
  compact,
  findRoute,
  forwardUrl,
  inferContentType,
  matchPath,
  methodMatches,
  newMockRoute,
  newMockServer,
  normalizePath,
  parseQuery,
  renderResponse,
  replayUrl,
  replayableHeaders,
  requestVariables,
  type MockCapturedRequest,
} from './mock';

describe('normalizePath', () => {
  it('strips query, hash, duplicate and trailing slashes', () => {
    expect(normalizePath('/users/1/?x=1#top')).toBe('/users/1');
    expect(normalizePath('users//1')).toBe('/users/1');
    expect(normalizePath('/')).toBe('/');
    expect(normalizePath('')).toBe('/');
  });
});

describe('matchPath', () => {
  it('matches literal paths exactly', () => {
    expect(matchPath('/users', '/users')).toEqual({});
    expect(matchPath('/users', '/users/')).toEqual({});
    expect(matchPath('/users', '/users/1')).toBeNull();
    expect(matchPath('/users/1', '/users')).toBeNull();
    expect(matchPath('/', '/')).toEqual({});
    expect(matchPath('/', '/x')).toBeNull();
  });

  it('captures named segments and decodes them', () => {
    expect(matchPath('/users/:id', '/users/42')).toEqual({ id: '42' });
    expect(matchPath('/users/:id/posts/:post', '/users/42/posts/hello%20world')).toEqual({ id: '42', post: 'hello world' });
    expect(matchPath('/users/:id', '/users')).toBeNull();
    expect(matchPath('/users/:id', '/users/42/extra')).toBeNull();
  });

  it('captures the rest with a trailing star', () => {
    expect(matchPath('/files/*', '/files/a/b/c.txt')).toEqual({ splat: 'a/b/c.txt' });
    expect(matchPath('/files/*', '/files')).toEqual({ splat: '' });
    expect(matchPath('/files/*rest', '/files/x')).toEqual({ rest: 'x' });
    expect(matchPath('/*', '/anything/at/all')).toEqual({ splat: 'anything/at/all' });
    expect(matchPath('/a/*/c', '/a/b/c')).toEqual({ splat: 'b' });
  });

  it('ignores the query string of the request', () => {
    expect(matchPath('/users/:id', '/users/7?expand=1')).toEqual({ id: '7' });
  });
});

describe('methodMatches and findRoute', () => {
  it('treats ANY as a wildcard and HEAD as GET', () => {
    expect(methodMatches('ANY', 'delete')).toBe(true);
    expect(methodMatches('GET', 'HEAD')).toBe(true);
    expect(methodMatches('POST', 'HEAD')).toBe(false);
    expect(methodMatches('POST', 'post')).toBe(true);
  });

  it('returns the first enabled match in order', () => {
    const routes = [
      newMockRoute({ id: 'off', method: 'GET', path: '/users/:id', enabled: false }),
      newMockRoute({ id: 'post', method: 'POST', path: '/users/:id' }),
      newMockRoute({ id: 'one', method: 'GET', path: '/users/:id' }),
      newMockRoute({ id: 'any', method: 'ANY', path: '/*' }),
    ];
    expect(findRoute(routes, 'GET', '/users/3')?.route.id).toBe('one');
    expect(findRoute(routes, 'GET', '/users/3')?.params).toEqual({ id: '3' });
    expect(findRoute(routes, 'PUT', '/users/3')?.route.id).toBe('any');
    expect(findRoute([], 'GET', '/')).toBeNull();
  });
});

describe('requestVariables', () => {
  const base = {
    method: 'POST',
    path: '/orders/9',
    url: '/orders/9?verbose=1&verbose=2',
    query: parseQuery('/orders/9?verbose=1&verbose=2'),
    headers: [['Content-Type', 'application/json'], ['X-Request-Id', 'abc']] as [string, string][],
    body: '{"customer":{"name":"Ada","tags":["a","b"]},"total":12.5,"note":null}',
    bodyEncoding: 'utf8' as const,
  };

  it('exposes params, query, lower-cased headers and flattened JSON body', () => {
    const vars = requestVariables(base, { id: '9' });
    expect(vars.method).toBe('POST');
    expect(vars.path).toBe('/orders/9');
    expect(vars['params.id']).toBe('9');
    expect(vars['query.verbose']).toBe('1');
    expect(vars['headers.x-request-id']).toBe('abc');
    expect(vars['body.customer.name']).toBe('Ada');
    expect(vars['body.customer.tags.1']).toBe('b');
    expect(vars['body.customer.tags']).toBe('["a","b"]');
    expect(vars['body.total']).toBe('12.5');
    expect(vars['body.note']).toBe('');
    expect(vars.body).toBe(base.body);
  });

  it('keeps a non-JSON body as raw text and skips binary bodies', () => {
    expect(requestVariables({ ...base, body: 'hello' }, {}).body).toBe('hello');
    expect(requestVariables({ ...base, body: 'AAAA', bodyEncoding: 'base64' }, {}).body).toBeUndefined();
  });
});

describe('renderResponse', () => {
  it('resolves templates in headers and body and infers the content type', () => {
    const vars = requestVariables({ method: 'GET', path: '/users/5', url: '/users/5?q=x', query: { q: 'x' }, headers: [], body: '', bodyEncoding: 'utf8' }, { id: '5' });
    const out = renderResponse(
      { status: 201, headers: [{ id: 'h', key: 'X-Id', value: '{{params.id}}', enabled: true }], body: '{"id":"{{params.id}}","q":"{{query.q}}","rid":"{{$uuid}}"}' },
      vars,
    );
    expect(out.status).toBe(201);
    expect(out.headers).toContainEqual(['X-Id', '5']);
    expect(out.headers.find(([k]) => k === 'Content-Type')?.[1]).toBe('application/json; charset=utf-8');
    const parsed = JSON.parse(out.body) as { id: string; q: string; rid: string };
    expect(parsed.id).toBe('5');
    expect(parsed.q).toBe('x');
    expect(parsed.rid).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('leaves unknown placeholders alone and respects an explicit content type', () => {
    const out = renderResponse({ status: 200, headers: [{ id: 'h', key: 'content-type', value: 'text/csv', enabled: true }], body: 'a,{{nope}}' }, {});
    expect(out.body).toBe('a,{{nope}}');
    expect(out.headers).toEqual([['content-type', 'text/csv']]);
  });
});

describe('inferContentType', () => {
  it('guesses json, html, xml and text', () => {
    expect(inferContentType('')).toBeNull();
    expect(inferContentType(' {"a":1} ')).toBe('application/json; charset=utf-8');
    expect(inferContentType('[1,2]')).toBe('application/json; charset=utf-8');
    expect(inferContentType('{not json')).toBe('text/plain; charset=utf-8');
    expect(inferContentType('<!doctype html><html></html>')).toBe('text/html; charset=utf-8');
    expect(inferContentType('<note/>')).toBe('application/xml; charset=utf-8');
    expect(inferContentType('plain')).toBe('text/plain; charset=utf-8');
  });
});

describe('replay helpers', () => {
  const captured: MockCapturedRequest = {
    id: 'r1',
    serverId: 's1',
    at: '2026-01-01T00:00:00.000Z',
    method: 'POST',
    url: '/hooks/github?x=1',
    path: '/hooks/github',
    query: { x: '1' },
    headers: [
      ['Host', '127.0.0.1:4000'],
      ['Content-Length', '9'],
      ['Content-Type', 'application/json'],
      ['X-Hub-Signature', 'sha1=abc'],
    ],
    contentType: 'application/json',
    body: '{"ok":true}',
    bodyEncoding: 'utf8',
    size: 11,
    truncated: false,
    remoteAddress: '127.0.0.1',
    routeId: null,
    outcome: 'fallback',
    response: { status: 200, headers: [], body: '', bodyEncoding: 'utf8', size: 0, truncated: false, durationMs: 1 },
  };

  it('drops hop-by-hop headers', () => {
    expect(replayableHeaders(captured.headers).map(([k]) => k)).toEqual(['Content-Type', 'X-Hub-Signature']);
  });

  it('appends the captured path to a bare origin and keeps an explicit path', () => {
    expect(replayUrl('http://localhost:3000', captured)).toBe('http://localhost:3000/hooks/github?x=1');
    expect(replayUrl('localhost:3000/', captured)).toBe('http://localhost:3000/hooks/github?x=1');
    expect(replayUrl('http://localhost:3000/api/hook', captured)).toBe('http://localhost:3000/api/hook');
    expect(() => replayUrl('http://[bad', captured)).toThrow(/Invalid replay target/);
  });

  it('builds forward URLs from a base with or without a path prefix', () => {
    expect(forwardUrl('http://localhost:3000', captured.url)).toBe('http://localhost:3000/hooks/github?x=1');
    expect(forwardUrl('localhost:3000/', captured.url)).toBe('http://localhost:3000/hooks/github?x=1');
    expect(forwardUrl('https://api.example.com/v1/', captured.url)).toBe('https://api.example.com/v1/hooks/github?x=1');
  });

  it('renders a curl command against the mock server', () => {
    const curl = capturedToCurl(captured, 'http://127.0.0.1:4000/');
    expect(curl).toContain("curl -X POST 'http://127.0.0.1:4000/hooks/github?x=1'");
    expect(curl).toContain("-H 'X-Hub-Signature: sha1=abc'");
    expect(curl).not.toContain('Host:');
    expect(curl).toContain(`--data-raw '{"ok":true}'`);
  });
});

describe('schemas', () => {
  it('drafts carry no defaults, so partial updates only touch named fields', () => {
    const route = MockRouteDraftSchema.parse({ id: 'r', body: 'x' });
    expect(Object.keys(route)).toEqual(['id', 'body']);
    const existing = newMockRoute({ id: 'r', method: 'POST', path: '/a', status: 201 });
    expect(MockRouteSchema.parse({ ...existing, ...compact(route) })).toMatchObject({ method: 'POST', path: '/a', status: 201, body: 'x' });
    const server = MockServerDraftSchema.parse({ id: 's', name: 'n', routes: undefined });
    expect(compact(server)).toEqual({ id: 's', name: 'n' });
  });

  it('fills defaults for a new server and validates ports', () => {
    const server = newMockServer({ name: 'hooks' });
    expect(server.port).toBe(0);
    expect(server.host).toBe('127.0.0.1');
    expect(server.fallback).toEqual({ type: 'respond', status: 404, headers: [], body: '' });
    expect(server.cors).toBe(true);
    expect(MockServerSchema.safeParse({ ...server, port: 70000 }).success).toBe(false);
    expect(MockServerSchema.safeParse({ ...server, fallback: { type: 'forward', url: 'http://localhost:3000' } }).success).toBe(true);
  });
});
