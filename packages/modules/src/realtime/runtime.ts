import {
  QuiverError,
  createSseParser,
  newId,
  nowIso,
  toHttpUrl,
  toWebSocketUrl,
  type HostApi,
  type RealtimeConnection,
  type RealtimeConnectionSummary,
  type RealtimeMessage,
  type RealtimeStatus,
  type WorkspaceApi,
} from '@quiver/core';
import { Agent, WebSocket as UndiciWebSocket, fetch as undiciFetch, type Dispatcher } from 'undici';

/** Bytes of a message kept in the log; the rest is dropped but counted. */
const DATA_LIMIT = 256 * 1024;
/** How long `connect` waits for the handshake before returning a still-connecting summary. */
const OPEN_TIMEOUT_MS = 15_000;
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
const SSE_DEFAULT_RETRY_MS = 3000;

export type RealtimeChangeReason = 'status' | 'messages' | 'connections';

/** A connection after variable resolution and auth, ready to open. */
export interface ResolvedTarget {
  url: string;
  headers: [string, string][];
  body: string;
}

interface Waiter {
  match(message: RealtimeMessage): boolean;
  resolve(message: RealtimeMessage | null): void;
}

interface ConnState {
  workspace: WorkspaceApi;
  host: HostApi | null;
  definition: RealtimeConnection;
  target: ResolvedTarget | null;
  status: RealtimeStatus;
  error: string | null;
  connectedAt: string | null;
  protocol: string | null;
  lastEventId: string | null;
  /** SSE: reconnection delay the server asked for. */
  retryMs: number | null;
  /** Consecutive failed opens, for backoff. */
  attempts: number;
  /** Bumped on every open and disconnect so events of an old socket are ignored. */
  generation: number;
  socket: UndiciWebSocket | null;
  abort: AbortController | null;
  reconnectTimer: NodeJS.Timeout | null;
  manual: boolean;
  log: RealtimeMessage[];
  logLoaded: Promise<void> | null;
  waiters: Set<Waiter>;
  emitTimer: NodeJS.Timeout | null;
  persistTimer: NodeJS.Timeout | null;
  persisting: Promise<void>;
  dirty: boolean;
}

const logName = (connectionId: string) => `realtime-messages-${connectionId}`;

let insecureAgent: Dispatcher | null = null;
function getInsecureAgent(): Dispatcher {
  insecureAgent ??= new Agent({ connect: { rejectUnauthorized: false } });
  return insecureAgent;
}

function errorMessage(err: unknown, fallback = 'Connection failed'): string {
  const e = err as { message?: string; cause?: { message?: string; code?: string } } | undefined;
  const cause = e?.cause;
  const parts = [e?.message, cause?.message].filter((p): p is string => Boolean(p && p.trim()));
  if (cause?.code && !parts.some((p) => p.includes(cause.code!))) parts.push(cause.code);
  return parts.length ? [...new Set(parts)].join(': ') : fallback;
}

export class RealtimeRuntime {
  private readonly byWorkspace = new Map<string, Map<string, ConnState>>();

