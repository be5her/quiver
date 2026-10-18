import type { ApiResponse, HistoryEntry, HistoryResponse } from './models/api';
import { REDACTED, scrubResponse } from './redact';

/** Responses larger than this are not kept in the history; the entry says so. */
export const MAX_HISTORY_RESPONSE_BYTES = 256 * 1024;
/** Entries the history keeps; the oldest go when the log is tidied. */
export const MAX_HISTORY_ENTRIES = 1000;
/** The newest entries that keep their response; older ones keep everything else. */
export const HISTORY_RESPONSES_KEPT = 200;

/**
 * The history pruned: the newest `maxEntries` kept, responses only on the newest `responsesKept`
 * of them. `entries` is newest first, as the log is read. `changed` says whether anything went.
 */
export function pruneHistory(entries: HistoryEntry[], limits = { maxEntries: MAX_HISTORY_ENTRIES, responsesKept: HISTORY_RESPONSES_KEPT }): { entries: HistoryEntry[]; changed: boolean } {
  let changed = entries.length > limits.maxEntries;
  const kept = entries.slice(0, limits.maxEntries).map((entry, i) => {
    if (i < limits.responsesKept || entry.response === undefined) return entry;
    changed = true;
    const { response: _dropped, ...rest } = entry;
    return rest;
  });
  return { entries: kept, changed };
}

/**
 * The response as the history keeps it: status, headers, content type and body, with Set-Cookie
 * values masked and the secrets the request resolved to (and secret captures read) scrubbed from
 * the headers and the body. Undefined when the body is too big to keep (or the response streamed).
 */
export function toHistoryResponse(response: ApiResponse, secretValues: string[] = []): HistoryResponse | undefined {
  if (response.streamId || response.size > MAX_HISTORY_RESPONSE_BYTES) return undefined;
  const scrubbed = scrubResponse(response, { values: secretValues });
  return {
    status: response.status,
    statusText: response.statusText,
    headers: scrubbed.headers.map(([key, value]) => [key, key.toLowerCase() === 'set-cookie' ? maskCookie(value) : value]),
    contentType: response.contentType,
    body: scrubbed.body,
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
