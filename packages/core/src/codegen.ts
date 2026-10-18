import { toCurl, type CurlFormField } from './curl';
import type { HttpMethod } from './models/api';
import { baseName, contentTypeFor } from './response-file';
import { quotePowerShell, type ShellDialect } from './shell';

export type CodeTarget = 'curl' | 'curl-cmd' | 'curl-powershell' | 'javascript-fetch' | 'axios' | 'python-requests' | 'go-net-http' | 'csharp-httpclient' | 'powershell';

/** The languages and tools a request is rendered as. curl is written for a shell, since each quotes its own way (see `toCurl`). */
export const CODE_TARGETS: { value: CodeTarget; label: string; language: 'javascript' | 'text' }[] = [
  { value: 'curl', label: 'curl (bash)', language: 'text' },
  { value: 'curl-cmd', label: 'curl (cmd.exe)', language: 'text' },
  { value: 'curl-powershell', label: 'curl (PowerShell)', language: 'text' },
  { value: 'javascript-fetch', label: 'JavaScript (fetch)', language: 'javascript' },
  { value: 'axios', label: 'JavaScript (axios)', language: 'javascript' },
  { value: 'python-requests', label: 'Python (requests)', language: 'text' },
  { value: 'go-net-http', label: 'Go (net/http)', language: 'text' },
  { value: 'csharp-httpclient', label: 'C# (HttpClient)', language: 'text' },
  { value: 'powershell', label: 'PowerShell (Invoke-RestMethod)', language: 'text' },
];

export type CodeBody = { kind: 'none' } | { kind: 'text'; text: string } | { kind: 'form'; fields: CurlFormField[] } | { kind: 'file'; path: string };

/** A request as it goes on the wire (variables resolved, auth applied), for code generation. */
export interface CodeInput {
  method: HttpMethod;
  url: string;
  headers: [string, string][];
  body: CodeBody;
  options?: { followRedirects?: boolean; insecure?: boolean; timeoutMs?: number };
}

/** A double-quoted string literal that JavaScript, Python, Go and C# all read the same. */
const q = (s: string) => JSON.stringify(s);
/** A PowerShell single-quoted literal (every quote PowerShell reads as a single quote doubled). */
const ps = quotePowerShell;

function contentType(headers: [string, string][]): string | null {
  return headers.find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? null;
}

/** Multipart bodies get their Content-Type (with the boundary) from the library, so the header is left out. */
function sentHeaders(input: CodeInput): [string, string][] {
  return input.body.kind === 'form' ? input.headers.filter(([k]) => k.toLowerCase() !== 'content-type') : input.headers;
}

function fileField(field: CurlFormField): field is Exclude<CurlFormField, [string, string]> {
  return !Array.isArray(field);
}

function fileName(field: Exclude<CurlFormField, [string, string]>): string {
  return field.fileName || baseName(field.file);
}

function fileType(field: Exclude<CurlFormField, [string, string]>): string {
  return field.type || contentTypeFor(fileName(field));
}

function hasFiles(input: CodeInput): boolean {
  return input.body.kind === 'file' || (input.body.kind === 'form' && input.body.fields.some(fileField));
}

function curl(input: CodeInput, shell: ShellDialect): string {
  const body = input.body;
  return toCurl({
    method: input.method,
    url: input.url,
    headers: sentHeaders(input),
    body: body.kind === 'text' ? body.text : null,
    bodyType: body.kind === 'form' ? 'form' : 'raw',
    formFields: body.kind === 'form' ? body.fields : undefined,
    bodyFile: body.kind === 'file' ? body.path : undefined,
    options: input.options,
    shell,
  });
}

/** The FormData lines shared by fetch and axios. */
function jsForm(fields: CurlFormField[]): string[] {
  return [
    'const form = new FormData();',
    ...fields.map((f) =>
      fileField(f) ? `form.append(${q(f.name)}, new Blob([await readFile(${q(f.file)})], { type: ${q(fileType(f))} }), ${q(fileName(f))});` : `form.append(${q(f[0])}, ${q(f[1])});`,
    ),
  ];
}

