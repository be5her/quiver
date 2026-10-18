import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import {
  QuiverError,
  REDIRECT_STATUSES,
  baseName,
  contentTypeFor,
  mergeCookieHeader,
  nextRequest,
  type ApiRequest,
  type ApiResponse,
  type HttpMethod,
  type JarCookie,
  type RedirectHop,
  type RequestBody,
  type SendOptions,
  type StreamKind,
  type WireRequest,
} from '@quiver/core';
import { Agent, fetch as undiciFetch, type Dispatcher } from 'undici';

/** A body read from files as it is sent, so a large upload never sits in memory. Opened again for each redirect hop. */
export interface StreamBody {
  /** Bytes in total, sent as Content-Length. */
  length: number;
  open(): AsyncIterable<Uint8Array>;
}

export type WireBody = string | Buffer | StreamBody;

export function isStreamBody(body: WireBody | null | undefined): body is StreamBody {
  return typeof body === 'object' && body !== null && !Buffer.isBuffer(body) && 'open' in body;
}

/** A cookie jar for one send: what each hop carries, and what each answer sets (redirects too). */
export interface CookieHooks {
  cookiesFor(url: string): Pick<JarCookie, 'name' | 'value'>[];
  store(url: string, setCookies: string[]): void;
}

/** The headers with the jar's cookies merged into the Cookie header; a name the request sets keeps its value. */
function withJarCookies(headers: [string, string][], cookies: Pick<JarCookie, 'name' | 'value'>[]): [string, string][] {
  if (!cookies.length) return headers;
  const at = headers.findIndex(([k]) => k.toLowerCase() === 'cookie');
  const merged = mergeCookieHeader(at >= 0 ? headers[at][1] : null, cookies);
  if (merged === null) return headers;
  if (at < 0) return [...headers, ['Cookie', merged]];
  return headers.map((h, i) => (i === at ? [h[0], merged] : h));
}

/** Where a request's files are read from, and whether the caller is an agent (kept inside the project). */
export interface FileAccess {
  baseDir: string;
  agent: boolean;
}

/** A file a request names, resolved against the project folder; agents may only reach inside it. */
async function resolveFile(files: FileAccess, given: string, what: string): Promise<{ abs: string; size: number }> {
  const trimmed = given.trim();
  if (!trimmed) throw new QuiverError('INVALID_INPUT', `Pick a file for ${what}`);
  const abs = path.isAbsolute(trimmed) ? path.normalize(trimmed) : path.resolve(files.baseDir, trimmed);
  if (files.agent) {
    const back = path.relative(files.baseDir, abs);
    if (!back || back.startsWith('..') || path.isAbsolute(back)) throw new QuiverError('INVALID_INPUT', `Agents may only send files inside the project folder; ${trimmed} is outside it`);
  }
  const stat = await fs.stat(abs).catch(() => null);
  if (!stat) throw new QuiverError('INVALID_INPUT', `The file ${trimmed} for ${what} does not exist`);
  if (!stat.isFile()) throw new QuiverError('INVALID_INPUT', `${trimmed} for ${what} is not a file`);
  return { abs, size: stat.size };
}

/** A multipart header value: quotes and line breaks percent-encoded, as browsers do. */
function quoted(value: string): string {
  return value.replace(/"/g, '%22').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

export interface PreparedRequest {
  method: HttpMethod;
  url: string;
  headers: [string, string][];
  /** Null when there is no body, or when files were only described (no `FileAccess`). */
  body: WireBody | null;
  bodyPreview: string | null;
}

const TEXT_TYPES = /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded|graphql|yaml|x-yaml|ld\+json|problem\+json|x-ndjson|ndjson|jsonl|json-seq)|.*\+(json|xml))/i;

function hasHeader(headers: [string, string][], name: string): boolean {
  const lower = name.toLowerCase();
  return headers.some(([k]) => k.toLowerCase() === lower);
}

function appendQuery(url: string, entries: [string, string][]): string {
  if (!entries.length) return url;
  const qs = entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  if (url.includes('?')) return url.endsWith('?') || url.endsWith('&') ? url + qs : `${url}&${qs}`;
  return `${url}?${qs}`;
}

export interface GraphqlPayload {
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
}

