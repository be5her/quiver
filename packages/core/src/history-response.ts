import type { ApiResponse, HistoryEntry, HistoryResponse } from './models/api';
import { REDACTED, scrubSecrets } from './redact';

/** Responses larger than this are not kept in the history; the entry says so. */
export const MAX_HISTORY_RESPONSE_BYTES = 256 * 1024;

/**
 * The response as the history keeps it: status, headers, content type and body, with Set-Cookie
 * values masked and secrets the request resolved to scrubbed from the body. Undefined when the body
 * is too big to keep (or the response streamed).
 */
export function toHistoryResponse(response: ApiResponse, secretValues: string[] = []): HistoryResponse | undefined {
  if (response.streamId || response.size > MAX_HISTORY_RESPONSE_BYTES) return undefined;
  return {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers.map(([key, value]) => [key, key.toLowerCase() === 'set-cookie' ? maskCookie(value) : value]),
    contentType: response.contentType,
    body: response.bodyEncoding === 'utf8' ? scrubSecrets(response.body, secretValues) : response.body,
    bodyEncoding: response.bodyEncoding,
    truncated: response.truncated,
  };
}

/** `sid=abc; Path=/` → `sid=••••; Path=/`: the name and attributes say what was set, the value is a credential. */
function maskCookie(header: string): string {
  const semi = header.indexOf(';');
  const pair = semi < 0 ? header : header.slice(0, semi);
  const eq = pair.indexOf('=');
  if (eq < 0) return header;
  return `${pair.slice(0, eq + 1)}${REDACTED}${semi < 0 ? '' : header.slice(semi)}`;
}

/** A kept response as the response pane shows one, with what the history does not keep left empty. */
export function responseFromHistory(entry: Pick<HistoryEntry, 'url' | 'method' | 'durationMs' | 'response'>): ApiResponse | null {
  const r = entry.response;
  if (!r) return null;
  const size = r.bodyEncoding === 'base64' ? Math.floor((r.body.length * 3) / 4) : new TextEncoder().encode(r.body).length;
  return {
    ok: r.status >= 200 && r.status < 300,
    status: r.status,
    statusText: r.statusText,
    url: entry.url,
    headers: r.headers,
    body: r.body,
    bodyEncoding: r.bodyEncoding,
    contentType: r.contentType,
    size,
    truncated: r.truncated,
    timings: { total: entry.durationMs ?? 0, ttfb: entry.durationMs ?? 0, download: 0 },
    redirects: [],
    setCookies: r.headers.filter(([key]) => key.toLowerCase() === 'set-cookie').map(([, value]) => value),
    sent: { method: entry.method, url: entry.url, headers: [], bodyPreview: null },
  };
}
