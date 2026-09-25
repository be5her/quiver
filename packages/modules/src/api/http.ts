import { QuiverError, type ApiRequest, type ApiResponse, type HttpMethod, type SendOptions } from '@quiver/core';
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

export async function sendPrepared(prepared: PreparedRequest, options: SendOptions): Promise<ApiResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Timed out after ${options.timeoutMs} ms`)), options.timeoutMs);
  const started = performance.now();

  try {
    const res = await undiciFetch(prepared.url, {
      method: prepared.method,
      headers: prepared.headers,
      body: prepared.body ?? undefined,
      redirect: options.followRedirects ? 'follow' : 'manual',
      signal: controller.signal,
      dispatcher: options.insecure ? getInsecureAgent() : undefined,
    });
    const ttfb = performance.now() - started;

    const { buffer, truncated } = await readBody(res.body, options.maxBodyBytes);
    const total = performance.now() - started;

    const headers: [string, string][] = [];
    res.headers.forEach((value, key) => headers.push([key, value]));
    const contentType = res.headers.get('content-type');
    const isText = contentType ? TEXT_TYPES.test(contentType) : !buffer.subarray(0, 512).includes(0);

    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      url: res.url || prepared.url,
      headers,
      body: isText ? buffer.toString('utf8') : buffer.toString('base64'),
      bodyEncoding: isText ? 'utf8' : 'base64',
      contentType,
      size: buffer.length,
      truncated,
      timings: { total, ttfb },
      sent: { method: prepared.method, url: prepared.url, headers: prepared.headers, bodyPreview: prepared.bodyPreview },
    };
  } catch (err) {
    const cause = (err as { cause?: Error }).cause;
    const message = cause?.message ? `${(err as Error).message}: ${cause.message}` : (err as Error).message;
    throw new QuiverError('REQUEST_FAILED', message, { url: prepared.url });
  } finally {
    clearTimeout(timer);
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
