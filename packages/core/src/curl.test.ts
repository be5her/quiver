import { describe, expect, it } from 'vitest';
import { parseCurl, toCurl, tokenizeShell } from './curl';

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

describe('toCurl', () => {
  it('quotes safely', () => {
    const out = toCurl({ method: 'POST', url: "https://x.test/it's", headers: [['A', 'b']], body: '{"q":1}' });
    expect(out).toBe(`curl -X POST 'https://x.test/it'\\''s' \\\n  -H 'A: b' \\\n  --data-raw '{"q":1}'`);
  });
});
