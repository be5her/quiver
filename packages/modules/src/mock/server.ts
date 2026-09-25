import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createTcpServer, type AddressInfo } from 'node:net';
import {
  MOCK_PORT_MAX,
  MOCK_PORT_MIN,
  QuiverError,
  findPortRecord,
  findRoute,
  forwardUrl,
  matchPath,
  mockServerUrl,
  newId,
  normalizePath,
  nowIso,
  parseQuery,
  randomPortCandidates,
  renderResponse,
  replayableHeaders,
  requestVariables,
  type HostApi,
  type MockCapturedRequest,
  type MockServer,
  type MockServerSummary,
  type WorkspaceApi,
} from '@quiver/core';
import { fetch as undiciFetch } from 'undici';

/** Bytes of a request body kept in the log; the rest is dropped but counted. */
const CAPTURE_LIMIT = 256 * 1024;
/** Bytes of a response body kept in the log. */
const RESPONSE_CAPTURE_LIMIT = 64 * 1024;
/** Bytes of a request body read at all (templates and forwarding see up to this much). */
const READ_LIMIT = 10 * 1024 * 1024;
const FORWARD_TIMEOUT_MS = 30_000;
const TEXT_TYPES = /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded|graphql|yaml|x-yaml|ld\+json|problem\+json)|.*\+(json|xml))/i;
/** Upstream headers not passed back through a forward: the body is re-framed and already decoded. */
const STRIP_UPSTREAM = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive']);

export type MockChangeReason = 'status' | 'requests' | 'servers';

interface Outgoing {
  status: number;
  headers: [string, string][];
  body: Buffer;
}

interface Waiter {
  match(req: MockCapturedRequest): boolean;
  resolve(req: MockCapturedRequest | null): void;
}

interface ServerState {
  workspace: WorkspaceApi;
  host: HostApi | null;
  definition: MockServer;
  http: Server | null;
  boundPort: number;
  error: string | null;
  log: MockCapturedRequest[];
  logLoaded: Promise<void> | null;
  waiters: Set<Waiter>;
  emitTimer: NodeJS.Timeout | null;
  persistTimer: NodeJS.Timeout | null;
  persisting: Promise<void>;
  dirty: boolean;
}

const logName = (serverId: string) => `mock-requests-${serverId}`;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function errorMessage(err: unknown): string {
  const cause = (err as { cause?: Error })?.cause;
  const message = (err as Error)?.message ?? String(err);
  return cause?.message && !message.includes(cause.message) ? `${message}: ${cause.message}` : message;
}

function rawHeaders(req: IncomingMessage): [string, string][] {
  const out: [string, string][] = [];
  for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) out.push([req.rawHeaders[i], req.rawHeaders[i + 1]]);
  return out;
}

function looksText(contentType: string | null | undefined, body: Buffer): boolean {
  if (contentType) return TEXT_TYPES.test(contentType);
  return !body.subarray(0, 512).includes(0);
}

function encode(body: Buffer, text: boolean, limit: number): { body: string; bodyEncoding: 'utf8' | 'base64' } {
  const kept = body.subarray(0, limit);
  return text ? { body: kept.toString('utf8'), bodyEncoding: 'utf8' } : { body: kept.toString('base64'), bodyEncoding: 'base64' };
}

function headerValue(headers: [string, string][], name: string): string | null {
  const lower = name.toLowerCase();
  return headers.find(([k]) => k.toLowerCase() === lower)?.[1] ?? null;
}

function json(status: number, value: unknown): Outgoing {
  return { status, headers: [['Content-Type', 'application/json; charset=utf-8']], body: Buffer.from(JSON.stringify(value), 'utf8') };
}

