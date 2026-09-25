import { z } from 'zod';
import { newId, nowIso } from '../ids';
import { KeyValueSchema, RequestAuthSchema, type RequestAuth } from './api';

export const RealtimeKindSchema = z.enum(['websocket', 'sse']);
export type RealtimeKind = z.infer<typeof RealtimeKindSchema>;

/** A message kept with a WebSocket connection, ready to send again. */
export const RealtimeSavedMessageSchema = z.object({
  id: z.string(),
  name: z.string().default(''),
  body: z.string().default(''),
});
export type RealtimeSavedMessage = z.infer<typeof RealtimeSavedMessageSchema>;

/** A WebSocket or Server-Sent Events connection saved with the project. */
export const RealtimeConnectionSchema = z.object({
  id: z.string(),
  name: z.string().default('Connection'),
  kind: RealtimeKindSchema.default('websocket'),
  /** `ws://`, `wss://`, `http://` or `https://`; variables allowed. */
  url: z.string().default(''),
  headers: z.array(KeyValueSchema).default([]),
  auth: RequestAuthSchema.default({ type: 'none' }),
  /** WebSocket: subprotocols offered on the handshake. */
  protocols: z.array(z.string()).default([]),
  /** SSE: request method and body, for servers that take a subscription document by POST. */
  method: z.enum(['GET', 'POST']).default('GET'),
  body: z.string().default(''),
  /** Reconnect after a drop; SSE honours `retry:` and resumes with Last-Event-ID. */
  reconnect: z.boolean().default(true),
  autoConnect: z.boolean().default(false),
  /** Accept self-signed certificates. */
  insecure: z.boolean().default(false),
  /** WebSocket: saved messages. */
  messages: z.array(RealtimeSavedMessageSchema).default([]),
  logLimit: z.number().int().min(10).max(5000).default(500),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type RealtimeConnection = z.infer<typeof RealtimeConnectionSchema>;

/** Every field optional and without defaults, so a partial update only touches what it names. */
export const RealtimeConnectionDraftSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  kind: RealtimeKindSchema.optional(),
  url: z.string().optional(),
  headers: z.array(KeyValueSchema).optional(),
  auth: RequestAuthSchema.optional(),
  protocols: z.array(z.string()).optional(),
  method: z.enum(['GET', 'POST']).optional(),
  body: z.string().optional(),
  reconnect: z.boolean().optional(),
  autoConnect: z.boolean().optional(),
  insecure: z.boolean().optional(),
  messages: z.array(RealtimeSavedMessageSchema).optional(),
  logLimit: z.number().int().min(10).max(5000).optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});
export type RealtimeConnectionDraft = z.infer<typeof RealtimeConnectionDraftSchema>;

export type RealtimeStatus = 'disconnected' | 'connecting' | 'open' | 'reconnecting';

export interface RealtimeConnectionSummary extends RealtimeConnection {
  status: RealtimeStatus;
  error: string | null;
  connectedAt: string | null;
  messageCount: number;
  lastMessageAt: string | null;
  /** WebSocket: the subprotocol the server picked, once open. */
  protocol: string | null;
  /** SSE: the last event id seen, sent back as Last-Event-ID on reconnect. */
  lastEventId: string | null;
}

export type RealtimeDirection = 'in' | 'out' | 'system';
export type RealtimeMessageKind = 'text' | 'binary' | 'event' | 'open' | 'close' | 'error' | 'info';

export interface RealtimeMessage {
  id: string;
  connectionId: string;
  at: string;
  direction: RealtimeDirection;
  kind: RealtimeMessageKind;
  /** SSE event name (`message` when the server sent none). */
  event: string | null;
  /** SSE event id. */
  eventId: string | null;
  data: string;
  encoding: 'utf8' | 'base64';
  size: number;
  truncated: boolean;
}

export function newRealtimeConnection(partial: Partial<RealtimeConnection> = {}): RealtimeConnection {
  const ts = nowIso();
  return RealtimeConnectionSchema.parse({ id: newId(), createdAt: ts, updatedAt: ts, ...partial });
}

export function newSavedMessage(partial: Partial<RealtimeSavedMessage> = {}): RealtimeSavedMessage {
  return { id: newId(), name: '', body: '', ...partial };
}

