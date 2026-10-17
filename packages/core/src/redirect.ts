import type { HttpMethod } from './models/api';

export const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** A request as it goes on the wire, with whatever body type the sender uses. */
export interface WireRequest<B> {
  method: HttpMethod;
  url: string;
  headers: [string, string][];
  body: B | null;
}

const BODY_HEADERS = new Set(['content-type', 'content-length', 'content-encoding', 'content-language', 'content-location', 'transfer-encoding']);
/** Credentials that belong to the origin they were sent to. */
const ORIGIN_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie']);

/**
 * The request a redirect leads to, following browsers: 303 turns everything but HEAD into a GET,
 * 301 and 302 turn a POST into a GET, and a method changed this way drops the body and its headers;
 * 307 and 308 repeat the request as it was. Credentials (Authorization, Proxy-Authorization, Cookie)
 * are dropped when the redirect leaves the origin. Null when `location` cannot be read as a URL.
 */
export function nextRequest<B>(request: WireRequest<B>, status: number, location: string): WireRequest<B> | null {
  let target: URL;
  let from: URL;
  try {
    from = new URL(request.url);
    target = new URL(location, from);
  } catch {
    return null;
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return null;
  const toGet = (status === 303 && request.method !== 'HEAD') || ((status === 301 || status === 302) && request.method === 'POST');
  const crossOrigin = target.origin !== from.origin;
  const headers = request.headers.filter(([name]) => {
    const lower = name.toLowerCase();
    if (lower === 'host') return false;
    if (toGet && BODY_HEADERS.has(lower)) return false;
    if (crossOrigin && ORIGIN_HEADERS.has(lower)) return false;
    return true;
  });
  return { method: toGet ? 'GET' : request.method, url: target.toString(), headers, body: toGet ? null : request.body };
}
