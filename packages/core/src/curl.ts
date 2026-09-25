import { keyValue, newApiRequest, type ApiRequest, type HttpMethod } from './models/api';

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

/** Convert a curl command into an ApiRequest. Supports the flags developers actually paste. */
export function parseCurl(command: string): ApiRequest {
  const argv = tokenizeShell(command.trim());
  if (argv[0] !== 'curl') throw new Error('Command must start with "curl"');

  const req = newApiRequest();
  let method: HttpMethod | null = null;
  const bodyParts: string[] = [];
  let bodyIsForm = false;
  const formFields: { key: string; value: string }[] = [];

  const takeValue = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined) throw new Error(`Flag ${flag} needs a value`);
    return v;
  };

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '-X':
      case '--request': {
        method = takeValue(i, arg).toUpperCase() as HttpMethod;
        i++;
        break;
      }
      case '-H':
      case '--header': {
        const raw = takeValue(i, arg);
        i++;
        const idx = raw.indexOf(':');
        if (idx > 0) req.headers.push(keyValue(raw.slice(0, idx).trim(), raw.slice(idx + 1).trim()));
        break;
      }
      case '-d':
      case '--data':
      case '--data-raw':
      case '--data-binary':
      case '--data-ascii': {
        bodyParts.push(takeValue(i, arg));
        i++;
        break;
      }
      case '--data-urlencode': {
        bodyParts.push(takeValue(i, arg));
        i++;
        bodyIsForm = true;
        break;
      }
      case '-F':
      case '--form': {
        const raw = takeValue(i, arg);
        i++;
        const eq = raw.indexOf('=');
        formFields.push({ key: raw.slice(0, eq), value: raw.slice(eq + 1) });
        break;
      }
      case '-u':
      case '--user': {
        const [username = '', password = ''] = takeValue(i, arg).split(':', 2);
        i++;
        req.auth = { type: 'basic', username, password };
        break;
      }
      case '--url': {
        req.url = takeValue(i, arg);
        i++;
        break;
      }
      case '-A':
      case '--user-agent': {
        req.headers.push(keyValue('User-Agent', takeValue(i, arg)));
        i++;
        break;
      }
      case '-b':
      case '--cookie': {
        req.headers.push(keyValue('Cookie', takeValue(i, arg)));
        i++;
        break;
      }
      case '-e':
      case '--referer': {
        req.headers.push(keyValue('Referer', takeValue(i, arg)));
        i++;
        break;
      }
      case '-k':
      case '--insecure':
      case '-L':
      case '--location':
      case '-s':
      case '--silent':
      case '-S':
      case '--show-error':
      case '-v':
      case '--verbose':
      case '-i':
      case '--include':
      case '--compressed':
      case '-G':
      case '--get':
        break;
      case '-o':
      case '--output':
      case '-m':
      case '--max-time':
      case '-x':
      case '--proxy':
        i++;
        break;
      default: {
        if (!arg.startsWith('-') && !req.url) req.url = arg;
        break;
      }
    }
  }

  if (!req.url) throw new Error('No URL found in curl command');

  // Pull query string into params so the editor shows it in the table.
  const qIndex = req.url.indexOf('?');
  if (qIndex >= 0) {
    const search = req.url.slice(qIndex + 1);
    req.url = req.url.slice(0, qIndex);
    for (const [k, v] of new URLSearchParams(search)) req.params.push(keyValue(k, v));
  }

  // Bearer token shorthand: an Authorization header becomes structured auth.
  const authIdx = req.headers.findIndex((h) => h.key.toLowerCase() === 'authorization');
  if (authIdx >= 0 && req.auth.type === 'none') {
    const value = req.headers[authIdx].value;
    if (/^bearer\s+/i.test(value)) {
      req.auth = { type: 'bearer', token: value.replace(/^bearer\s+/i, '') };
      req.headers.splice(authIdx, 1);
    }
  }

  if (formFields.length) {
    req.body = { type: 'form', fields: formFields.map((f) => keyValue(f.key, f.value)) };
  } else if (bodyParts.length) {
    const joined = bodyParts.join('&');
    const contentType = req.headers.find((h) => h.key.toLowerCase() === 'content-type')?.value ?? '';
    const looksJson = /json/i.test(contentType) || /^\s*[[{]/.test(joined);
    if (looksJson && !bodyIsForm) {
      req.body = { type: 'json', content: joined };
    } else if (bodyIsForm || /x-www-form-urlencoded/i.test(contentType) || /^[^=&\s]+=[^&]*(&[^=&\s]+=[^&]*)*$/.test(joined)) {
      req.body = { type: 'urlencoded', fields: [...new URLSearchParams(joined)].map(([k, v]) => keyValue(k, v)) };
    } else {
      req.body = { type: 'text', content: joined };
    }
  }

  req.method = method ?? (req.body.type !== 'none' ? 'POST' : 'GET');
  if (!METHODS.includes(req.method)) throw new Error(`Unsupported method ${req.method}`);
  req.name = defaultRequestName(req);
  return req;
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