/** The JSON payload of a GraphQL request. Variables are JSON text and must be an object when given. */
export function graphqlPayload(body: Extract<RequestBody, { type: 'graphql' }>): GraphqlPayload {
  const payload: GraphqlPayload = { query: body.query };
  const text = body.variables.trim();
  if (text) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new QuiverError('INVALID_INPUT', `GraphQL variables must be valid JSON: ${(err as Error).message}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new QuiverError('INVALID_INPUT', 'GraphQL variables must be a JSON object');
    payload.variables = parsed as Record<string, unknown>;
  }
  if (body.operationName?.trim()) payload.operationName = body.operationName.trim();
  return payload;
}

/**
 * Turn an already variable-resolved request into what goes on the wire. Files (multipart file fields
 * and binary bodies) are read through `files`; without it they are only described in the preview,
 * as curl export needs.
 */
export async function prepareRequest(req: ApiRequest, files?: FileAccess): Promise<PreparedRequest> {
  const headers: [string, string][] = req.headers.filter((h) => h.enabled && h.key.trim()).map((h) => [h.key.trim(), h.value]);
  const query: [string, string][] = req.params.filter((p) => p.enabled && p.key.trim()).map((p) => [p.key.trim(), p.value]);

  switch (req.auth.type) {
    case 'bearer':
      if (!hasHeader(headers, 'authorization')) headers.push(['Authorization', `Bearer ${req.auth.token}`]);
      break;
    case 'basic':
      if (!hasHeader(headers, 'authorization')) {
        const encoded = Buffer.from(`${req.auth.username}:${req.auth.password}`, 'utf8').toString('base64');
        headers.push(['Authorization', `Basic ${encoded}`]);
      }
      break;
    case 'apikey':
      if (req.auth.in === 'query') query.push([req.auth.key, req.auth.value]);
      else headers.push([req.auth.key, req.auth.value]);
      break;
    default:
      break;
  }

  let body: WireBody | null = null;
  let bodyPreview: string | null = null;
  if (req.body.type === 'graphql') {
    // GraphQL over HTTP: JSON by POST, or query parameters for GET.
    const payload = graphqlPayload(req.body);
    if (req.method === 'GET' || req.method === 'HEAD') {
      query.push(['query', payload.query]);
      if (payload.variables) query.push(['variables', JSON.stringify(payload.variables)]);
      if (payload.operationName) query.push(['operationName', payload.operationName]);
    } else {
      body = JSON.stringify(payload);
      bodyPreview = body;
      if (!hasHeader(headers, 'content-type')) headers.push(['Content-Type', 'application/json']);
    }
    if (!hasHeader(headers, 'accept')) headers.push(['Accept', 'application/graphql-response+json, application/json']);
    return { method: req.method, url: appendQuery(req.url.trim(), query), headers, body, bodyPreview };
  }
  const canHaveBody = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  if (canHaveBody) {
    switch (req.body.type) {
      case 'json':
        body = req.body.content;
        if (!hasHeader(headers, 'content-type')) headers.push(['Content-Type', 'application/json']);
        break;
      case 'text':
        body = req.body.content;
        if (!hasHeader(headers, 'content-type')) headers.push(['Content-Type', 'text/plain']);
        break;
      case 'xml':
        body = req.body.content;
        if (!hasHeader(headers, 'content-type')) headers.push(['Content-Type', 'application/xml']);
        break;
      case 'urlencoded': {
        const params = new URLSearchParams();
        for (const f of req.body.fields) if (f.enabled && f.key.trim()) params.append(f.key.trim(), f.value);
        body = params.toString();
        if (!hasHeader(headers, 'content-type')) headers.push(['Content-Type', 'application/x-www-form-urlencoded']);
        break;
      }
      case 'form': {
        const boundary = `----QuiverBoundary${Math.random().toString(16).slice(2)}`;
        // Text parts become buffers; a file part is its header, the file read as it is sent, and a line break.
        const chunks: (Buffer | { abs: string; size: number })[] = [];
        const preview: string[] = [];
        for (const f of req.body.fields) {
          if (!f.enabled || !f.key.trim()) continue;
          const name = quoted(f.key.trim());
          if (f.kind === 'file') {
            const fileName = f.fileName?.trim() || baseName(f.value.trim());
            const type = f.contentType?.trim() || contentTypeFor(fileName);
            const head = `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${quoted(fileName)}"\r\nContent-Type: ${type}\r\n\r\n`;
            if (files) {
              const found = await resolveFile(files, f.value, `the form field ${f.key.trim()}`);
              chunks.push(Buffer.from(head, 'utf8'), found, Buffer.from('\r\n'));
              preview.push(`${head}<file ${fileName}, ${found.size} bytes>\r\n`);
            } else {
              preview.push(`${head}<file ${f.value.trim()}>\r\n`);
            }
          } else {
            const part = `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${f.value}\r\n`;
            chunks.push(Buffer.from(part, 'utf8'));
            preview.push(part);
          }
        }
        chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
        bodyPreview = preview.join('') + `--${boundary}--`;
        const hasFiles = req.body.fields.some((f) => f.enabled && f.key.trim() && f.kind === 'file');
        if (!hasFiles) body = Buffer.concat(chunks as Buffer[]);
        else if (files) {
          const parts = chunks;
          body = {
            length: parts.reduce((n, c) => n + (Buffer.isBuffer(c) ? c.length : c.size), 0),
            async *open() {
              for (const c of parts) {
                if (Buffer.isBuffer(c)) yield c;
                else for await (const piece of createReadStream(c.abs)) yield piece as Buffer;
              }
            },
          };
        }
        headers.push(['Content-Type', `multipart/form-data; boundary=${boundary}`]);
        break;
      }
      case 'binary': {
        const given = req.body.path.trim();
        if (!hasHeader(headers, 'content-type')) headers.push(['Content-Type', req.body.contentType?.trim() || contentTypeFor(given)]);
        if (files) {
          const found = await resolveFile(files, given, 'the body');
          body = { length: found.size, open: () => createReadStream(found.abs) as AsyncIterable<Uint8Array> };
          bodyPreview = `<file ${baseName(given)}, ${found.size} bytes>`;
        } else {
          bodyPreview = `<file ${given}>`;
        }
        break;
      }
      default:
        break;
    }
    if (bodyPreview === null && typeof body === 'string') bodyPreview = body;
  }

  return { method: req.method, url: appendQuery(req.url.trim(), query), headers, body, bodyPreview };
}