/** `http(s)://` becomes `ws(s)://`; a bare host gets `ws://`. */
export function toWebSocketUrl(url: string): string {
  const trimmed = url.trim();
  if (/^wss?:\/\//i.test(trimmed)) return trimmed;
  if (/^https:\/\//i.test(trimmed)) return `wss://${trimmed.slice(8)}`;
  if (/^http:\/\//i.test(trimmed)) return `ws://${trimmed.slice(7)}`;
  return `ws://${trimmed}`;
}

/** `ws(s)://` becomes `http(s)://`; a bare host gets `http://`. */
export function toHttpUrl(url: string): string {
  const trimmed = url.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^wss:\/\//i.test(trimmed)) return `https://${trimmed.slice(6)}`;
  if (/^ws:\/\//i.test(trimmed)) return `http://${trimmed.slice(5)}`;
  return `http://${trimmed}`;
}

/** Base64 of UTF-8 text, in Node and in the browser alike. */
function base64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** Add the auth of a connection to its headers, or to the URL for a query API key. */
export function applyAuth(auth: RequestAuth, headers: [string, string][], url: string): { headers: [string, string][]; url: string } {
  const out = headers.slice();
  const has = (name: string) => out.some(([k]) => k.toLowerCase() === name);
  switch (auth.type) {
    case 'bearer':
      if (!has('authorization')) out.push(['Authorization', `Bearer ${auth.token}`]);
      return { headers: out, url };
    case 'basic':
      if (!has('authorization')) out.push(['Authorization', `Basic ${base64Utf8(`${auth.username}:${auth.password}`)}`]);
      return { headers: out, url };
    case 'apikey': {
      if (auth.in === 'header') {
        out.push([auth.key, auth.value]);
        return { headers: out, url };
      }
      const joiner = url.includes('?') ? (url.endsWith('?') || url.endsWith('&') ? '' : '&') : '?';
      return { headers: out, url: `${url}${joiner}${encodeURIComponent(auth.key)}=${encodeURIComponent(auth.value)}` };
    }
    default:
      return { headers: out, url };
  }
}

// ---------- Server-Sent Events ----------

export interface SseEvent {
  event: string;
  data: string;
  id: string | null;
  /** Reconnection delay the server asked for, in ms, when a `retry:` line was part of this event. */
  retry: number | null;
}

export interface SseParser {
  /** Feed a chunk of the stream; returns every event completed by it. */
  push(chunk: string): SseEvent[];
  /** Last event id seen so far (the value to send back as Last-Event-ID). */
  readonly lastEventId: string | null;
  /** Last `retry:` hint seen, in ms; it applies even when sent in a block of its own. */
  readonly retryMs: number | null;
}

/**
 * Incremental parser for `text/event-stream`, following the WHATWG event stream format:
 * lines end with CR, LF or CRLF, `data:` lines accumulate joined by LF, a blank line dispatches,
 * `:` starts a comment, an unknown field is ignored, and an event with no data is dropped.
 */
export function createSseParser(): SseParser {
  let buffer = '';
  let data: string[] = [];
  let eventName = '';
  let lastEventId: string | null = null;
  let pendingId: string | null = null;
  let retry: number | null = null;
  let retryMs: number | null = null;
  let first = true;

  const dispatch = (): SseEvent | null => {
    const out =
      data.length === 0
        ? null
        : { event: eventName || 'message', data: data.join('\n'), id: pendingId ?? lastEventId, retry };
    data = [];
    eventName = '';
    retry = null;
    return out;
  };

  const field = (line: string): void => {
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const name = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    switch (name) {
      case 'data':
        data.push(value);
        break;
      case 'event':
        eventName = value;
        break;
      case 'id':
        if (!value.includes('\0')) {
          pendingId = value;
          lastEventId = value;
        }
        break;
      case 'retry':
        if (/^\d+$/.test(value)) {
          retry = Number.parseInt(value, 10);
          retryMs = retry;
        }
        break;
      default:
        break;
    }
  };

  return {
    get lastEventId() {
      return lastEventId;
    },
    get retryMs() {
      return retryMs;
    },
    push(chunk: string): SseEvent[] {
      if (first) {
        first = false;
        if (chunk.charCodeAt(0) === 0xfeff) chunk = chunk.slice(1);
      }
      buffer += chunk;
      const events: SseEvent[] = [];
      for (;;) {
        const match = /\r\n|\r|\n/.exec(buffer);
        if (!match) break;
        // A lone CR at the very end may be the first half of CRLF: wait for more.
        if (match[0] === '\r' && match.index === buffer.length - 1) break;
        const line = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        if (line === '') {
          const ev = dispatch();
          if (ev) events.push(ev);
          pendingId = null;
        } else {
          field(line);
        }
      }
      return events;
    },
  };
}

/** One-line description for lists: `WS` or `SSE` plus the host. */
export function describeConnection(conn: Pick<RealtimeConnection, 'kind' | 'url'>): string {
  const label = conn.kind === 'sse' ? 'SSE' : 'WS';
  const host = conn.url.replace(/^[a-z]+:\/\//i, '').split(/[/?#]/)[0] || conn.url;
  return `${label} ${host}`.trim();
}
