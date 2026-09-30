import type { ApiRequest, ApiResponse, HistoryEntry, KeyValue, RequestAuth } from './models/api';
import { findVariableSpans } from './variables';

/** What a masked credential reads as. The same marker environments use for secrets shown to agents. */
export const REDACTED = '••••••••';

/** Shorter values are not scrubbed out of a text: they would match half of it. */
const MIN_SCRUB_LENGTH = 4;

const SECRET_NAME = /^(proxy-)?authorization$|^cookie$|^key$|^sig$|token|secret|passw(or)?d|api[-_]?key|access[-_]?key|signature|credential/i;

/** Whether a header or parameter of this name carries a credential: `Authorization`, `X-API-Key`, `access_token`, `password`. */
export function isSecretName(name: string): boolean {
  return SECRET_NAME.test(name.trim());
}

/**
 * Masks the literal text of a credential. `{{variable}}` references stay as they are:
 * they name a secret rather than hold one, and a request that uses them can be sent again.
 */
export function redactLiteral(value: string): string {
  const mask = (literal: string) => (literal.trim() ? REDACTED : literal);
  let out = '';
  let at = 0;
  for (const span of findVariableSpans(value)) {
    out += mask(value.slice(at, span.from)) + value.slice(span.from, span.to);
    at = span.to;
  }
  return out + mask(value.slice(at));
}

/** An `Authorization` value keeps its scheme, so `Bearer ••••••••` still says what kind of credential was sent. */
function redactAuthorization(value: string): string {
  const scheme = /^(\s*[A-Za-z][\w-]*[ \t]+)(\S[\s\S]*)$/.exec(value);
  return scheme ? scheme[1] + redactLiteral(scheme[2]) : redactLiteral(value);
}

function redactHeaderValue(name: string, value: string): string {
  return /^(proxy-)?authorization$/i.test(name.trim()) ? redactAuthorization(value) : redactLiteral(value);
}

function redactAuth(auth: RequestAuth): RequestAuth {
  switch (auth?.type) {
    case 'bearer':
      return { ...auth, token: redactLiteral(auth.token ?? '') };
    case 'basic':
      return { ...auth, password: redactLiteral(auth.password ?? '') };
    case 'apikey':
      return { ...auth, value: redactLiteral(auth.value ?? '') };
    default:
      return auth;
  }
}

function redactRows(rows: KeyValue[], redact: (name: string, value: string) => string | null): KeyValue[] {
  if (!Array.isArray(rows)) return rows;
  return rows.map((row) => {
    const value = redact(row.key ?? '', row.value ?? '');
    return value === null || value === row.value ? row : { ...row, value };
  });
}

