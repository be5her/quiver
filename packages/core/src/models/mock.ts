import { toCurl } from '../curl';
import { newId, nowIso } from '../ids';
import { resolveTemplate } from '../variables';
import { z } from 'zod';
import type { MockPortRecord } from '../types';
import { HttpMethodSchema, KeyValueSchema, type HttpMethod, type KeyValue } from './api';

/**
 * Mock servers and webhook receivers. A server is a local HTTP listener with an ordered list of
 * routes; every request is captured whether or not a route matched, so an empty server is a
 * webhook receiver. Unmatched requests get the fallback: a canned response or a forward to a
 * real upstream, which turns the server into a recording proxy.
 */

export const MockMethodSchema = z.enum(['ANY', ...HttpMethodSchema.options]);
export type MockMethod = z.infer<typeof MockMethodSchema>;

export const MockRouteSchema = z.object({
  id: z.string(),
  enabled: z.boolean().default(true),
  method: MockMethodSchema.default('ANY'),
  /** Path pattern: `/users/:id` captures a segment, a trailing `*` captures the rest. The query string is ignored. */
  path: z.string().default('/'),
  status: z.number().int().min(100).max(599).default(200),
  headers: z.array(KeyValueSchema).default([]),
  /** Response body. `{{params.id}}`, `{{query.x}}`, `{{headers.x}}`, `{{body.field}}` and `{{$uuid}}` are resolved per request. */
  body: z.string().default(''),
  delayMs: z.number().int().min(0).max(120_000).default(0),
  description: z.string().default(''),
});
export type MockRoute = z.infer<typeof MockRouteSchema>;

/** Partial route for create or update. No defaults here, so an update only touches the fields it names. */
export const MockRouteDraftSchema = z.object({
  id: z.string().optional(),
  enabled: z.boolean().optional(),
  method: MockMethodSchema.optional(),
  path: z.string().optional(),
  status: z.number().int().min(100).max(599).optional(),
  headers: z.array(KeyValueSchema).optional(),
  body: z.string().optional(),
  delayMs: z.number().int().min(0).max(120_000).optional(),
  description: z.string().optional(),
});
export type MockRouteDraft = z.infer<typeof MockRouteDraftSchema>;

/** Drop undefined values so a partial draft can be spread over an existing item. */
export function compact<T extends object>(value: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(value)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}

export const MockFallbackSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('respond'),
    status: z.number().int().min(100).max(599).default(404),
    headers: z.array(KeyValueSchema).default([]),
    body: z.string().default(''),
  }),
  z.object({
    type: z.literal('forward'),
    /** Upstream base URL; the request path and query are appended. */
    url: z.string().default(''),
  }),
]);
export type MockFallback = z.infer<typeof MockFallbackSchema>;

export const MockServerSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** 0 means pick a free port when the server is created. */
  port: z.number().int().min(0).max(65535).default(0),
  /** Loopback only, or every interface so containers and other machines can reach it. */
  host: z.enum(['127.0.0.1', '0.0.0.0']).default('127.0.0.1'),
  /** Start when the workspace opens. */
  autoStart: z.boolean().default(false),
  /** Answer preflight requests and add Access-Control-Allow-* headers so browser apps can call the mock directly. */
  cors: z.boolean().default(true),
  routes: z.array(MockRouteSchema).default([]),
  fallback: MockFallbackSchema.default({ type: 'respond', status: 404, headers: [], body: '' }),
  /** Captured requests kept per server, oldest dropped first. */
  logLimit: z.number().int().min(10).max(5000).default(500),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type MockServer = z.infer<typeof MockServerSchema>;

/** Partial server for create or update. Routes given here replace the list; use mock.route.save for one route. */
export const MockServerDraftSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  port: z.number().int().min(0).max(65535).optional(),
  host: z.enum(['127.0.0.1', '0.0.0.0']).optional(),
  autoStart: z.boolean().optional(),
  cors: z.boolean().optional(),
  routes: z.array(MockRouteSchema).optional(),
  fallback: MockFallbackSchema.optional(),
  logLimit: z.number().int().min(10).max(5000).optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});
