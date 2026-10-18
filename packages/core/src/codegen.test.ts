import { describe, expect, it } from 'vitest';
import { CODE_TARGETS, toCode, type CodeInput } from './codegen';

const json: CodeInput = {
  method: 'POST',
  url: 'https://api.test/users?x=1',
  headers: [
    ['Content-Type', 'application/json'],
    ['Authorization', 'Bearer t0k'],
  ],
  body: { kind: 'text', text: '{"name":"Ada \\"L\\""}' },
};

const multipart: CodeInput = {
  method: 'POST',
  url: 'https://api.test/upload',
  headers: [['Content-Type', 'multipart/form-data; boundary=x']],
  body: { kind: 'form', fields: [['note', "it's"], { name: 'doc', file: 'uploads/a b.pdf', type: 'application/pdf' }] },
};

const file: CodeInput = { method: 'PUT', url: 'https://api.test/blob', headers: [['Content-Type', 'image/png']], body: { kind: 'file', path: 'img/logo.png' }, options: { followRedirects: false, insecure: true, timeoutMs: 5000 } };

describe('toCode', () => {
  it('writes fetch exactly', () => {
    expect(toCode('javascript-fetch', json)).toBe(
      [
        'const response = await fetch("https://api.test/users?x=1", {',
        '  method: "POST",',
        '  headers: {',
        '    "Content-Type": "application/json",',
        '    "Authorization": "Bearer t0k",',
        '  },',
        '  body: "{\\"name\\":\\"Ada \\\\\\"L\\\\\\"\\"}",',
        '});',
        'console.log(response.status, await response.text());',
      ].join('\n'),
    );
  });

  it('covers every target for a JSON body', () => {
    for (const { value } of CODE_TARGETS) {
      const code = toCode(value, json);
      expect(code, value).toContain('https://api.test/users?x=1');
      expect(code, value).toContain('Bearer t0k');
    }
    expect(toCode('axios', json)).toContain("method: \"post\",");
    expect(toCode('python-requests', json)).toContain('requests.request(\n    "POST",');
    expect(toCode('go-net-http', json)).toContain('req.Header.Add("Authorization", "Bearer t0k")');
    expect(toCode('csharp-httpclient', json)).toContain('request.Content.Headers.ContentType = MediaTypeHeaderValue.Parse("application/json");');
    expect(toCode('powershell', json)).toContain("-ContentType 'application/json'");
    expect(toCode('curl', json)).toContain("--data-raw '{\"name\":\"Ada \\\"L\\\"\"}'");
  });

  it('writes curl for the shell it is labelled with', () => {
    expect(CODE_TARGETS.slice(0, 3).map((t) => t.label)).toEqual(['curl (bash)', 'curl (cmd.exe)', 'curl (PowerShell)']);
    expect(toCode('curl', json)).toMatch(/^curl -X POST 'https:\/\/api\.test\/users\?x=1' \\\n  -H 'Content-Type: application\/json'/);
    expect(toCode('curl-cmd', json)).toMatch(/^curl -X POST \^"https:\/\/api\.test\/users\?x=1\^" \^\n  -H \^"Content-Type: application\/json\^"/);
    expect(toCode('curl-cmd', json)).toContain('--data-raw ^"^{^\\^"name^\\^":^\\^"Ada ^\\^\\^\\^"L^\\^\\^\\^"^\\^"^}^"');
    expect(toCode('curl-powershell', json)).toMatch(/^curl\.exe -X POST 'https:\/\/api\.test\/users\?x=1' `\n  -H 'Content-Type: application\/json'/);
    expect(toCode('curl-powershell', json)).toContain("--data-raw '{\"name\":\"Ada \\\"L\\\"\"}'");
  });

  it('writes multipart with files as file references, never the multipart Content-Type', () => {
    const outputs = Object.fromEntries(CODE_TARGETS.map(({ value }) => [value, toCode(value, multipart)]));
    for (const [target, code] of Object.entries(outputs)) {
      expect(code, target).not.toContain('boundary=x');
      expect(code, target).toContain('uploads/a b.pdf');
    }
    expect(outputs['javascript-fetch']).toContain('form.append("doc", new Blob([await readFile("uploads/a b.pdf")], { type: "application/pdf" }), "a b.pdf");');
    expect(outputs['javascript-fetch']).toContain("import { readFile } from 'node:fs/promises';");
    expect(outputs['python-requests']).toContain('"doc": ("a b.pdf", open("uploads/a b.pdf", "rb"), "application/pdf"),');
    expect(outputs['go-net-http']).toContain('form.WriteField("note", "it\'s")');
    expect(outputs['go-net-http']).toContain('req.Header.Set("Content-Type", form.FormDataContentType())');
    expect(outputs['csharp-httpclient']).toContain('form.Add(file1, "doc", "a b.pdf");');
    expect(outputs.powershell).toContain("'note' = 'it''s'");
    expect(outputs.powershell).toContain("'doc' = Get-Item -LiteralPath 'uploads/a b.pdf'");
    expect(outputs.curl).toContain("-F 'doc=@uploads/a b.pdf;type=application/pdf'");
    expect(outputs.curl).toContain("--form-string 'note=it'\\''s'");
  });

  it('doubles every quote PowerShell reads as a single quote, so a value cannot close the literal', () => {
    const tricky: CodeInput = { ...json, headers: [['X-A', "a’; calc; ’ b‘‚‛'"]] };
    expect(toCode('powershell', tricky)).toContain("'X-A' = 'a’’; calc; ’’ b‘‘‚‚‛‛'''");
  });

  it('writes a file body and the send options', () => {
    expect(toCode('curl', file)).toContain("--data-binary '@img/logo.png'");
    expect(toCode('javascript-fetch', file)).toContain('body: await readFile("img/logo.png"),');
    expect(toCode('javascript-fetch', file)).toContain("redirect: 'manual',");
    expect(toCode('python-requests', file)).toContain('allow_redirects=False');
    expect(toCode('python-requests', file)).toContain('verify=False');
    expect(toCode('python-requests', file)).toContain('timeout=5');
    const go = toCode('go-net-http', file);
    expect(go).toContain('Timeout: 5000 * time.Millisecond');
    expect(go).toContain('InsecureSkipVerify: true');
    expect(go).toContain('"crypto/tls"');
    expect(toCode('csharp-httpclient', file)).toContain('AllowAutoRedirect = false');
    expect(toCode('powershell', file)).toContain("-InFile 'img/logo.png'");
    expect(toCode('powershell', file)).toContain('-SkipCertificateCheck');
  });

  it('leaves the body out of a GET', () => {
    const get: CodeInput = { method: 'GET', url: 'https://api.test/', headers: [], body: { kind: 'none' } };
    expect(toCode('javascript-fetch', get)).not.toContain('body:');
    expect(toCode('go-net-http', get)).toContain('http.NewRequest("GET", "https://api.test/", nil)');
    expect(toCode('python-requests', get)).not.toContain('data=');
  });
});