function decoded(text: string): string {
  try {
    return decodeURIComponent(text.replace(/\+/g, ' '));
  } catch {
    return text;
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Masks every occurrence of the given secret values in a text: as they are, URL-encoded and form-encoded.
 * Values of fewer than four characters are left alone.
 */
export function scrubSecrets(text: string, values: string[] = []): string {
  if (!text) return text;
  const secrets = [...new Set(values)].filter((v) => v.length >= MIN_SCRUB_LENGTH && v !== REDACTED).sort((a, b) => b.length - a.length);
  let out = text;
  for (const value of secrets) {
    const forms = new Set([value, encodeURIComponent(value), new URLSearchParams([['', value]]).toString().slice(1)]);
    for (const form of forms) out = out.replace(new RegExp(escapeRegExp(form), 'g'), REDACTED);
  }
  return out;
}

export interface RedactUrlOptions {
  /** Query parameters that carry a credential besides the ones named like one, e.g. the key of an API key sent in the query. */
  names?: string[];
  /** Secret values to mask wherever they appear, as they are or encoded. */
  values?: string[];
}

/**
 * Masks the credentials in a URL: the password before `@`, the values of query parameters named like a
 * credential (or listed in `names`), and any of the given secret values. Works on a URL that still has
 * `{{variables}}` in it as well as on a resolved one; the rest of the URL is left untouched.
 */
export function redactUrl(url: string, options: RedactUrlOptions = {}): string {
  if (!url) return url;
  const names = new Set((options.names ?? []).map((n) => n.trim().toLowerCase()).filter(Boolean));
  let out = url.replace(/^(\s*[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#@:]*:)([^/?#@]*)@/, (_whole, before: string, password: string) => `${before}${redactLiteral(password)}@`);

  const queryAt = out.indexOf('?');
  if (queryAt >= 0) {
    const hashAt = out.indexOf('#', queryAt);
    const query = out.slice(queryAt + 1, hashAt < 0 ? undefined : hashAt);
    const masked = query
      .split('&')
      .map((pair) => {
        const eq = pair.indexOf('=');
        if (eq < 0) return pair;
        const name = decoded(pair.slice(0, eq));
        return isSecretName(name) || names.has(name.trim().toLowerCase()) ? `${pair.slice(0, eq + 1)}${redactLiteral(pair.slice(eq + 1))}` : pair;
      })
      .join('&');
    out = out.slice(0, queryAt + 1) + masked + (hashAt < 0 ? '' : out.slice(hashAt));
  }

  return scrubSecrets(out, options.values);
}

/** The credential query parameters written into a URL itself: `?api_key=abc` holds the secret `abc`. */
function urlSecretValues(url: string): string[] {
  const queryAt = url.indexOf('?');
  if (queryAt < 0) return [];
  const out: string[] = [];
  for (const pair of url.slice(queryAt + 1).split('#')[0].split('&')) {
    const eq = pair.indexOf('=');
    if (eq > 0 && isSecretName(decoded(pair.slice(0, eq)))) out.push(decoded(pair.slice(eq + 1)));
  }
  return out;
}

/**
 * A request as it may be written to a log: the token, password or API key of its auth, the values of
 * credential headers (`Authorization`, `Cookie`, `X-API-Key` and the like) and of credential query
 * parameters, and a password in the URL are masked. Bodies and everything else stay as they are.
 */
export function redactRequest(request: ApiRequest): ApiRequest {
  if (!request || typeof request !== 'object') return request;
  const auth = redactAuth(request.auth);
  const keyInQuery = auth?.type === 'apikey' && auth.in === 'query' ? (auth.key ?? '').trim().toLowerCase() : null;
  return {
    ...request,
    url: typeof request.url === 'string' ? redactUrl(request.url, { names: keyInQuery ? [keyInQuery] : [] }) : request.url,
    headers: redactRows(request.headers, (name, value) => (isSecretName(name) ? redactHeaderValue(name, value) : null)),
    params: redactRows(request.params, (name, value) => (isSecretName(name) || name.trim().toLowerCase() === keyInQuery ? redactLiteral(value) : null)),
    auth,
  };
}

/**
 * The secret values a request resolved to: its auth's token, password and API key, and the values of its
 * credential headers and parameters, in the URL too. Pass the request after variable resolution.
 */
export function requestSecretValues(resolved: ApiRequest): string[] {
  const out: string[] = [];
  const auth = resolved.auth;
  if (auth.type === 'bearer') out.push(auth.token);
  if (auth.type === 'basic') out.push(auth.password);
  if (auth.type === 'apikey') out.push(auth.value);
  for (const header of resolved.headers) {
    if (!isSecretName(header.key)) continue;
    // Without the scheme: `Bearer abc` holds the secret `abc`.
    out.push(/^(proxy-)?authorization$/i.test(header.key.trim()) ? header.value.replace(/^\s*[A-Za-z][\w-]*[ \t]+/, '') : header.value);
  }
  for (const param of resolved.params) if (isSecretName(param.key)) out.push(param.value);
  out.push(...urlSecretValues(resolved.url));
  return out.map((v) => v.trim()).filter(Boolean);
}

/**
 * What went on the wire, as an agent may read it back: credential headers and parameters masked, and the
 * secret values in `known` masked wherever else they appear: in the URL, in other headers, in the body.
 */
export function redactSent(sent: ApiResponse['sent'], known: RedactUrlOptions = {}): ApiResponse['sent'] {
  return {
    ...sent,
    url: redactUrl(sent.url, known),
    headers: sent.headers.map(([name, value]): [string, string] => [name, isSecretName(name) ? redactHeaderValue(name, value) : scrubSecrets(value, known.values)]),
    bodyPreview: sent.bodyPreview === null ? null : scrubSecrets(sent.bodyPreview, known.values),
  };
}

/**
 * A history entry as it is stored: its request redacted, and its URL (the one that went on the wire, with
 * variables resolved) with credential parameters, a password and the secret values in `known` masked.
 * An error message can quote that URL, so the secret values are masked in it as well.
 * Redacting an entry twice changes nothing, so entries written before masking existed can be cleaned too.
 */
export function redactHistoryEntry(entry: HistoryEntry, known: RedactUrlOptions = {}): HistoryEntry {
  const request = redactRequest(entry.request);
  const auth = entry.request?.auth;
  const names = [...(known.names ?? []), ...(auth?.type === 'apikey' && auth.in === 'query' ? [auth.key ?? ''] : [])];
  return {
    ...entry,
    url: typeof entry.url === 'string' ? redactUrl(entry.url, { names, values: known.values }) : entry.url,
    error: typeof entry.error === 'string' ? scrubSecrets(entry.error, known.values) : entry.error,
    request,
  };
}