let insecureAgent: Dispatcher | null = null;
function getInsecureAgent(): Dispatcher {
  insecureAgent ??= new Agent({ connect: { rejectUnauthorized: false } });
  return insecureAgent;
}

/** Redirects followed before giving up, as browsers do. */
export const MAX_REDIRECTS = 20;

function headerList(headers: { forEach(cb: (value: string, key: string) => void): void }): [string, string][] {
  const list: [string, string][] = [];
  headers.forEach((value, key) => list.push([key, value]));
  return list;
}

/** How a body is read: whole, with progress, or handed over as a stream. */
export interface BodyHooks {
  /** Bytes received so far, while a whole body downloads. */
  onProgress?(received: number): void;
  /**
   * Takes over the body of an event stream, or of any response when `options.stream` is set: the
   * send returns the head at once and `chunks` yields the body as text until the server closes it
   * or `signal` (the send's) is aborted. Without it, every body is read whole.
   */
  onStream?(kind: StreamKind, chunks: AsyncGenerator<string>): void;
}

/**
 * Send what `prepareRequest` built. Redirects are followed here rather than by fetch, so every hop
 * is known (status, headers, time) and the browser rules apply: see `nextRequest`. Aborting
 * `signal` stops the send, also while the body downloads, with REQUEST_CANCELLED. The timeout
 * covers the whole download, or, for a streamed body, the wait for the response's head.
 */
