import { newId } from './ids';
import { newApiRequest, type ApiRequest } from './models/api';

/**
 * A quick request lives only in its tab, the way a curl command lives in a terminal: it is sent
 * like any other request and kept in the history, but never written to a collection. Its id says
 * so, and a send of it is recorded with no `requestId`, since there is no saved request to tie it to.
 */
export const QUICK_REQUEST_PREFIX = 'quick-';
export const QUICK_REQUEST_NAME = 'Quick request';

export function isQuickRequestId(id: string | null | undefined): boolean {
  return Boolean(id?.startsWith(QUICK_REQUEST_PREFIX));
}

/** A new, empty quick request: GET, no auth, at the top level. */
export function newQuickRequest(partial: Partial<ApiRequest> = {}): ApiRequest {
  return newApiRequest({ name: QUICK_REQUEST_NAME, ...partial, id: `${QUICK_REQUEST_PREFIX}${newId()}` });
}

/** Whether pasted text is a curl command rather than a URL: it starts with `curl` or `curl.exe` (a path in front allowed) and an argument. */
export function looksLikeCurl(text: string): boolean {
  return /^\s*(?![a-z][\w+.-]*:\/\/)(?:[^\s{}]*[\\/])?curl(?:\.exe)?\s+\S/i.test(text);
}

/**
 * The request a pasted curl command describes, in place of what the request held: its method, URL,
 * params, headers, body and auth. What curl does not describe stays: the id, the name, the
 * collection, the notes, the captures, the checks and the send settings. A request that inherits
 * its auth keeps inheriting when the command carries none, so pasting into a request inside a
 * collection still gets the collection's auth.
 */
export function applyCurl(request: ApiRequest, parsed: ApiRequest): ApiRequest {
  return {
    ...request,
    method: parsed.method,
    url: parsed.url,
    params: parsed.params,
    headers: parsed.headers,
    body: parsed.body,
    auth: parsed.auth.type === 'none' && request.auth.type === 'inherit' ? request.auth : parsed.auth,
  };
}