  private state(ws: WorkspaceApi, definition: RealtimeConnection): ConnState {
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
        target: null,
        status: 'disconnected',
        error: null,
        connectedAt: null,
        protocol: null,
        lastEventId: null,
        retryMs: null,
        attempts: 0,
        generation: 0,
        socket: null,
        abort: null,
        reconnectTimer: null,
        manual: false,
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

  private peek(workspaceId: string, connectionId: string): ConnState | undefined {
    return this.byWorkspace.get(workspaceId)?.get(connectionId);
  }

  private ensureLog(s: ConnState): Promise<void> {
    s.logLoaded ??= s.workspace.store
      .readLocal<RealtimeMessage[]>(logName(s.definition.id), [])
      .then((entries) => {
        if (!Array.isArray(entries)) return;
        const valid = entries.filter((e) => e && typeof e === 'object' && typeof e.id === 'string' && typeof e.at === 'string');
        s.log = [...valid, ...s.log].slice(-s.definition.logLimit);
      })
      .catch(() => undefined);
    return s.logLoaded;
  }

  async summary(ws: WorkspaceApi, definition: RealtimeConnection): Promise<RealtimeConnectionSummary> {
    const s = this.state(ws, definition);
    await this.ensureLog(s);
    if (s.status === 'disconnected') s.definition = definition;
    return {
      ...definition,
      status: s.status,
      error: s.error,
      connectedAt: s.connectedAt,
      messageCount: s.log.length,
      lastMessageAt: s.log.at(-1)?.at ?? null,
      protocol: s.protocol,
      lastEventId: s.lastEventId,
    };
  }

  /** Open the connection and wait for the handshake (or its failure), up to a limit. */
  async connect(ws: WorkspaceApi, host: HostApi, definition: RealtimeConnection, target: ResolvedTarget): Promise<RealtimeConnectionSummary> {
    const s = this.state(ws, definition);
    s.host = host;
    if (s.status === 'open' || s.status === 'connecting') return this.summary(ws, s.definition);
    this.clearReconnect(s);
    s.definition = definition;
    s.target = target;
    s.manual = false;
    s.attempts = 0;
    s.error = null;
    // A fresh connect starts over; only automatic reconnects resume with Last-Event-ID.
    s.lastEventId = null;
    s.retryMs = null;
    await this.ensureLog(s);
    await this.open(s);
    return this.summary(ws, s.definition);
  }

  async disconnect(ws: WorkspaceApi, connectionId: string): Promise<boolean> {
    const s = this.peek(ws.id, connectionId);
    if (!s) return false;
    const active = s.status !== 'disconnected';
    s.manual = true;
    this.clearReconnect(s);
    s.generation++;
    const socket = s.socket;
    const abort = s.abort;
    s.socket = null;
    s.abort = null;
    if (socket) {
      const closed = new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2000);
        socket.addEventListener(
          'close',
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
      try {
        if (socket.readyState === UndiciWebSocket.OPEN || socket.readyState === UndiciWebSocket.CONNECTING) socket.close(1000, 'Closed by user');
        else closed.catch(() => undefined);
      } catch {
        // already closing
      }
      if (socket.readyState !== UndiciWebSocket.CLOSED) await closed;
    }
    if (abort) abort.abort();
    if (active) this.record(s, system(s, 'close', 'Disconnected'));
    s.status = 'disconnected';
    s.connectedAt = null;
    s.protocol = null;
    this.notify(s, 'status');
    return active;
  }

  send(ws: WorkspaceApi, definition: RealtimeConnection, data: string, binary: boolean): RealtimeMessage {
    const s = this.state(ws, definition);
    if (definition.kind !== 'websocket') throw new QuiverError('INVALID_INPUT', 'Only WebSocket connections can send; an SSE connection only receives');
    if (!s.socket || s.status !== 'open') throw new QuiverError('REQUEST_FAILED', `Not connected${s.error ? `: ${s.error}` : ''}`);
    const payload = binary ? Buffer.from(data, 'base64') : data;
    s.socket.send(payload);
    const message = binary ? entry(s, 'out', 'binary', payload as Buffer) : entry(s, 'out', 'text', data);
    this.record(s, message);
    return message;
  }

  /** Take a saved definition into account; an open connection keeps running with what it was opened with. */
  async apply(ws: WorkspaceApi, host: HostApi, definition: RealtimeConnection): Promise<void> {
    const s = this.peek(ws.id, definition.id);
    if (!s) return;
    s.host = host;
    s.definition = definition;
    if (s.log.length > definition.logLimit) {
      s.log.splice(0, s.log.length - definition.logLimit);
      this.schedulePersist(s);
    }
    this.notify(s, 'connections');
  }

  async remove(ws: WorkspaceApi, connectionId: string): Promise<void> {
    const s = this.peek(ws.id, connectionId);
    if (!s) return;
    await this.disconnect(ws, connectionId);
    if (s.persistTimer) clearTimeout(s.persistTimer);
    s.persistTimer = null;
    s.dirty = false;
    s.log = [];
    for (const w of [...s.waiters]) w.resolve(null);
    await s.workspace.store.writeLocal(logName(connectionId), []).catch(() => undefined);
    this.byWorkspace.get(ws.id)?.delete(connectionId);
  }

  /** Oldest first, so the result reads as a transcript; `limit` keeps the newest ones. */
  async messages(
    ws: WorkspaceApi,
    definition: RealtimeConnection,
    opts: { limit: number; since?: string; direction?: RealtimeMessage['direction']; contains?: string; event?: string },
  ): Promise<RealtimeMessage[]> {
    const s = this.state(ws, definition);
    await this.ensureLog(s);
    let list = s.log;
    if (opts.since) list = list.filter((m) => m.at > opts.since!);
    if (opts.direction) list = list.filter((m) => m.direction === opts.direction);
    if (opts.event) list = list.filter((m) => m.event === opts.event);
    if (opts.contains) {
      const needle = opts.contains.toLowerCase();
      list = list.filter((m) => m.encoding === 'utf8' && m.data.toLowerCase().includes(needle));
    }
    return list.slice(-opts.limit);
  }

  async clear(ws: WorkspaceApi, definition: RealtimeConnection): Promise<number> {
    const s = this.state(ws, definition);
    await this.ensureLog(s);
    const count = s.log.length;
    s.log = [];
    this.schedulePersist(s);
    await this.flush(s);
    this.notify(s, 'messages');
    return count;
  }

  /** Resolves with the next recorded message the predicate accepts, or null after the timeout. */
  wait(ws: WorkspaceApi, definition: RealtimeConnection, match: (message: RealtimeMessage) => boolean, timeoutMs: number): Promise<RealtimeMessage | null> {
    const s = this.state(ws, definition);
    return new Promise((resolve) => {
      const waiter: Waiter = {
        match,
        resolve: (message) => {
          clearTimeout(timer);
          s.waiters.delete(waiter);
          resolve(message);
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
      await this.disconnect(ws, s.definition.id);
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

  // ---------- opening ----------

  private open(s: ConnState): Promise<void> {
    s.status = s.attempts > 0 ? 'reconnecting' : 'connecting';
    this.notify(s, 'status');
    return s.definition.kind === 'sse' ? this.openSse(s) : this.openSocket(s);
  }

  private openSocket(s: ConnState): Promise<void> {
    const def = s.definition;
    const target = s.target!;
    const gen = ++s.generation;
    let socket: UndiciWebSocket;
    try {
      socket = new UndiciWebSocket(toWebSocketUrl(target.url), {
        protocols: def.protocols.length ? def.protocols : undefined,
        headers: target.headers,
        dispatcher: def.insecure ? getInsecureAgent() : undefined,
      });
    } catch (err) {
      s.error = errorMessage(err, 'Invalid WebSocket URL');
      s.status = 'disconnected';
      this.record(s, system(s, 'error', s.error));
      this.notify(s, 'status');
      return Promise.resolve();
    }
    socket.binaryType = 'arraybuffer';
    s.socket = socket;
    return new Promise((resolve) => {
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(settle, OPEN_TIMEOUT_MS);
      socket.addEventListener('open', () => {
        if (gen !== s.generation) return;
        s.status = 'open';
        s.error = null;
        s.connectedAt = nowIso();
        s.protocol = socket.protocol || null;
        s.attempts = 0;
        this.record(s, system(s, 'open', `Connected${socket.protocol ? ` (protocol ${socket.protocol})` : ''}`));
        this.notify(s, 'status');
        settle();
      });
      socket.addEventListener('message', (ev) => {
        if (gen !== s.generation) return;
        const data = ev.data as string | ArrayBuffer;
        this.record(s, typeof data === 'string' ? entry(s, 'in', 'text', data) : entry(s, 'in', 'binary', Buffer.from(data)));
      });
      socket.addEventListener('error', (ev) => {
        if (gen !== s.generation) return;
        s.error = errorMessage((ev as { error?: unknown }).error ?? ev, `Could not connect to ${target.url}`);
        this.record(s, system(s, 'error', s.error));
      });
      socket.addEventListener('close', (ev) => {
        if (gen !== s.generation) return;
        s.socket = null;
        const wasOpen = s.status === 'open';
        if (!wasOpen && !s.error) s.error = ev.code === 1006 ? `Could not connect to ${target.url}` : `Closed before opening (${ev.code}${ev.reason ? ` ${ev.reason}` : ''})`;
        if (wasOpen) this.record(s, system(s, 'close', `Closed by server (${ev.code}${ev.reason ? ` ${ev.reason}` : ''})`));
        s.connectedAt = null;
        s.protocol = null;
        if (!s.manual && def.reconnect && ev.code !== 1000) this.scheduleReconnect(s, wasOpen);
        else s.status = 'disconnected';
        this.notify(s, 'status');
        settle();
      });
    });
  }

  private openSse(s: ConnState): Promise<void> {
    const def = s.definition;
    const target = s.target!;
    const gen = ++s.generation;
    const controller = new AbortController();
    s.abort = controller;
    const headers: [string, string][] = [...target.headers.filter(([k]) => !['accept', 'cache-control', 'last-event-id'].includes(k.toLowerCase()))];
    headers.push(['Accept', 'text/event-stream'], ['Cache-Control', 'no-cache']);
    if (s.lastEventId !== null) headers.push(['Last-Event-ID', s.lastEventId]);

    return new Promise((resolve) => {
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(settle, OPEN_TIMEOUT_MS);
      const fail = (message: string, retryable: boolean) => {
        if (gen !== s.generation) return;
        s.abort = null;
        s.error = message;
        this.record(s, system(s, 'error', message));
        if (retryable && !s.manual && def.reconnect) this.scheduleReconnect(s, false);
        else s.status = 'disconnected';
        this.notify(s, 'status');
        settle();
      };

      void (async () => {
        let res: Awaited<ReturnType<typeof undiciFetch>>;
        try {
          res = await undiciFetch(toHttpUrl(target.url), {
            method: def.method,
            headers,
            body: def.method === 'POST' ? target.body : undefined,
            signal: controller.signal,
            dispatcher: def.insecure ? getInsecureAgent() : undefined,
          });
        } catch (err) {
          if (controller.signal.aborted) return settle();
          return fail(errorMessage(err, `Could not connect to ${target.url}`), true);
        }
        if (gen !== s.generation) return settle();
        if (!res.ok) {
          const snippet = (await res.text().catch(() => '')).slice(0, 200);
          return fail(`HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}${snippet ? `: ${snippet}` : ''}`, res.status >= 500);
        }
        const contentType = res.headers.get('content-type') ?? '';
        if (!/text\/event-stream/i.test(contentType)) {
          await res.body?.cancel().catch(() => undefined);
          return fail(`Expected text/event-stream, got ${contentType || 'no content type'}`, false);
        }
        s.status = 'open';
        s.error = null;
        s.connectedAt = nowIso();
        s.attempts = 0;
        this.record(s, system(s, 'open', `Connected (HTTP ${res.status})`));
        this.notify(s, 'status');
        settle();

        const parser = createSseParser();
        const decoder = new TextDecoder();
        let streamError: string | null = null;
        try {
          const reader = res.body!.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (gen !== s.generation) return;
            for (const event of parser.push(decoder.decode(value as Uint8Array, { stream: true }))) {
              const message = entry(s, 'in', 'event', event.data);
              message.event = event.event;
              message.eventId = event.id;
              this.record(s, message);
            }
            if (parser.lastEventId !== null) s.lastEventId = parser.lastEventId;
            if (parser.retryMs !== null) s.retryMs = parser.retryMs;
          }
        } catch (err) {
          if (!controller.signal.aborted) streamError = errorMessage(err, 'Stream failed');
        }
        if (gen !== s.generation) return;
        s.abort = null;
        s.connectedAt = null;
        if (streamError) {
          s.error = streamError;
          this.record(s, system(s, 'error', streamError));
        } else {
          this.record(s, system(s, 'close', 'Stream ended by server'));
        }
        if (!s.manual && def.reconnect) this.scheduleReconnect(s, !streamError);
        else s.status = 'disconnected';
        this.notify(s, 'status');
      })();
    });
  }

  /** After a clean end wait what the server asked for (SSE) or a second; after a failure back off exponentially. */
  private scheduleReconnect(s: ConnState, cleanEnd: boolean): void {
    const base = s.definition.kind === 'sse' ? (s.retryMs ?? SSE_DEFAULT_RETRY_MS) : RECONNECT_MIN_MS;
    if (!cleanEnd) s.attempts++;
    const delay = Math.min(RECONNECT_MAX_MS, Math.max(base, cleanEnd ? 0 : RECONNECT_MIN_MS * 2 ** (s.attempts - 1)));
    s.status = 'reconnecting';
    this.record(s, system(s, 'info', `Reconnecting in ${delay >= 1000 ? `${(delay / 1000).toFixed(delay % 1000 ? 1 : 0)} s` : `${delay} ms`}`));
    s.reconnectTimer = setTimeout(() => {
      s.reconnectTimer = null;
      if (s.manual) return;
      void this.open(s);
    }, delay);
  }

  private clearReconnect(s: ConnState): void {
    if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
    s.reconnectTimer = null;
  }

  // ---------- log ----------

  private record(s: ConnState, message: RealtimeMessage): void {
    s.log.push(message);
    if (s.log.length > s.definition.logLimit) s.log.splice(0, s.log.length - s.definition.logLimit);
    for (const w of [...s.waiters]) if (w.match(message)) w.resolve(message);
    this.notify(s, 'messages');
    this.schedulePersist(s);
  }

  private notify(s: ConnState, reason: RealtimeChangeReason): void {
    const host = s.host;
    if (!host) return;
    const payload = { workspaceId: s.workspace.id, connectionId: s.definition.id, reason };
    if (reason !== 'messages') {
      host.emit('realtime.changed', payload);
      return;
    }
    if (s.emitTimer) return;
    s.emitTimer = setTimeout(() => {
      s.emitTimer = null;
      host.emit('realtime.changed', payload);
    }, 50);
  }

  private schedulePersist(s: ConnState): void {
    s.dirty = true;
    if (s.persistTimer) return;
    s.persistTimer = setTimeout(() => {
      s.persistTimer = null;
      void this.flush(s);
    }, 1000);
    s.persistTimer.unref();
  }

  private flush(s: ConnState): Promise<void> {
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

function entry(s: ConnState, direction: RealtimeMessage['direction'], kind: RealtimeMessage['kind'], data: string | Buffer): RealtimeMessage {
  const buffer = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const text = typeof data === 'string';
  const kept = buffer.subarray(0, DATA_LIMIT);
  return {
    id: newId(),
    connectionId: s.definition.id,
    at: nowIso(),
    direction,
    kind,
    event: null,
    eventId: null,
    data: text ? kept.toString('utf8') : kept.toString('base64'),
    encoding: text ? 'utf8' : 'base64',
    size: buffer.length,
    truncated: buffer.length > DATA_LIMIT,
  };
}

function system(s: ConnState, kind: 'open' | 'close' | 'error' | 'info', text: string): RealtimeMessage {
  return entry(s, 'system', kind, text);
}

export function isRealtimeStatus(value: string): value is RealtimeStatus {
  return ['disconnected', 'connecting', 'open', 'reconnecting'].includes(value);
}
