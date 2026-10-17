import { QuiverError, REDIRECT_STATUSES, nextRequest, type ApiRequest, type ApiResponse, type HttpMethod, type RedirectHop, type RequestBody, type SendOptions, type WireRequest } from '@quiver/core';
import { Agent, fetch as undiciFetch, type Dispatcher } from 'undici';

export interface PreparedRequest {
  method: HttpMethod;
  url: string;
  headers: [string, string][];
  body: string | Buffer | null;
  bodyPreview: string | null;
}

const TEXT_TYPES = /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded|graphql|yaml|x-yaml|ld\+json|problem\+json)|.*\+(json|xml))/i;

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

/** Turn an already variable-resolved request into what goes on the wire. */
export function prepareRequest(req: ApiRequest): PreparedRequest {
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

  let body: string | Buffer | null = null;
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
        const parts: string[] = [];
        for (const f of req.body.fields) {
          if (!f.enabled || !f.key.trim()) continue;
          parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${f.key.trim()}"\r\n\r\n${f.value}\r\n`);
        }
        body = Buffer.from(parts.join('') + `--${boundary}--\r\n`, 'utf8');
        bodyPreview = parts.join('') + `--${boundary}--`;
        headers.push(['Content-Type', `multipart/form-data; boundary=${boundary}`]);
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

/**
 * Send what `prepareRequest` built. Redirects are followed here rather than by fetch, so every hop
 * is known (status, headers, time) and the browser rules apply: see `nextRequest`. Aborting
 * `signal` stops the send, also while the body downloads, with REQUEST_CANCELLED.
 */
export async function sendPrepared(prepared: PreparedRequest, options: SendOptions, signal?: AbortSignal): Promise<ApiResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Timed out after ${options.timeoutMs} ms`)), options.timeoutMs);
  const onCancel = () => controller.abort(new Error('Cancelled'));
  if (signal?.aborted) onCancel();
  else signal?.addEventListener('abort', onCancel, { once: true });
  const started = performance.now();
  let current: WireRequest<string | Buffer> = { method: prepared.method, url: prepared.url, headers: prepared.headers, body: prepared.body };
  const redirects: RedirectHop[] = [];

  try {
    for (;;) {
      const hopStarted = performance.now();
      const res = await undiciFetch(current.url, {
        method: current.method,
        headers: current.headers,
        body: current.body ?? undefined,
        redirect: 'manual',
        signal: controller.signal,
        dispatcher: options.insecure ? getInsecureAgent() : undefined,
      });
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
      const { buffer, truncated } = await readBody(res.body, options.maxBodyBytes);
      const total = performance.now() - started;
      const contentType = res.headers.get('content-type');
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
        sent: { method: prepared.method, url: prepared.url, headers: prepared.headers, bodyPreview: prepared.bodyPreview },
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
    signal?.removeEventListener('abort', onCancel);
  }
}

interface ByteStreamLike {
  getReader(): { read(): Promise<{ done: boolean; value?: unknown }>; cancel(): Promise<void> };
}

async function readBody(stream: ByteStreamLike | null, limit: number): Promise<{ buffer: Buffer; truncated: boolean }> {
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
  }
  return { buffer: Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength))), truncated };
}