export type MockServerDraft = z.infer<typeof MockServerDraftSchema>;

/** What the UI and agents see: the definition plus runtime state. */
export interface MockServerSummary extends MockServer {
  running: boolean;
  /** `http://127.0.0.1:<port>` while running. */
  url: string | null;
  requestCount: number;
  lastRequestAt: string | null;
  /** Why the last start failed, e.g. the port is taken. */
  error: string | null;
}

export type MockOutcome = 'route' | 'fallback' | 'forwarded' | 'preflight' | 'error';

export interface MockCapturedResponse {
  status: number;
  headers: [string, string][];
  body: string;
  bodyEncoding: 'utf8' | 'base64';
  size: number;
  truncated: boolean;
  durationMs: number;
}

/** One request a mock server received, with what it answered. */
export interface MockCapturedRequest {
  id: string;
  serverId: string;
  at: string;
  method: string;
  /** Path and query as received. */
  url: string;
  path: string;
  query: Record<string, string>;
  headers: [string, string][];
  contentType: string | null;
  body: string;
  bodyEncoding: 'utf8' | 'base64';
  size: number;
  truncated: boolean;
  remoteAddress: string;
  routeId: string | null;
  outcome: MockOutcome;
  response: MockCapturedResponse;
}

export interface MockReplayResult {
  url: string;
  status: number;
  statusText: string;
  headers: [string, string][];
  body: string;
  bodyEncoding: 'utf8' | 'base64';
  size: number;
  truncated: boolean;
  durationMs: number;
}

export function newMockRoute(partial: Partial<MockRoute> = {}): MockRoute {
  return MockRouteSchema.parse({ id: newId(), ...partial });
}

export function newMockServer(partial: Partial<MockServer> = {}): MockServer {
  const ts = nowIso();
  return MockServerSchema.parse({ id: newId(), name: 'Mock server', createdAt: ts, updatedAt: ts, ...partial });
}

export function mockServerUrl(server: Pick<MockServer, 'port'>, port = server.port): string {
  return `http://127.0.0.1:${port}`;
}

export function describeRoute(route: Pick<MockRoute, 'method' | 'path'>): string {
  return `${route.method} ${route.path || '/'}`;
}

/** Path without query, with one leading slash and no trailing slash (except the root). */
export function normalizePath(input: string): string {
  let path = input.split('?')[0].split('#')[0];
  if (!path.startsWith('/')) path = `/${path}`;
  path = path.replace(/\/{2,}/g, '/');
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  return path;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Match a route pattern against a request path. `:name` captures one segment, a final `*`
 * (optionally `*name`) captures the rest including slashes, and everything else compares literally.
 * Returns the captured params, or null when the pattern does not match.
 */
export function matchPath(pattern: string, path: string): Record<string, string> | null {
  const want = normalizePath(pattern).split('/').slice(1);
  const have = normalizePath(path).split('/').slice(1);
  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i++) {
    const p = want[i];
    if (p.startsWith('*') && i === want.length - 1) {
      params[p.slice(1) || 'splat'] = have.slice(i).map(decodeSegment).join('/');
      return params;
    }
    const h = have[i];
    if (h === undefined) return null;
    if (p === '*') {
      params.splat = decodeSegment(h);
      continue;
    }
    if (p.startsWith(':') && p.length > 1) {
      if (h === '' && i === want.length - 1) return null;
      params[p.slice(1)] = decodeSegment(h);
      continue;
    }
    if (p !== h) return null;
  }
  return have.length === want.length ? params : null;
}

export function methodMatches(routeMethod: MockMethod, method: string): boolean {
  const m = method.toUpperCase();
  if (routeMethod === 'ANY') return true;
  if (routeMethod === m) return true;
  return routeMethod === 'GET' && m === 'HEAD';
}