function jsHeaders(headers: [string, string][], indent: string): string[] {
  if (!headers.length) return [];
  return [`${indent}headers: {`, ...headers.map(([k, v]) => `${indent}  ${q(k)}: ${q(v)},`), `${indent}},`];
}

function fetchJs(input: CodeInput): string {
  const lines: string[] = [];
  if (hasFiles(input)) lines.push("import { readFile } from 'node:fs/promises';", '');
  if (input.body.kind === 'form') lines.push(...jsForm(input.body.fields), '');
  lines.push(`const response = await fetch(${q(input.url)}, {`, `  method: ${q(input.method)},`, ...jsHeaders(sentHeaders(input), '  '));
  if (input.body.kind === 'text') lines.push(`  body: ${q(input.body.text)},`);
  if (input.body.kind === 'form') lines.push('  body: form,');
  if (input.body.kind === 'file') lines.push(`  body: await readFile(${q(input.body.path)}),`);
  if (input.options?.followRedirects === false) lines.push("  redirect: 'manual',");
  if (input.options?.timeoutMs) lines.push(`  signal: AbortSignal.timeout(${input.options.timeoutMs}),`);
  lines.push('});', 'console.log(response.status, await response.text());');
  return lines.join('\n');
}

function axiosJs(input: CodeInput): string {
  const lines: string[] = ["import axios from 'axios';"];
  if (hasFiles(input)) lines.push("import { readFile } from 'node:fs/promises';");
  lines.push('');
  if (input.body.kind === 'form') lines.push(...jsForm(input.body.fields), '');
  lines.push('const response = await axios({', `  method: ${q(input.method.toLowerCase())},`, `  url: ${q(input.url)},`, ...jsHeaders(sentHeaders(input), '  '));
  if (input.body.kind === 'text') lines.push(`  data: ${q(input.body.text)},`);
  if (input.body.kind === 'form') lines.push('  data: form,');
  if (input.body.kind === 'file') lines.push(`  data: await readFile(${q(input.body.path)}),`);
  if (input.options?.followRedirects === false) lines.push('  maxRedirects: 0,');
  if (input.options?.timeoutMs) lines.push(`  timeout: ${input.options.timeoutMs},`);
  // Show the answer whatever its status, as the other targets do.
  lines.push('  validateStatus: () => true,', '});', 'console.log(response.status, response.data);');
  return lines.join('\n');
}

function python(input: CodeInput): string {
  const lines: string[] = ['import requests', ''];
  const args: string[] = [q(input.method), q(input.url)];
  const headers = sentHeaders(input);
  if (headers.length) args.push(['headers={', ...headers.map(([k, v]) => `        ${q(k)}: ${q(v)},`), '    }'].join('\n'));
  const body = input.body;
  if (body.kind === 'text') args.push(`data=${q(body.text)}.encode("utf-8")`);
  if (body.kind === 'file') args.push(`data=open(${q(body.path)}, "rb")`);
  if (body.kind === 'form') {
    const text = body.fields.filter((f): f is [string, string] => !fileField(f));
    const files = body.fields.filter(fileField);
    if (text.length) args.push(['data={', ...text.map(([k, v]) => `        ${q(k)}: ${q(v)},`), '    }'].join('\n'));
    if (files.length) args.push(['files={', ...files.map((f) => `        ${q(f.name)}: (${q(fileName(f))}, open(${q(f.file)}, "rb"), ${q(fileType(f))}),`), '    }'].join('\n'));
  }
  args.push(`timeout=${(input.options?.timeoutMs ?? 30_000) / 1000}`);
  if (input.options?.followRedirects === false) args.push('allow_redirects=False');
  if (input.options?.insecure) args.push('verify=False');
  lines.push('response = requests.request(', ...args.map((a) => `    ${a},`), ')', 'print(response.status_code, response.text)');
  return lines.join('\n');
}

