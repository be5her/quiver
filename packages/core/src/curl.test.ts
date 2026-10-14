import { describe, expect, it } from 'vitest';
import { parseCurl, toCurl, tokenizeShell } from './curl';
import type { ApiRequest } from './models/api';

describe('tokenizeShell', () => {
  it('handles quotes, escapes and line continuations', () => {
    expect(tokenizeShell(`curl -H 'a: b c' \\\n  --data "x \\"y\\"" url`)).toEqual([
      'curl',
      '-H',
      'a: b c',
      '--data',
      'x "y"',
      'url',
    ]);
  });
});

describe('parseCurl', () => {
  it('parses a typical JSON POST', () => {
    const req = parseCurl(`curl -X POST 'https://api.example.com/users?page=2' \\
      -H 'Content-Type: application/json' \\
      -H 'Authorization: Bearer abc123' \\
      --data-raw '{"name":"Ada"}'`);
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://api.example.com/users');
    expect(req.params).toMatchObject([{ key: 'page', value: '2' }]);
    expect(req.headers).toMatchObject([{ key: 'Content-Type', value: 'application/json' }]);
    expect(req.auth).toEqual({ type: 'bearer', token: 'abc123' });
    expect(req.body).toEqual({ type: 'json', content: '{"name":"Ada"}' });
    expect(req.name).toBe('POST /users');
  });

  it('infers POST from data and urlencoded bodies', () => {
    const req = parseCurl(`curl https://x.test/login -d 'user=a&pass=b'`);
    expect(req.method).toBe('POST');
    expect(req.body).toMatchObject({ type: 'urlencoded', fields: [{ key: 'user', value: 'a' }, { key: 'pass', value: 'b' }] });
  });

  it('parses basic auth and form fields', () => {
    const req = parseCurl(`curl -u me:secret -F 'file=@a.txt' -F 'note=hi' https://x.test/upload`);
    expect(req.auth).toEqual({ type: 'basic', username: 'me', password: 'secret' });
    expect(req.body).toMatchObject({ type: 'form', fields: [{ key: 'file', value: '@a.txt' }, { key: 'note', value: 'hi' }] });
  });

  it('names requests whose URL starts with a variable by path', () => {
    const req = parseCurl(`curl -X PUT '{{baseUrl}}/a?b=c'`);
    expect(req.name).toBe('PUT /a');
    expect(req.url).toBe('{{baseUrl}}/a');
  });

  it('rejects non-curl input', () => {
    expect(() => parseCurl('wget http://x')).toThrow();
  });
});

/** The request without ids and timestamps, for comparing imports of the same command in different shells. */
function shape(req: ApiRequest) {
  const kv = (list: { key: string; value: string }[]) => list.map((p) => [p.key, p.value]);
  const body = 'fields' in req.body ? { type: req.body.type, fields: kv(req.body.fields) } : req.body;
  return { method: req.method, url: req.url, params: kv(req.params), headers: kv(req.headers), auth: req.auth, body };
}

/** Chrome DevTools' "Copy as cURL (bash)" quoting (escapeStringPosix). */
function chromePosix(str: string): string {
  if (/[\0-\x1F\x7F-\x9F!]|'/.test(str)) {
    return `$'${str
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'")
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/[\0-\x1F\x7F-\x9F!]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)}'`;
  }
  return `'${str}'`;
}

/** Chrome DevTools' "Copy as cURL (cmd)" quoting (escapeStringWin). */
function chromeWin(str: string): string {
  return `^"${str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[^a-zA-Z0-9\s_\-:=+~'/.',?;()*`]/g, '^$&')
    .replace(/%(?=[a-zA-Z0-9_])/g, '%^')
    .replace(/\r?\n/g, '^\n\n')}^"`;
}

interface ChromeRequest {
  url: string;
  method?: string;
  headers: [string, string][];
  cookie?: string;
  body?: string;
}

/** Lay a request out the way Chrome does: one option per line, continued with \ or ^. */
function chromeCurl(r: ChromeRequest, shell: 'bash' | 'cmd'): string {
  const q = shell === 'bash' ? chromePosix : chromeWin;
  const parts = [`curl ${q(r.url)}`];
  if (r.method) parts.push(`-X ${q(r.method)}`);
  for (const [k, v] of r.headers) parts.push(`-H ${q(`${k}: ${v}`)}`);
  if (r.cookie) parts.push(`-b ${q(r.cookie)}`);
  if (r.body !== undefined) parts.push(`--data-raw ${q(r.body)}`);
  return parts.join(shell === 'bash' ? ' \\\n  ' : ' ^\n  ');
}