/** First enabled route whose method and path match, in list order. */
export function findRoute(routes: MockRoute[], method: string, path: string): { route: MockRoute; params: Record<string, string> } | null {
  for (const route of routes) {
    if (!route.enabled || !methodMatches(route.method, method)) continue;
    const params = matchPath(route.path, path);
    if (params) return { route, params };
  }
  return null;
}

export function parseQuery(url: string): Record<string, string> {
  const index = url.indexOf('?');
  if (index < 0) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(url.slice(index + 1))) if (!(k in out)) out[k] = v;
  return out;
}

const FLATTEN_LIMIT = 2000;

function flatten(prefix: string, value: unknown, out: Record<string, string>, depth: number): void {
  if (Object.keys(out).length > FLATTEN_LIMIT || depth > 8) return;
  if (value === null || value === undefined) {
    out[prefix] = '';
  } else if (Array.isArray(value)) {
    out[prefix] = JSON.stringify(value);
    value.forEach((v, i) => flatten(`${prefix}.${i}`, v, out, depth + 1));
  } else if (typeof value === 'object') {
    out[prefix] = JSON.stringify(value);
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) flatten(`${prefix}.${k}`, v, out, depth + 1);
  } else {
    out[prefix] = String(value);
  }
}

/**
 * Variables a route template can use for one request: `method`, `path`, `url`, `params.*`,
 * `query.*`, `headers.*` (lower-case names), `body` and, for JSON bodies, `body.<field>` paths.
 */
export function requestVariables(
  req: Pick<MockCapturedRequest, 'method' | 'path' | 'url' | 'query' | 'headers' | 'body' | 'bodyEncoding'>,
  params: Record<string, string>,
): Record<string, string> {
  const vars: Record<string, string> = { method: req.method, path: req.path, url: req.url };
  for (const [k, v] of Object.entries(params)) vars[`params.${k}`] = v;
  for (const [k, v] of Object.entries(req.query)) vars[`query.${k}`] = v;
  for (const [k, v] of req.headers) vars[`headers.${k.toLowerCase()}`] = v;
  if (req.bodyEncoding === 'utf8') {
    vars.body = req.body;
    const trimmed = req.body.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        flatten('body', JSON.parse(trimmed), vars, 0);
      } catch {
        // not JSON after all; body stays the raw text
      }
    }
  }
  return vars;
}

/** Content type guessed from a body when the route sets none. */
export function inferContentType(body: string): string | null {
  const t = body.trim();
  if (!t) return null;
  if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
    try {
      JSON.parse(t);
      return 'application/json; charset=utf-8';
    } catch {
      return 'text/plain; charset=utf-8';
    }
  }
  if (t.startsWith('<')) return /^<!doctype html|<html/i.test(t) ? 'text/html; charset=utf-8' : 'application/xml; charset=utf-8';
  return 'text/plain; charset=utf-8';
}

export interface RenderedResponse {
  status: number;
  headers: [string, string][];
  body: string;
}

/** Resolve a route's (or the fallback's) templates against one request. */
export function renderResponse(spec: { status: number; headers: KeyValue[]; body: string }, vars: Record<string, string>): RenderedResponse {
  const headers: [string, string][] = spec.headers.filter((h) => h.enabled && h.key.trim()).map((h) => [h.key.trim(), resolveTemplate(h.value, vars)]);
  const body = resolveTemplate(spec.body, vars);
  if (!headers.some(([k]) => k.toLowerCase() === 'content-type')) {
    const inferred = inferContentType(body);
    if (inferred) headers.push(['Content-Type', inferred]);
  }
  return { status: spec.status, headers, body };
}

const HOP_BY_HOP = new Set(['host', 'content-length', 'connection', 'keep-alive', 'transfer-encoding', 'proxy-connection', 'upgrade', 'te', 'trailer', 'expect']);