function go(input: CodeInput): string {
  const imports = new Set(['fmt', 'io', 'net/http']);
  const body: string[] = [];
  let bodyVar = 'nil';
  const b = input.body;
  if (b.kind === 'text') {
    imports.add('strings');
    body.push(`\tbody := strings.NewReader(${q(b.text)})`);
    bodyVar = 'body';
  } else if (b.kind === 'file') {
    imports.add('os');
    body.push(`\tbody, err := os.Open(${q(b.path)})`, '\tif err != nil {', '\t\tpanic(err)', '\t}', '\tdefer body.Close()');
    bodyVar = 'body';
  } else if (b.kind === 'form') {
    imports.add('bytes');
    imports.add('mime/multipart');
    body.push('\tvar body bytes.Buffer', '\tform := multipart.NewWriter(&body)');
    for (const f of b.fields) {
      if (fileField(f)) {
        imports.add('os');
        imports.add('net/textproto');
        body.push(
          '\t{',
          `\t\tfile, err := os.Open(${q(f.file)})`,
          '\t\tif err != nil {',
          '\t\t\tpanic(err)',
          '\t\t}',
          '\t\theader := make(textproto.MIMEHeader)',
          `\t\theader.Set("Content-Disposition", ${q(`form-data; name="${f.name}"; filename="${fileName(f)}"`)})`,
          `\t\theader.Set("Content-Type", ${q(fileType(f))})`,
          '\t\tpart, _ := form.CreatePart(header)',
          '\t\tio.Copy(part, file)',
          '\t\tfile.Close()',
          '\t}',
        );
      } else {
        body.push(`\tform.WriteField(${q(f[0])}, ${q(f[1])})`);
      }
    }
    body.push('\tform.Close()');
    bodyVar = '&body';
  }
  const lines: string[] = [...body, `\treq, err := http.NewRequest(${q(input.method)}, ${q(input.url)}, ${bodyVar})`, '\tif err != nil {', '\t\tpanic(err)', '\t}'];
  for (const [k, v] of sentHeaders(input)) lines.push(`\treq.Header.Add(${q(k)}, ${q(v)})`);
  if (b.kind === 'form') lines.push('\treq.Header.Set("Content-Type", form.FormDataContentType())');
  const client: string[] = [];
  if (input.options?.timeoutMs) {
    imports.add('time');
    client.push(`\t\tTimeout: ${input.options.timeoutMs} * time.Millisecond,`);
  }
  if (input.options?.followRedirects === false) client.push('\t\tCheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },');
  if (input.options?.insecure) {
    imports.add('crypto/tls');
    client.push('\t\tTransport: &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}},');
  }
  lines.push(client.length ? ['\tclient := &http.Client{', ...client, '\t}'].join('\n') : '\tclient := &http.Client{}');
  lines.push('\tresp, err := client.Do(req)', '\tif err != nil {', '\t\tpanic(err)', '\t}', '\tdefer resp.Body.Close()', '\tdata, _ := io.ReadAll(resp.Body)', '\tfmt.Println(resp.Status, string(data))');
  const sorted = [...imports].sort();
  return ['package main', '', 'import (', ...sorted.map((i) => `\t${q(i)}`), ')', '', 'func main() {', ...lines, '}'].join('\n');
}

