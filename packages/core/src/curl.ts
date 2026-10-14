import { keyValue, newApiRequest, type ApiRequest, type HttpMethod, type KeyValue, type RequestAuth } from './models/api';
import { SHELL_DIALECT_LABELS, ShellSyntaxError, detectShellDialect, tokenizeShellDialect, type ShellDialect, type ShellToken } from './shell';

/** Split a shell command line into argv, honoring single/double quotes and backslash-newline. */
export function tokenizeShell(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let hasToken = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === '\\' && quote === '"' && i + 1 < input.length) {
        current += input[++i];
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      hasToken = true;
      continue;
    }
    if (ch === '\\') {
      const next = input[i + 1];
      if (next === '\n' || next === '\r') {
        i += next === '\r' && input[i + 2] === '\n' ? 2 : 1;
        continue;
      }
      if (next !== undefined) {
        current += next;
        i++;
        hasToken = true;
      }
      continue;
    }
    if (/\s/.test(ch)) {
      if (hasToken) tokens.push(current);
      current = '';
      hasToken = false;
      continue;
    }
    current += ch;
    hasToken = true;
  }
  if (hasToken) tokens.push(current);
  return tokens;
}

const METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

export interface ParseCurlOptions {
  /** The shell the command was copied for. Detected from the text when omitted or 'auto'. */
  dialect?: ShellDialect | 'auto';
}

/** curl's short options, by the long name they stand for. */
const SHORT_OPTIONS: Record<string, string> = {
  X: 'request',
  H: 'header',
  b: 'cookie',
  u: 'user',
  A: 'user-agent',
  e: 'referer',
  d: 'data',
  F: 'form',
  G: 'get',
  I: 'head',
  T: 'upload-file',
  K: 'config',
  k: 'insecure',
  L: 'location',
  s: 'silent',
  S: 'show-error',
  v: 'verbose',
  i: 'include',
  f: 'fail',
  g: 'globoff',
  N: 'no-buffer',
  O: 'remote-name',
  J: 'remote-header-name',
  R: 'remote-time',
  n: 'netrc',
  j: 'junk-session-cookies',
  Z: 'parallel',
  '#': 'progress-bar',
  '0': 'http1.0',
  '4': 'ipv4',
  '6': 'ipv6',
  o: 'output',
  m: 'max-time',
  x: 'proxy',
  U: 'proxy-user',
  c: 'cookie-jar',
  w: 'write-out',
  D: 'dump-header',
  E: 'cert',
  C: 'continue-at',
  r: 'range',
  z: 'time-cond',
  Y: 'speed-limit',
  y: 'speed-time',
};

/** Options that take a value and do not change the request itself (output, network, TLS). */
const IGNORED_WITH_VALUE = new Set([
  'output', 'max-time', 'connect-timeout', 'proxy', 'proxy-user', 'noproxy', 'cookie-jar', 'write-out', 'dump-header', 'stderr', 'trace', 'trace-ascii',
  'cert', 'cert-type', 'key', 'key-type', 'pass', 'cacert', 'capath', 'ciphers', 'tls-max', 'pinnedpubkey', 'continue-at', 'range', 'time-cond',
  'speed-limit', 'speed-time', 'limit-rate', 'max-redirs', 'max-filesize', 'retry', 'retry-delay', 'retry-max-time', 'resolve', 'connect-to',
  'interface', 'dns-servers', 'local-port', 'keepalive-time', 'expect100-timeout', 'happy-eyeballs-timeout-ms', 'unix-socket', 'abstract-unix-socket',
  'proto', 'proto-redir', 'proto-default', 'proxy-header', 'output-dir', 'parallel-max', 'variable', 'netrc-file', 'aws-sigv4',
]);