describe('parseCurl: shell dialects', () => {
  const cmdSample = [
    'curl --url ^"https://omnix.silqfi.xyz/x?merchantId=376^" ^',
    '  -H ^"accept: application/json^" ^',
    '  -H ^"sec-ch-ua: ^\\^"Chromium^\\^";v=^\\^"154^\\^"^" ^',
    '  --data-raw ^"null^"',
  ].join('\n');

  it('imports Chrome "Copy as cURL (cmd)" without leaving carets behind', () => {
    const req = parseCurl(cmdSample);
    expect(req.url).toBe('https://omnix.silqfi.xyz/x');
    expect(shape(req).params).toEqual([['merchantId', '376']]);
    expect(shape(req).headers).toEqual([
      ['accept', 'application/json'],
      ['sec-ch-ua', '"Chromium";v="154"'],
    ]);
    expect(req.body).toEqual({ type: 'text', content: 'null' });
    expect(req.method).toBe('POST');
  });

  it.each<[string, string, (req: ApiRequest) => unknown, unknown]>([
    ['cmd: escaped parentheses', 'curl x.test -H ^"user-agent: Mozilla/5.0 ^(Windows NT 10.0^)^"', (r) => r.headers[0].value, 'Mozilla/5.0 (Windows NT 10.0)'],
    ['cmd: %^XX keeps the percent-encoding', 'curl x.test -b ^"session=a%^2Fb^"', (r) => shape(r).headers, [['Cookie', 'session=a%2Fb']]],
    ['cmd: ^ + line break + empty line is a line break', 'curl x.test --data-raw ^"line1^\n\nline2^"', (r) => r.body, { type: 'text', content: 'line1\nline2' }],
    ['bash: ANSI-C quoting', `curl x.test --data-raw $'{"a":"x\\ny"}'`, (r) => r.body, { type: 'json', content: '{"a":"x\ny"}' }],
    ['bash: quote inside single quotes', `curl x.test -H 'x-note: it'\\''s'`, (r) => r.headers[0].value, "it's"],
    [
      'PowerShell: backtick continuations and `"',
      'curl.exe "https://x.test/a" `\n  -H "sec-ch-ua: `"Chromium`";v=`"154`"" `\n  -X PUT',
      (r) => [r.method, r.url, r.headers[0].value],
      ['PUT', 'https://x.test/a', '"Chromium";v="154"'],
    ],
  ])('%s', (_name, command, pick, expected) => {
    expect(pick(parseCurl(command))).toEqual(expected);
  });

  it('gives the same request for the bash, cmd and PowerShell copies of one request', () => {
    const request: ChromeRequest = {
      url: 'https://api.example.com/v1/items?q=a%20b&tag=x%2Fy&empty=',
      headers: [
        ['accept', 'application/json'],
        ['content-type', 'application/json'],
        ['sec-ch-ua', '"Chromium";v="154", "Not.A/Brand";v="99"'],
        ['user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'],
      ],
      cookie: 'session=a%2Fb; theme=dark',
      body: '{"name":"it\'s \\"quoted\\" 100%","n":1,"ok":true}',
    };
    const bash = chromeCurl(request, 'bash');
    const cmd = chromeCurl(request, 'cmd');
    const powershell = [
      `curl.exe 'https://api.example.com/v1/items?q=a%20b&tag=x%2Fy&empty=' \``,
      `  -H 'accept: application/json' \``,
      `  -H "content-type: application/json" \``,
      `  -H 'sec-ch-ua: "Chromium";v="154", "Not.A/Brand";v="99"' \``,
      `  -H 'user-agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64)' \``,
      `  -b 'session=a%2Fb; theme=dark' \``,
      `  --data-raw '{"name":"it''s \\"quoted\\" 100%","n":1,"ok":true}'`,
    ].join('\n');

    const expected = {
      method: 'POST',
      url: 'https://api.example.com/v1/items',
      params: [
        ['q', 'a b'],
        ['tag', 'x/y'],
        ['empty', ''],
      ],
      headers: [...request.headers, ['Cookie', 'session=a%2Fb; theme=dark']],
      auth: { type: 'none' },
      body: { type: 'json', content: request.body },
    };
    expect(shape(parseCurl(bash))).toEqual(expected);
    expect(shape(parseCurl(cmd))).toEqual(expected);
    expect(shape(parseCurl(powershell))).toEqual(expected);
  });

  it('refuses cmd.exe syntax read as bash instead of keeping the carets', () => {
    expect(() => parseCurl('curl ^"https://x.test/a^" ^\n  -H ^"a: b^"', { dialect: 'posix' })).toThrow(/bash\/zsh: .*cmd\.exe syntax at line 1, column 6/);
  });

  it('keeps backslashes that Chrome doubles in cmd mode when no quote follows, as curl.exe receives them', () => {
    // Chrome writes C:\tmp as C:^\^\tmp; the MSVC rules only halve backslashes in front of a quote.
    expect(parseCurl('curl x.test --data-raw ^"C:^\\^\\tmp^"').body).toEqual({ type: 'text', content: 'C:\\\\tmp' });
  });

  it('honours an explicit dialect over detection', () => {
    // Plain enough to read in any shell, but the caret means something different in each.
    expect(parseCurl('curl x.test -H "a: b^c"', { dialect: 'cmd' }).headers[0].value).toBe('b^c');
    expect(parseCurl('curl x.test -H a:^b', { dialect: 'cmd' }).headers[0].value).toBe('b');
    expect(parseCurl('curl x.test -H a:^b', { dialect: 'posix' }).headers[0].value).toBe('^b');
  });

  it.each([
    ['an unterminated ^"', 'curl ^"https://x.test/a ^\n  -H ^"a: b^"', /cmd\.exe: unterminated quote/],
    ["an unterminated '", "curl 'https://x.test/a \\\n  -H 'a: b'", /bash\/zsh: unterminated ' quote starting at line 2, column 11/],
    ['a second URL', 'curl https://x.test/a https://x.test/b', /second URL/],
    ['a body read from a file', 'curl x.test -d @body.json', /reads the body from a file/],
    ['an unknown option', 'curl x.test --frobnicate', /unknown curl option --frobnicate/],
    ['malformed percent-encoding in the query', "curl 'x.test/?a=%E0%A4%A'", /malformed %-encoding/],
  ])('fails on %s', (_name, command, error) => {
    expect(() => parseCurl(command)).toThrow(error);
  });
});

describe('parseCurl: curl options', () => {
  it.each<[string, string, Partial<ReturnType<typeof shape>>]>([
    ['joined short option', 'curl -XPUT x.test/a', { method: 'PUT' }],
    ['bundled flags with a value at the end', 'curl -sSLX DELETE x.test/a', { method: 'DELETE' }],
    ['--opt=value', 'curl --request=PATCH --header=a:b --url=x.test/a', { method: 'PATCH', url: 'x.test/a', headers: [['a', 'b']] }],
    ['several -d joined with &', 'curl x.test -d a=1 -d b=2', { method: 'POST', body: { type: 'urlencoded', fields: [['a', '1'], ['b', '2']] } }],
    ['-X wins over the POST default', 'curl -X PUT x.test -d a=1', { method: 'PUT' }],
    ['--data-raw never reads a file', "curl x.test --data-raw '@me hi'", { body: { type: 'text', content: '@me hi' } }],
    ['--data-urlencode', "curl x.test --data-urlencode 'q=a b&c' --data-urlencode '=x y'", { body: { type: 'urlencoded', fields: [['q', 'a b&c'], ['x y', '']] } }],
    [
      '--json sets the content type and accept headers',
      `curl x.test --json '{"a":1}'`,
      { method: 'POST', headers: [['Content-Type', 'application/json'], ['Accept', 'application/json']], body: { type: 'json', content: '{"a":1}' } },
    ],
    ['-G moves the data into the query', 'curl -G x.test/s -d q=a%20b -d n=2', { method: 'GET', url: 'x.test/s', params: [['q', 'a b'], ['n', '2']], body: { type: 'none' } }],
    ['-I is HEAD', 'curl -I x.test', { method: 'HEAD' }],
    ['ignored options with and without values', 'curl --compressed -k -L -s -o out.txt --max-time 5 x.test', { method: 'GET', url: 'x.test' }],
    ['-H cookie and -b make one cookie header', "curl x.test -H 'cookie: a=1' -b 'b=2'", { headers: [['cookie', 'a=1; b=2']] }],
    ['-u keeps colons in the password', 'curl -u me:pa:ss x.test', { auth: { type: 'basic', username: 'me', password: 'pa:ss' } }],
    ['-A and -e', "curl -A 'agent/1' -e 'https://ref.test' x.test", { headers: [['User-Agent', 'agent/1'], ['Referer', 'https://ref.test']] }],
    ['a header with an empty value', "curl x.test -H 'X-Empty;'", { headers: [['X-Empty', '']] }],
    ['the fragment is dropped', "curl 'x.test/a?b=1#top'", { url: 'x.test/a', params: [['b', '1']] }],
    ['an option value that looks like a URL is not one', "curl -H 'x: https://other.test' x.test", { url: 'x.test' }],
    ['-- ends the options', 'curl -- -weird-host', { url: '-weird-host' }],
  ])('%s', (_name, command, expected) => {
    expect(shape(parseCurl(command))).toMatchObject(expected);
  });
});

describe('toCurl', () => {
  it('quotes safely', () => {
    const out = toCurl({ method: 'POST', url: "https://x.test/it's", headers: [['A', 'b']], body: '{"q":1}' });
    expect(out).toBe(`curl -X POST 'https://x.test/it'\\''s' \\\n  -H 'A: b' \\\n  --data-raw '{"q":1}'`);
  });
});