export async function sendPrepared(prepared: PreparedRequest, options: SendOptions, signal?: AbortSignal, cookies?: CookieHooks, body?: BodyHooks): Promise<ApiResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Timed out after ${options.timeoutMs} ms`)), options.timeoutMs);
  const onCancel = () => controller.abort(new Error('Cancelled'));
  if (signal?.aborted) onCancel();
  else signal?.addEventListener('abort', onCancel, { once: true });
  const started = performance.now();
  let current: WireRequest<WireBody> = { method: prepared.method, url: prepared.url, headers: prepared.headers, body: prepared.body };
  const redirects: RedirectHop[] = [];
  /** The first hop's headers as they went out, jar cookies included: what `sent` shows. */
  let firstHeaders: [string, string][] | null = null;
  /** Set when the body was handed to `onStream`, which then owns the cancel listener. */
  let streaming = false;

  try {
    for (;;) {
      const hopStarted = performance.now();
      const stream = isStreamBody(current.body) ? current.body : null;
      const hopHeaders = cookies ? withJarCookies(current.headers, cookies.cookiesFor(current.url)) : current.headers;
      firstHeaders ??= hopHeaders;
      const res = await undiciFetch(current.url, {
        method: current.method,
        headers: stream && !hopHeaders.some(([k]) => k.toLowerCase() === 'content-length') ? [...hopHeaders, ['Content-Length', String(stream.length)]] : hopHeaders,
        body: stream ? stream.open() : ((current.body as string | Buffer | null) ?? undefined),
        ...(stream ? { duplex: 'half' as const } : {}),
        redirect: 'manual',
        signal: controller.signal,
        dispatcher: options.insecure ? getInsecureAgent() : undefined,
      });
      cookies?.store(current.url, res.headers.getSetCookie());
      const location = res.headers.get('location');
      const next = options.followRedirects && REDIRECT_STATUSES.has(res.status) && location ? nextRequest(current, res.status, location) : null;
      if (next) {
        if (redirects.length >= MAX_REDIRECTS) {
          await res.body?.cancel();
          throw new QuiverError('REQUEST_FAILED', `Stopped after ${MAX_REDIRECTS} redirects`, { url: prepared.url, redirects: redirects.map((r) => r.url) });
        }
        redirects.push({ method: current.method, url: current.url, status: res.status, statusText: res.statusText, location: next.url, headers: headerList(res.headers), durationMs: performance.now() - hopStarted });
        await res.body?.cancel();
        current = next;
        continue;
      }
      const ttfb = performance.now() - started;
      const contentType = res.headers.get('content-type');
      const kind: StreamKind | null = body?.onStream && res.body ? (/^text\/event-stream\b/i.test(contentType ?? '') ? 'sse' : options.stream ? 'lines' : null) : null;
      if (kind && res.body && body?.onStream) {
        streaming = true;
        clearTimeout(timer);
        const reader = res.body.getReader();
        const chunks = async function* (): AsyncGenerator<string> {
          const decoder = new TextDecoder();
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              yield decoder.decode(value, { stream: true });
            }
            const rest = decoder.decode();
            if (rest) yield rest;
          } finally {
            signal?.removeEventListener('abort', onCancel);
            await reader.cancel().catch(() => undefined);
          }
        };
        body.onStream(kind, chunks());
        return {
          ok: res.ok,
          status: res.status,
          statusText: res.statusText,
          url: current.url,
          headers: headerList(res.headers),
          body: '',
          bodyEncoding: 'utf8',
          contentType,
          size: 0,
          truncated: false,
          timings: { total: ttfb, ttfb, download: 0 },
          redirects,
          setCookies: res.headers.getSetCookie(),
          sent: { method: prepared.method, url: prepared.url, headers: firstHeaders ?? prepared.headers, bodyPreview: prepared.bodyPreview },
          streamKind: kind,
        };
      }
      const { buffer, truncated } = await readBody(res.body, options.maxBodyBytes, body?.onProgress);
      const total = performance.now() - started;
      const isText = contentType ? TEXT_TYPES.test(contentType) : !buffer.subarray(0, 512).includes(0);

      return {
        ok: res.ok,
        status: res.status,
        statusText: res.statusText,
        url: current.url,
        headers: headerList(res.headers),
        body: isText ? buffer.toString('utf8') : buffer.toString('base64'),
        bodyEncoding: isText ? 'utf8' : 'base64',
        contentType,
        size: buffer.length,
        truncated,
        timings: { total, ttfb, download: total - ttfb },
        redirects,
        setCookies: res.headers.getSetCookie(),
        sent: { method: prepared.method, url: prepared.url, headers: firstHeaders ?? prepared.headers, bodyPreview: prepared.bodyPreview },
      };
    }
  } catch (err) {
    if (signal?.aborted) throw new QuiverError('REQUEST_CANCELLED', 'Cancelled', { url: prepared.url });
    if (err instanceof QuiverError) throw err;
    const cause = (err as { cause?: Error }).cause;
    const message = cause?.message ? `${(err as Error).message}: ${cause.message}` : (err as Error).message;
    throw new QuiverError('REQUEST_FAILED', message, { url: current.url });
  } finally {
    clearTimeout(timer);
    if (!streaming) signal?.removeEventListener('abort', onCancel);
  }
}

interface ByteStreamLike {
  getReader(): { read(): Promise<{ done: boolean; value?: unknown }>; cancel(): Promise<void> };
}

async function readBody(stream: ByteStreamLike | null, limit: number, onProgress?: (received: number) => void): Promise<{ buffer: Buffer; truncated: boolean }> {
  if (!stream) return { buffer: Buffer.alloc(0), truncated: false };
  const chunks: Uint8Array[] = [];
  let received = 0;
  let truncated = false;
  const reader = stream.getReader();
  for (;;) {
    const { done, value: raw } = await reader.read();
    if (done) break;
    const value = raw as Uint8Array | undefined;
    if (!value) continue;
    if (received + value.byteLength > limit) {
      chunks.push(value.subarray(0, limit - received));
      received = limit;
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
    received += value.byteLength;
    onProgress?.(received);
  }
  return { buffer: Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength))), truncated };
}