/** Options without a value that do not change the request itself. */
const IGNORED_FLAGS = new Set([
  'insecure', 'location', 'location-trusted', 'silent', 'show-error', 'verbose', 'include', 'compressed', 'compressed-ssh', 'fail', 'fail-with-body',
  'fail-early', 'globoff', 'no-buffer', 'remote-name', 'remote-name-all', 'remote-header-name', 'remote-time', 'netrc', 'netrc-optional',
  'junk-session-cookies', 'parallel', 'progress-bar', 'no-progress-meter', 'http1.0', 'http1.1', 'http2', 'http2-prior-knowledge', 'http3', 'http3-only',
  'ipv4', 'ipv6', 'path-as-is', 'tcp-nodelay', 'tcp-fastopen', 'no-keepalive', 'no-sessionid', 'no-alpn', 'no-npn', 'ssl', 'ssl-reqd', 'ssl-no-revoke',
  'ssl-revoke-best-effort', 'ssl-allow-beast', 'tlsv1', 'tlsv1.0', 'tlsv1.1', 'tlsv1.2', 'tlsv1.3', 'sslv2', 'sslv3', 'proxy-insecure', 'proxytunnel',
  'disable', 'raw', 'tr-encoding', 'create-dirs', 'styled-output', 'retry-connrefused', 'retry-all-errors', 'basic', 'digest', 'ntlm', 'negotiate',
  'anyauth', 'disallow-username-in-url', 'false-start', 'cert-status', 'doh-insecure', 'xattr', 'suppress-connect-headers',
]);

/** Options that take the request, or part of it, from somewhere the import cannot reach. */
const UNSUPPORTED: Record<string, string> = {
  'upload-file': 'sends a file as the body',
  config: 'reads more options from a file',
  next: 'starts a second request, and only one request per command can be imported',
};

const HANDLED_WITH_VALUE = new Set([
  'url', 'request', 'header', 'cookie', 'user', 'user-agent', 'referer', 'data', 'data-ascii', 'data-binary', 'data-raw', 'data-urlencode', 'json',
  'form', 'form-string', 'oauth2-bearer',
]);
const HANDLED_FLAGS = new Set(['get', 'head']);

const takesValue = (name: string) => HANDLED_WITH_VALUE.has(name) || IGNORED_WITH_VALUE.has(name) || name in UNSUPPORTED;

/**
 * Convert a curl command into an ApiRequest. The command is tokenized with the rules of the shell
 * it was copied for (bash/zsh, cmd.exe or PowerShell, detected or given), then mapped with curl's
 * own option semantics. Anything that cannot be imported faithfully is an error naming the shell
 * and the position, so a corrupted request is never saved.
 */