function addCors(headers: [string, string][], req: IncomingMessage): void {
  const has = (name: string) => headers.some(([k]) => k.toLowerCase() === name);
  const origin = req.headers.origin ?? '*';
  if (!has('access-control-allow-origin')) headers.push(['Access-Control-Allow-Origin', origin]);
  if (!has('access-control-allow-methods')) headers.push(['Access-Control-Allow-Methods', req.headers['access-control-request-method'] ?? 'GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS']);
  if (!has('access-control-allow-headers')) headers.push(['Access-Control-Allow-Headers', req.headers['access-control-request-headers'] ?? '*']);
  if (!has('access-control-expose-headers')) headers.push(['Access-Control-Expose-Headers', '*']);
  if (origin !== '*' && !has('access-control-allow-credentials')) headers.push(['Access-Control-Allow-Credentials', 'true']);
  if (!has('vary')) headers.push(['Vary', 'Origin']);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

function canListen(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createTcpServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, host, () => probe.close(() => resolve(true)));
  });
}

/** A random five-digit port that is free on both loopback and all interfaces and not in `avoid`. */
export async function pickPort(avoid: Set<number>): Promise<number> {
  for (const port of randomPortCandidates(avoid, 100)) {
    if ((await canListen(port, '127.0.0.1')) && (await canListen(port, '0.0.0.0'))) return port;
  }
  throw new QuiverError('REQUEST_FAILED', `No free port found between ${MOCK_PORT_MIN} and ${MOCK_PORT_MAX}`);
}

/** Names the other Quiver mock server recorded on this port, when there is one. */
function portOwner(host: HostApi, ws: WorkspaceApi, definition: MockServer): string {
  const record = findPortRecord(host.config.get().mock.ports, definition.port, { workspace: ws.path, serverId: definition.id });
  return record ? ` by mock server "${record.name}" in ${record.workspace}` : '';
}

/**
 * Runs mock servers for every open workspace. Each server keeps a bounded log of captured
 * requests in memory, mirrored to `.quiver/local/mock-requests-<id>.json` so webhooks survive a
 * restart, and wakes up `wait` callers when a matching request arrives.
 */
export class MockRuntime {
  private readonly byWorkspace = new Map<string, Map<string, ServerState>>();

  private state(ws: WorkspaceApi, definition: MockServer): ServerState {
    let map = this.byWorkspace.get(ws.id);
    if (!map) {
      map = new Map();
      this.byWorkspace.set(ws.id, map);
    }
    let s = map.get(definition.id);
    if (!s) {
      s = {
        workspace: ws,
        host: null,
        definition,
        http: null,
        boundPort: 0,
        error: null,
        log: [],
        logLoaded: null,
        waiters: new Set(),
        emitTimer: null,
        persistTimer: null,
        persisting: Promise.resolve(),
        dirty: false,
      };
      map.set(definition.id, s);
    }
    return s;
  }

  private peek(workspaceId: string, serverId: string): ServerState | undefined {
    return this.byWorkspace.get(workspaceId)?.get(serverId);
  }

  private ensureLog(s: ServerState): Promise<void> {
    s.logLoaded ??= s.workspace.store
      .readLocal<MockCapturedRequest[]>(logName(s.definition.id), [])
      .then((entries) => {
        if (!Array.isArray(entries)) return;
        const valid = entries.filter((e) => e && typeof e === 'object' && typeof e.id === 'string' && typeof e.at === 'string');
        s.log = [...valid, ...s.log].slice(-s.definition.logLimit);
      })
      .catch(() => undefined);
    return s.logLoaded;
  }

  isRunning(workspaceId: string, serverId: string): boolean {
    return Boolean(this.peek(workspaceId, serverId)?.http);
  }

  async summary(ws: WorkspaceApi, definition: MockServer): Promise<MockServerSummary> {
    const s = this.state(ws, definition);
    await this.ensureLog(s);
    if (!s.http) s.definition = definition;
    return {
      ...definition,
      running: Boolean(s.http),
      url: s.http ? mockServerUrl(definition, s.boundPort) : null,
      requestCount: s.log.length,
      lastRequestAt: s.log.at(-1)?.at ?? null,
      error: s.error,
    };
  }