/** Headers of a captured request that make sense to send again elsewhere. */
export function replayableHeaders(headers: [string, string][]): [string, string][] {
  return headers.filter(([k]) => !HOP_BY_HOP.has(k.toLowerCase()));
}

/** Build the absolute URL a captured request would hit on another server, given a base or full URL. */
export function replayUrl(target: string, captured: Pick<MockCapturedRequest, 'url'>): string {
  const trimmed = target.trim();
  let base: URL;
  try {
    base = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`);
  } catch {
    throw new Error(`Invalid replay target: ${target}`);
  }
  const explicitPath = base.pathname !== '/' || base.search !== '';
  if (explicitPath) return base.toString();
  return `${base.origin}${captured.url}`;
}

/** URL an unmatched request is forwarded to: the upstream base (which may carry a path prefix) plus the captured path and query. */
export function forwardUrl(base: string, capturedUrl: string): string {
  const trimmed = base.trim().replace(/\/+$/, '');
  const origin = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  return `${origin}${capturedUrl.startsWith('/') ? '' : '/'}${capturedUrl}`;
}

/** Render a captured request as a curl command against the given base URL (the mock server by default). */
export function capturedToCurl(captured: MockCapturedRequest, baseUrl: string): string {
  const method = (HttpMethodSchema.options as string[]).includes(captured.method.toUpperCase()) ? (captured.method.toUpperCase() as HttpMethod) : 'GET';
  const body = captured.bodyEncoding === 'utf8' && captured.body ? captured.body : null;
  return toCurl({ method, url: `${baseUrl.replace(/\/$/, '')}${captured.url}`, headers: replayableHeaders(captured.headers), body });
}

// ---------- ports ----------

/** Mock servers get random five-digit ports below the ephemeral ranges of Linux (32768+) and Windows (49152+). */
export const MOCK_PORT_MIN = 10000;
export const MOCK_PORT_MAX = 32767;

/** Up to `count` distinct random ports in the mock range that are not in `avoid`, in the order to try them. */
export function randomPortCandidates(avoid: Set<number>, count = 50, random: () => number = Math.random): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  const span = MOCK_PORT_MAX - MOCK_PORT_MIN + 1;
  for (let i = 0; i < Math.max(1000, count * 20) && out.length < count; i++) {
    const port = MOCK_PORT_MIN + Math.floor(random() * span);
    if (port < MOCK_PORT_MIN || port > MOCK_PORT_MAX || seen.has(port)) continue;
    seen.add(port);
    if (!avoid.has(port)) out.push(port);
  }
  return out;
}

function samePortOwner(a: Pick<MockPortRecord, 'workspace' | 'serverId'>, b: Pick<MockPortRecord, 'workspace' | 'serverId'>): boolean {
  return a.workspace === b.workspace && a.serverId === b.serverId;
}

/** Records with `record` added, or replacing the entry of the same server. Returns the same array when nothing changed. */
export function withPortRecord(records: MockPortRecord[], record: MockPortRecord): MockPortRecord[] {
  const index = records.findIndex((r) => samePortOwner(r, record));
  if (index === -1) return [...records, record];
  const current = records[index];
  if (current.port === record.port && current.name === record.name) return records;
  return records.map((r, i) => (i === index ? record : r));
}

/** Records without the entry of the given server. Returns the same array when there was none. */
export function withoutPortRecord(records: MockPortRecord[], workspace: string, serverId: string): MockPortRecord[] {
  const next = records.filter((r) => !samePortOwner(r, { workspace, serverId }));
  return next.length === records.length ? records : next;
}

/** The record of a server other than `except` that holds `port`, if any. */
export function findPortRecord(records: MockPortRecord[], port: number, except?: Pick<MockPortRecord, 'workspace' | 'serverId'>): MockPortRecord | undefined {
  return records.find((r) => r.port === port && (!except || !samePortOwner(r, except)));
}