export function parseCurl(command: string, options: ParseCurlOptions = {}): ApiRequest {
  const source = command.replace(/^﻿/, '').trim();
  const dialect = !options.dialect || options.dialect === 'auto' ? detectShellDialect(source) : options.dialect;
  const tokens = tokenizeShellDialect(source, dialect);
  const fail = (at: ShellToken, message: string) => new ShellSyntaxError(dialect, at.offset, message, source);

  if (!tokens.length || !/^(?:.*[\\/])?curl(?:\.exe)?$/i.test(tokens[0].value)) throw new Error('Command must start with "curl"');
  rejectStraySyntax(tokens, dialect, source);

  let url: ShellToken | null = null;
  let method: string | null = null;
  let head = false;
  let get = false;
  const headers: KeyValue[] = [];
  let cookieHeader: KeyValue | null = null;
  const cookies: string[] = [];
  let data: string | null = null;
  let urlencoded = false;
  let json = false;
  const form: KeyValue[] = [];
  let auth: RequestAuth = { type: 'none' };

  const addData = (text: string, separator: string) => {
    data = data === null ? text : data + separator + text;
  };
  const refuseFile = (flag: string, at: ShellToken) => {
    if (at.value.startsWith('@')) throw fail(at, `${flag} ${at.value} reads the body from a file, which cannot be imported (paste the content with --data-raw)`);
  };
  const addCookie = (value: string, key: string) => {
    if (!cookieHeader) {
      cookieHeader = keyValue(key, '');
      headers.push(cookieHeader);
    }
    cookies.push(value);
  };

  const applyValue = (name: string, flag: string, at: ShellToken) => {
    const value = at.value;
    switch (name) {
      case 'url':
        if (url) throw fail(at, `a second URL "${value}"; only one request per command can be imported`);
        url = at;
        break;
      case 'request':
        method = value.toUpperCase();
        break;
      case 'header': {
        if (value.startsWith('@')) throw fail(at, `${flag} ${value} reads headers from a file, which cannot be imported`);
        const colon = value.indexOf(':');
        if (colon > 0) {
          const key = value.slice(0, colon).trim();
          const headerValue = value.slice(colon + 1).trim();
          // "Name:" with nothing after it tells curl to drop that header.
          if (!headerValue) break;
          if (key.toLowerCase() === 'cookie') addCookie(headerValue, key);
          else headers.push(keyValue(key, headerValue));
        } else if (/^[^;\s]+;$/.test(value)) {
          // "Name;" sends the header with an empty value.
          headers.push(keyValue(value.slice(0, -1), ''));
        } else {
          throw fail(at, `"${value}" is not a header (expected "Name: value")`);
        }
        break;
      }
      case 'cookie': {
        const cookie = value.trim().replace(/[;\s]+$/, '');
        if (!cookie) break;
        if (!cookie.includes('=')) throw fail(at, `${flag} ${value} reads cookies from a file, which cannot be imported`);
        addCookie(cookie, 'Cookie');
        break;
      }
      case 'user': {
        const colon = value.indexOf(':');
        auth = { type: 'basic', username: colon < 0 ? value : value.slice(0, colon), password: colon < 0 ? '' : value.slice(colon + 1) };
        break;
      }
      case 'oauth2-bearer':
        auth = { type: 'bearer', token: value };
        break;
      case 'user-agent':
        headers.push(keyValue('User-Agent', value));
        break;
      case 'referer': {
        const referer = value.replace(/;auto$/, '');
        if (referer) headers.push(keyValue('Referer', referer));
        break;
      }
      case 'data':
      case 'data-ascii':
      case 'data-binary':
        refuseFile(flag, at);
        addData(value, '&');
        break;
      case 'data-raw':
        addData(value, '&');
        break;
      case 'data-urlencode':
        urlencoded = true;
        addData(encodeDataUrlencode(flag, at, fail), '&');
        break;
      case 'json':
        refuseFile(flag, at);
        json = true;
        // Several --json pieces are concatenated without a separator.
        addData(value, '');
        break;
      case 'form':
      case 'form-string': {
        const eq = value.indexOf('=');
        if (eq <= 0) throw fail(at, `${flag} needs name=content, got "${value}"`);
        form.push(keyValue(value.slice(0, eq), value.slice(eq + 1)));
        break;
      }
    }
  };

  let i = 1;
  const handle = (name: string, flag: string, at: ShellToken, inline: string | undefined) => {
    if (name in UNSUPPORTED) throw fail(at, `${flag} ${UNSUPPORTED[name]}, which cannot be imported`);
    if (takesValue(name)) {
      let valueToken: ShellToken;
      if (inline !== undefined) {
        valueToken = { value: inline, offset: at.offset };
      } else {
        const next = tokens[i++];
        if (!next) throw fail(at, `${flag} needs a value`);
        valueToken = next;
      }
      applyValue(name, flag, valueToken);
      return;
    }
    const known = HANDLED_FLAGS.has(name) || IGNORED_FLAGS.has(name) || (name.startsWith('no-') && IGNORED_FLAGS.has(name.slice(3)));
    if (!known) throw fail(at, `unknown curl option ${flag}`);
    if (inline !== undefined) throw fail(at, `${flag} takes no value`);
    if (name === 'get') get = true;
    if (name === 'head') head = true;
  };

  let endOfOptions = false;
  while (i < tokens.length) {
    const token = tokens[i++];
    const arg = token.value;
    if (endOfOptions || !arg.startsWith('-') || arg === '-') {
      applyValue('url', 'URL', token);
    } else if (arg === '--') {
      endOfOptions = true;
    } else if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = eq < 0 ? arg.slice(2) : arg.slice(2, eq);
      handle(name, `--${name}`, token, eq < 0 ? undefined : arg.slice(eq + 1));
    } else {
      // Short options can be bundled (-sSL) and take their value joined (-XPOST) or from the next argument.
      for (let k = 1; k < arg.length; k++) {
        const name = SHORT_OPTIONS[arg[k]];
        if (!name) throw fail(token, `unknown curl option -${arg[k]}`);
        if (takesValue(name)) {
          const rest = arg.slice(k + 1);
          handle(name, `-${arg[k]}`, token, rest === '' ? undefined : rest);
          break;
        }
        handle(name, `-${arg[k]}`, token, undefined);
      }
    }
  }

  // TypeScript cannot see the assignments made inside the closures above.
  const urlToken = url as ShellToken | null;
  const cookieKv = cookieHeader as KeyValue | null;
  let body = data as string | null;
  if (!urlToken) throw new Error('No URL found in curl command');
  if (form.length && body !== null) throw fail(urlToken, 'the command combines -F with -d, which curl refuses too');
  if (/^["'`^]|["'`^]$/.test(urlToken.value)) {
    throw fail(urlToken, `the URL ${urlToken.value} still contains shell quoting; is ${SHELL_DIALECT_LABELS[dialect]} the right shell?`);
  }

  let rawUrl = urlToken.value;
  if (get && body !== null) {
    rawUrl += (rawUrl.includes('?') ? '&' : '?') + body;
    body = null;
  }

  const req = newApiRequest();
  // curl never sends the fragment.
  const hash = rawUrl.indexOf('#');
  if (hash >= 0) rawUrl = rawUrl.slice(0, hash);
  const q = rawUrl.indexOf('?');
  req.url = q < 0 ? rawUrl : rawUrl.slice(0, q);
  if (q >= 0) {
    // Pull the query string into params so the editor shows it in the table, each key and value decoded once.
    for (const piece of rawUrl.slice(q + 1).split('&')) {
      if (!piece) continue;
      const eq = piece.indexOf('=');
      const key = decodeFormComponent(eq < 0 ? piece : piece.slice(0, eq));
      const value = decodeFormComponent(eq < 0 ? '' : piece.slice(eq + 1));
      if (key === null || value === null) throw fail(urlToken, `the query parameter "${piece}" has malformed %-encoding`);
      req.params.push(keyValue(key, value));
    }
  }

  if (cookieKv) cookieKv.value = cookies.join('; ');
  if (json) {
    const has = (name: string) => headers.some((h) => h.key.toLowerCase() === name);
    if (!has('content-type')) headers.push(keyValue('Content-Type', 'application/json'));
    if (!has('accept')) headers.push(keyValue('Accept', 'application/json'));
  }
  req.headers = headers;
  req.auth = auth;

  // Bearer token shorthand: an Authorization header becomes structured auth.
  const authIdx = req.headers.findIndex((h) => h.key.toLowerCase() === 'authorization');
  if (authIdx >= 0 && req.auth.type === 'none') {
    const value = req.headers[authIdx].value;
    if (/^bearer\s+/i.test(value)) {
      req.auth = { type: 'bearer', token: value.replace(/^bearer\s+/i, '') };
      req.headers.splice(authIdx, 1);
    }
  }

  if (form.length) {
    req.body = { type: 'form', fields: form };
  } else if (body !== null) {
    const contentType = req.headers.find((h) => h.key.toLowerCase() === 'content-type')?.value ?? '';
    const looksJson = json || /json/i.test(contentType) || /^\s*[[{]/.test(body);
    const formLike = urlencoded || /x-www-form-urlencoded/i.test(contentType) || /^[^=&\s]+=[^&]*(&[^=&\s]+=[^&]*)*$/.test(body);
    const fields = formLike ? parseUrlencoded(body) : null;
    if (looksJson && !urlencoded) req.body = { type: 'json', content: body };
    else if (fields) req.body = { type: 'urlencoded', fields };
    else req.body = { type: 'text', content: body };
  }

  const resolvedMethod = method ?? (head ? 'HEAD' : form.length || body !== null ? 'POST' : 'GET');
  if (!METHODS.includes(resolvedMethod as HttpMethod)) throw new Error(`Unsupported method ${resolvedMethod}`);
  req.method = resolvedMethod as HttpMethod;
  req.name = defaultRequestName(req);
  return req;
}

/** A line-continuation character left as an argument, or an argument still wrapped in cmd.exe's ^…^, means the wrong shell was assumed. */
function rejectStraySyntax(tokens: ShellToken[], dialect: ShellDialect, source: string): void {
  const owner: Record<string, ShellDialect> = { '^': 'cmd', '`': 'powershell', '\\': 'posix' };
  for (const token of tokens) {
    const { value } = token;
    if (value in owner) {
      throw new ShellSyntaxError(dialect, token.offset, `stray ${value} left as an argument; this looks like ${SHELL_DIALECT_LABELS[owner[value]]} syntax`, source);
    }
    if (dialect !== 'cmd' && value.length >= 2 && value.startsWith('^') && value.endsWith('^')) {
      throw new ShellSyntaxError(dialect, token.offset, `argument ${value} still carries cmd.exe ^ escapes; this looks like cmd.exe syntax`, source);
    }
  }
}

/** --data-urlencode's forms: content, =content and name=content (name@file and @file read files). */
function encodeDataUrlencode(flag: string, at: ShellToken, fail: (at: ShellToken, message: string) => Error): string {
  const value = at.value;
  const eq = value.indexOf('=');
  if (eq < 0 && value.includes('@')) throw fail(at, `${flag} ${value} reads the value from a file, which cannot be imported`);
  if (eq < 0) return encodeURIComponent(value);
  if (eq === 0) return encodeURIComponent(value.slice(1));
  return `${value.slice(0, eq)}=${encodeURIComponent(value.slice(eq + 1))}`;
}

/** application/x-www-form-urlencoded decoding of one key or value; null when the %-encoding is malformed. */
function decodeFormComponent(s: string): string | null {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return null;
  }
}

function parseUrlencoded(body: string): KeyValue[] | null {
  const fields: KeyValue[] = [];
  for (const piece of body.split('&')) {
    if (!piece) continue;
    const eq = piece.indexOf('=');
    const key = decodeFormComponent(eq < 0 ? piece : piece.slice(0, eq));
    const value = decodeFormComponent(eq < 0 ? '' : piece.slice(eq + 1));
    if (key === null || value === null) return null;
    fields.push(keyValue(key, value));
  }
  return fields;
}

export function defaultRequestName(req: Pick<ApiRequest, 'method' | 'url'>): string {
  try {
    // A leading variable usually stands for the origin, e.g. {{baseUrl}}/users.
    const probe = req.url.trim().replace(/^\{\{[^}]+\}\}/, 'http://placeholder').replace(/\{\{[^}]+\}\}/g, 'x');
    const u = new URL(probe);
    const path = u.pathname === '/' ? u.host : u.pathname;
    return `${req.method} ${path}`;
  } catch {
    return `${req.method} ${req.url || 'request'}`.trim();
  }
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface CurlInput {
  method: HttpMethod;
  url: string;
  headers: [string, string][];
  body: string | null;
  bodyType?: 'raw' | 'urlencoded' | 'form';
  formFields?: [string, string][];
}

/** Render a resolved request as a curl command. Uses single quotes, works in bash and zsh. */
export function toCurl(input: CurlInput): string {
  const lines: string[] = [`curl -X ${input.method} ${shellQuote(input.url)}`];
  for (const [k, v] of input.headers) lines.push(`-H ${shellQuote(`${k}: ${v}`)}`);
  if (input.bodyType === 'form' && input.formFields) {
    for (const [k, v] of input.formFields) lines.push(`-F ${shellQuote(`${k}=${v}`)}`);
  } else if (input.body !== null && input.body !== '') {
    lines.push(`--data-raw ${shellQuote(input.body)}`);
  }
  return lines.join(' \\\n  ');
}