function csharp(input: CodeInput): string {
  const lines: string[] = ['using System.Net.Http.Headers;', ''];
  const handler: string[] = [];
  if (input.options?.followRedirects === false) handler.push('AllowAutoRedirect = false');
  if (input.options?.insecure) handler.push('ServerCertificateCustomValidationCallback = HttpClientHandler.DangerousAcceptAnyServerCertificateValidator');
  lines.push(handler.length ? `var client = new HttpClient(new HttpClientHandler { ${handler.join(', ')} });` : 'var client = new HttpClient();');
  if (input.options?.timeoutMs) lines.push(`client.Timeout = TimeSpan.FromMilliseconds(${input.options.timeoutMs});`);
  lines.push(`var request = new HttpRequestMessage(new HttpMethod(${q(input.method)}), ${q(input.url)});`);
  const b = input.body;
  const headers = sentHeaders(input);
  // Content-* headers belong to the content in HttpClient; the rest to the request.
  const isContent = (k: string) => k.toLowerCase().startsWith('content-');
  if (b.kind === 'text') lines.push(`request.Content = new StringContent(${q(b.text)});`);
  if (b.kind === 'file') lines.push(`request.Content = new StreamContent(File.OpenRead(${q(b.path)}));`);
  if (b.kind === 'form') {
    lines.push('var form = new MultipartFormDataContent();');
    let files = 0;
    for (const f of b.fields) {
      if (fileField(f)) {
        const name = `file${++files}`;
        lines.push(
          `var ${name} = new StreamContent(File.OpenRead(${q(f.file)}));`,
          `${name}.Headers.ContentType = MediaTypeHeaderValue.Parse(${q(fileType(f))});`,
          `form.Add(${name}, ${q(f.name)}, ${q(fileName(f))});`,
        );
      } else {
        lines.push(`form.Add(new StringContent(${q(f[1])}), ${q(f[0])});`);
      }
    }
    lines.push('request.Content = form;');
  }
  for (const [k, v] of headers) {
    if (!isContent(k)) lines.push(`request.Headers.TryAddWithoutValidation(${q(k)}, ${q(v)});`);
    else if (b.kind === 'text' || b.kind === 'file') {
      lines.push(k.toLowerCase() === 'content-type' ? `request.Content.Headers.ContentType = MediaTypeHeaderValue.Parse(${q(v)});` : `request.Content.Headers.TryAddWithoutValidation(${q(k)}, ${q(v)});`);
    }
  }
  lines.push('var response = await client.SendAsync(request);', 'Console.WriteLine($"{(int)response.StatusCode} {await response.Content.ReadAsStringAsync()}");');
  return lines.join('\n');
}

function powershell(input: CodeInput): string {
  const lines: string[] = [];
  const type = contentType(input.headers);
  const headers = sentHeaders(input).filter(([k]) => k.toLowerCase() !== 'content-type');
  if (headers.length) lines.push('$headers = @{', ...headers.map(([k, v]) => `  ${ps(k)} = ${ps(v)}`), '}');
  const args: string[] = [`-Uri ${ps(input.url)}`, `-Method ${input.method[0]}${input.method.slice(1).toLowerCase()}`];
  if (headers.length) args.push('-Headers $headers');
  const b = input.body;
  if (b.kind === 'text') args.push(`-Body ${ps(b.text)}`);
  if (b.kind === 'file') args.push(`-InFile ${ps(b.path)}`);
  if (b.kind === 'form') {
    lines.push('$form = @{', ...b.fields.map((f) => (fileField(f) ? `  ${ps(f.name)} = Get-Item -LiteralPath ${ps(f.file)}` : `  ${ps(f[0])} = ${ps(f[1])}`)), '}');
    args.push('-Form $form');
  }
  if (type && b.kind !== 'form') args.push(`-ContentType ${ps(type)}`);
  if (input.options?.followRedirects === false) args.push('-MaximumRedirection 0');
  if (input.options?.insecure) args.push('-SkipCertificateCheck');
  if (input.options?.timeoutMs) args.push(`-TimeoutSec ${Math.ceil(input.options.timeoutMs / 1000)}`);
  lines.push(`$response = Invoke-RestMethod ${args.join(' `\n  ')}`, '$response');
  return lines.join('\n');
}

/** The request as code for a language or tool: what was sent, with variables resolved and auth applied. */
export function toCode(target: CodeTarget, input: CodeInput): string {
  switch (target) {
    case 'curl':
      return curl(input, 'posix');
    case 'curl-cmd':
      return curl(input, 'cmd');
    case 'curl-powershell':
      return curl(input, 'powershell');
    case 'javascript-fetch':
      return fetchJs(input);
    case 'axios':
      return axiosJs(input);
    case 'python-requests':
      return python(input);
    case 'go-net-http':
      return go(input);
    case 'csharp-httpclient':
      return csharp(input);
    case 'powershell':
      return powershell(input);
  }
}