  async start(ws: WorkspaceApi, host: HostApi, definition: MockServer): Promise<MockServerSummary> {
    const s = this.state(ws, definition);
    s.host = host;
    if (s.http) return this.summary(ws, s.definition);
    s.definition = definition;
    await this.ensureLog(s);
    const server = createServer((req, res) => this.handle(s, req, res));
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(definition.port, definition.host, () => {
          server.off('error', reject);
          resolve();
        });
      });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      s.error =
        code === 'EADDRINUSE'
          ? `Port ${definition.port} is already in use${portOwner(host, ws, definition)}`
          : code === 'EACCES'
            ? `Port ${definition.port} is not allowed for this user`
            : errorMessage(err);
      this.notify(s, 'status');
      throw new QuiverError('REQUEST_FAILED', s.error, { port: definition.port, code });
    }
    server.on('error', (err) => {
      s.error = errorMessage(err);
    });
    s.http = server;
    s.boundPort = (server.address() as AddressInfo).port;
    s.error = null;
    this.notify(s, 'status');
    return this.summary(ws, definition);
  }

  async stop(ws: WorkspaceApi, serverId: string): Promise<boolean> {
    const s = this.peek(ws.id, serverId);
    if (!s?.http) return false;
    const server = s.http;
    s.http = null;
    await closeServer(server);
    this.notify(s, 'status');
    return true;
  }

  /** Take a saved definition into account: routes change live, a new port or host restarts the listener. */
  async apply(ws: WorkspaceApi, host: HostApi, definition: MockServer): Promise<void> {
    const s = this.peek(ws.id, definition.id);
    if (!s) return;
    s.host = host;
    const rebind = Boolean(s.http) && (s.definition.port !== definition.port || s.definition.host !== definition.host);
    s.definition = definition;
    if (s.log.length > definition.logLimit) {
      s.log.splice(0, s.log.length - definition.logLimit);
      this.schedulePersist(s);
    }
    if (rebind) {
      await this.stop(ws, definition.id);
      await this.start(ws, host, definition);
    } else {
      this.notify(s, 'servers');
    }
  }

  async remove(ws: WorkspaceApi, serverId: string): Promise<void> {
    const s = this.peek(ws.id, serverId);
    if (!s) return;
    await this.stop(ws, serverId);
    if (s.persistTimer) clearTimeout(s.persistTimer);
    s.persistTimer = null;
    s.dirty = false;
    s.log = [];
    for (const w of [...s.waiters]) w.resolve(null);
    await s.workspace.store.writeLocal(logName(serverId), []).catch(() => undefined);
    this.byWorkspace.get(ws.id)?.delete(serverId);
  }

  async requests(ws: WorkspaceApi, definition: MockServer, opts: { limit: number; since?: string; method?: string; path?: string }): Promise<MockCapturedRequest[]> {
    const s = this.state(ws, definition);
    await this.ensureLog(s);
    let list = s.log;
    if (opts.since) list = list.filter((r) => r.at > opts.since!);
    if (opts.method) list = list.filter((r) => r.method === opts.method!.toUpperCase());
    if (opts.path) list = list.filter((r) => matchPath(opts.path!, r.path) !== null);
    return list.slice(-opts.limit).reverse();
  }

  async request(ws: WorkspaceApi, definition: MockServer, id: string): Promise<MockCapturedRequest | undefined> {
    const s = this.state(ws, definition);
    await this.ensureLog(s);
    return s.log.find((r) => r.id === id);
  }

  async clear(ws: WorkspaceApi, definition: MockServer): Promise<number> {
    const s = this.state(ws, definition);
    await this.ensureLog(s);
    const count = s.log.length;
    s.log = [];
    this.schedulePersist(s);
    await this.flush(s);
    this.notify(s, 'requests');
    return count;
  }

  /** Resolves with the next captured request the predicate accepts, or null after the timeout. */
  wait(ws: WorkspaceApi, definition: MockServer, match: (req: MockCapturedRequest) => boolean, timeoutMs: number): Promise<MockCapturedRequest | null> {
    const s = this.state(ws, definition);
    return new Promise((resolve) => {
      const waiter: Waiter = {
        match,
        resolve: (req) => {
          clearTimeout(timer);
          s.waiters.delete(waiter);
          resolve(req);
        },
      };
      const timer = setTimeout(() => waiter.resolve(null), timeoutMs);
      s.waiters.add(waiter);
    });
  }

  async closeWorkspace(ws: WorkspaceApi): Promise<void> {
    const map = this.byWorkspace.get(ws.id);
    if (!map) return;
    for (const s of map.values()) {
      await this.stop(ws, s.definition.id);
      for (const w of [...s.waiters]) w.resolve(null);
      await this.flush(s);
    }
    this.byWorkspace.delete(ws.id);
  }

  async stopAll(): Promise<void> {
    for (const map of [...this.byWorkspace.values()]) {
      for (const s of map.values()) await this.closeWorkspace(s.workspace);
    }
  }

  // ---------- request handling ----------

  private handle(s: ServerState, req: IncomingMessage, res: ServerResponse): void {
    const started = performance.now();
    const chunks: Buffer[] = [];
    let received = 0;
    req.on('data', (chunk: Buffer) => {
      if (received < READ_LIMIT) chunks.push(received + chunk.length > READ_LIMIT ? chunk.subarray(0, READ_LIMIT - received) : chunk);
      received += chunk.length;
    });
    req.on('error', () => undefined);
    req.on('end', () => {
      void this.respond(s, req, res, Buffer.concat(chunks), received, started).catch((err) => {
        try {
          if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
          res.end(`mock server error: ${errorMessage(err)}`);
        } catch {
          // socket already gone
        }
      });
    });
  }

  private async respond(s: ServerState, req: IncomingMessage, res: ServerResponse, body: Buffer, received: number, started: number): Promise<void> {
    const def = s.definition;
    const method = (req.method ?? 'GET').toUpperCase();
    const url = req.url ?? '/';
    const headers = rawHeaders(req);
    const contentType = req.headers['content-type'] ?? null;
    const text = looksText(contentType, body);
    const captured: MockCapturedRequest = {
      id: newId(),
      serverId: def.id,
      at: nowIso(),
      method,
      url,
      path: normalizePath(url),
      query: parseQuery(url),
      headers,
      contentType,
      ...encode(body, text, CAPTURE_LIMIT),
      size: received,
      truncated: received > CAPTURE_LIMIT,
      remoteAddress: req.socket.remoteAddress ?? '',
      routeId: null,
      outcome: 'fallback',
      response: { status: 0, headers: [], body: '', bodyEncoding: 'utf8', size: 0, truncated: false, durationMs: 0 },
    };
    const variables = (params: Record<string, string>) =>
      requestVariables({ ...captured, body: text ? body.toString('utf8') : '', bodyEncoding: text ? 'utf8' : 'base64' }, params);

    let out: Outgoing;
    let delay = 0;
    const match = findRoute(def.routes, method, captured.path);
    if (match) {
      captured.routeId = match.route.id;
      captured.outcome = 'route';
      delay = match.route.delayMs;
      const rendered = renderResponse(match.route, variables(match.params));
      out = { status: rendered.status, headers: rendered.headers, body: Buffer.from(rendered.body, 'utf8') };
    } else if (def.cors && method === 'OPTIONS' && req.headers['access-control-request-method']) {
      captured.outcome = 'preflight';
      out = { status: 204, headers: [], body: Buffer.alloc(0) };
    } else if (def.fallback.type === 'forward') {
      const target = def.fallback.url.trim();
      if (!target) {
        captured.outcome = 'error';
        out = json(502, { error: 'This mock server forwards unmatched requests, but no forward URL is set' });
      } else {
        try {
          out = await this.forward(target, captured, body);
          captured.outcome = 'forwarded';
        } catch (err) {
          captured.outcome = 'error';
          out = json(502, { error: 'Forward failed', target: forwardUrl(target, url), message: errorMessage(err) });
        }
      }
    } else {
      captured.outcome = 'fallback';
      const rendered = renderResponse(def.fallback, variables({}));
      out = { status: rendered.status, headers: rendered.headers, body: Buffer.from(rendered.body, 'utf8') };
    }
    if (def.cors) addCors(out.headers, req);
    if (delay > 0) await sleep(delay);

    if (!res.destroyed && !res.writableEnded) {
      const merged = new Map<string, { name: string; values: string[] }>();
      for (const [k, v] of out.headers) {
        const entry = merged.get(k.toLowerCase());
        if (entry) entry.values.push(v);
        else merged.set(k.toLowerCase(), { name: k, values: [v] });
      }
      for (const { name, values } of merged.values()) res.setHeader(name, values.length === 1 ? values[0] : values);
      const bodiless = out.status === 204 || out.status === 304;
      if (!bodiless && !merged.has('content-length')) res.setHeader('Content-Length', out.body.length);
      res.statusCode = out.status;
      if (method === 'HEAD' || bodiless) res.end();
      else res.end(out.body);
    }

    const responseText = looksText(headerValue(out.headers, 'content-type'), out.body);
    captured.response = {
      status: out.status,
      headers: out.headers,
      ...encode(out.body, responseText, RESPONSE_CAPTURE_LIMIT),
      size: out.body.length,
      truncated: out.body.length > RESPONSE_CAPTURE_LIMIT,
      durationMs: Math.round(performance.now() - started),
    };
    this.record(s, captured);
  }

  private async forward(base: string, captured: MockCapturedRequest, body: Buffer): Promise<Outgoing> {
    const url = forwardUrl(base, captured.url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`Upstream did not answer within ${FORWARD_TIMEOUT_MS / 1000} s`)), FORWARD_TIMEOUT_MS);
    try {
      const headers = replayableHeaders(captured.headers).filter(([k]) => k.toLowerCase() !== 'accept-encoding');
      const res = await undiciFetch(url, {
        method: captured.method,
        headers,
        body: captured.method === 'GET' || captured.method === 'HEAD' ? undefined : body,
        redirect: 'manual',
        signal: controller.signal,
      });
      const buf = Buffer.from(await res.arrayBuffer());
      const outHeaders: [string, string][] = [];
      res.headers.forEach((v, k) => {
        if (!STRIP_UPSTREAM.has(k) && k !== 'set-cookie') outHeaders.push([k, v]);
      });
      for (const cookie of res.headers.getSetCookie()) outHeaders.push(['set-cookie', cookie]);
      return { status: res.status, headers: outHeaders, body: buf };
    } catch (err) {
      throw new Error(errorMessage(err));
    } finally {
      clearTimeout(timer);
    }
  }

  private record(s: ServerState, captured: MockCapturedRequest): void {
    s.log.push(captured);
    if (s.log.length > s.definition.logLimit) s.log.splice(0, s.log.length - s.definition.logLimit);
    for (const w of [...s.waiters]) if (w.match(captured)) w.resolve(captured);
    this.notify(s, 'requests');
    this.schedulePersist(s);
  }

  private notify(s: ServerState, reason: MockChangeReason): void {
    const host = s.host;
    if (!host) return;
    const payload = { workspaceId: s.workspace.id, serverId: s.definition.id, reason };
    if (reason !== 'requests') {
      host.emit('mock.changed', payload);
      return;
    }
    // Coalesce bursts: one event per 50 ms is plenty for a live list.
    if (s.emitTimer) return;
    s.emitTimer = setTimeout(() => {
      s.emitTimer = null;
      host.emit('mock.changed', payload);
    }, 50);
  }

  private schedulePersist(s: ServerState): void {
    s.dirty = true;
    if (s.persistTimer) return;
    s.persistTimer = setTimeout(() => {
      s.persistTimer = null;
      void this.flush(s);
    }, 1000);
    s.persistTimer.unref();
  }

  private flush(s: ServerState): Promise<void> {
    if (s.persistTimer) {
      clearTimeout(s.persistTimer);
      s.persistTimer = null;
    }
    if (!s.dirty) return s.persisting;
    s.dirty = false;
    const snapshot = s.log.slice();
    s.persisting = s.persisting.then(() => s.workspace.store.writeLocal(logName(s.definition.id), snapshot)).catch(() => undefined);
    return s.persisting;
  }
}
