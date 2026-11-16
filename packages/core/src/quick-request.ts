import type { CurlReading } from './curl';
import { newId } from './ids';
import { newApiRequest, type ApiRequest, type RequestOptions } from './models/api';

/**
 * A quick request lives only in its tab, the way a curl command lives in a terminal: it is sent
 * like any other request and kept in the history, but never written to a collection. Its id says
 * so, and a send of it is recorded with no `requestId`, since there is no saved request to tie it to.
 */
export const QUICK_REQUEST_PREFIX = 'quick-';
export const QUICK_REQUEST_NAME = 'Quick request';
/** A history entry opened again in a tab of its own: unsaved, like a quick request. */
export const HISTORY_DRAFT_PREFIX = 'history-';

export function isQuickRequestId(id: string | null | undefined): boolean {
  return Boolean(id?.startsWith(QUICK_REQUEST_PREFIX));
}

/**
 * Whether an id is one the UI gives a request that lives only in a tab: a quick request or a
 * history entry opened again. No new saved request may have such an id.
 */
export function isUnsavedRequestId(id: string | null | undefined): boolean {
  return Boolean(id && (id.startsWith(QUICK_REQUEST_PREFIX) || id.startsWith(HISTORY_DRAFT_PREFIX)));
}

/** A new, empty quick request: GET, no auth, at the top level. */
export function newQuickRequest(partial: Partial<ApiRequest> = {}): ApiRequest {
  return newApiRequest({ name: QUICK_REQUEST_NAME, ...partial, id: `${QUICK_REQUEST_PREFIX}${newId()}` });
}

/** Whether pasted text is a curl command rather than a URL: it starts with `curl` or `curl.exe` (a path in front allowed) and an argument. */
export function looksLikeCurl(text: string): boolean {
  return /^\s*(?![a-z][\w+.-]*:\/\/)(?:[^\s{}]*[\\/])?curl(?:\.exe)?\s+\S/i.test(text);
}

/** The send options a curl command decides: whether the TLS check is skipped, whether redirects are followed, the timeout. */
const CURL_OPTIONS = ['insecure', 'followRedirects', 'timeoutMs'] as const;

/**
 * The request a pasted curl command describes, in place of what the request held: its method, URL,
 * params, headers, body and auth, and the TLS check, redirects and timeout its options set. What curl
 * does not describe stays: the id, the collection, the notes, the captures, the checks and the other
 * settings, and the name unless it is still a quick request's (then it is named after the command).
 * A request that inherits its auth keeps inheriting when the command carries none, so pasting into a
 * request inside a collection still gets the collection's auth.
 */
export function applyCurl(request: ApiRequest, reading: Pick<CurlReading, 'request' | 'options'>): ApiRequest {
  const parsed = reading.request;
  const options: RequestOptions = { ...request.options };
  for (const key of CURL_OPTIONS) delete options[key];
  Object.assign(options, reading.options);
  const next: ApiRequest = {
    ...request,
    name: request.name === QUICK_REQUEST_NAME ? parsed.name : request.name,
    method: parsed.method,
    url: parsed.url,
    params: parsed.params,
    headers: parsed.headers,
    body: parsed.body,
    auth: parsed.auth.type === 'none' && request.auth.type === 'inherit' ? request.auth : parsed.auth,
    options,
  };
  if (!Object.keys(options).length) delete next.options;
  return next;
}

/**
 * The tabs a workspace gets back after a restart: those of unsaved requests are dropped (they hold
 * nothing that was stored), and the active tab falls back to the first one when it was among them.
 */
export function restorableTabs<T extends { id: string; type: string; data?: Record<string, unknown> }>(tabs: T[], activeTabId: string | null): { tabs: T[]; activeTabId: string | null } {
  const kept = tabs.filter((t) => !(t.type === 'api.request' && isUnsavedRequestId(String(t.data?.['id'] ?? ''))));
  return { tabs: kept, activeTabId: activeTabId && kept.some((t) => t.id === activeTabId) ? activeTabId : (kept[0]?.id ?? null) };
}
