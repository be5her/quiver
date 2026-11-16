import { describe, expect, it } from 'vitest';
import { parseCurl } from './curl';
import { newApiRequest } from './models/api';
import { QUICK_REQUEST_NAME, applyCurl, isQuickRequestId, looksLikeCurl, newQuickRequest } from './quick-request';

describe('quick requests', () => {
  it('are new, unsaved requests told apart by their id', () => {
    const a = newQuickRequest();
    const b = newQuickRequest({ url: 'https://example.com' });
    expect(a.name).toBe(QUICK_REQUEST_NAME);
    expect(a.collectionId).toBeNull();
    expect(a.auth).toEqual({ type: 'none' });
    expect(b.url).toBe('https://example.com');
    expect(a.id).not.toBe(b.id);
    expect(isQuickRequestId(a.id)).toBe(true);
    // A given id never replaces the quick one: a quick request cannot pose as a saved one.
    expect(isQuickRequestId(newQuickRequest({ id: 'abc' }).id)).toBe(true);
    expect(isQuickRequestId(newApiRequest().id)).toBe(false);
    expect(isQuickRequestId('history-123')).toBe(false);
    expect(isQuickRequestId(null)).toBe(false);
    expect(isQuickRequestId(undefined)).toBe(false);
  });
});

describe('looksLikeCurl', () => {
  it('recognises curl commands for every shell, not URLs', () => {
    expect(looksLikeCurl(`curl 'https://example.com'`)).toBe(true);
    expect(looksLikeCurl(`  curl -X POST https://example.com`)).toBe(true);
    expect(looksLikeCurl(`curl.exe -H 'a: b' https://example.com`)).toBe(true);
    expect(looksLikeCurl(`CURL https://example.com`)).toBe(true);
    expect(looksLikeCurl(`/usr/bin/curl https://example.com`)).toBe(true);
    expect(looksLikeCurl(`curl ^"https://example.com/^" ^\n  -H ^"a: b^"`)).toBe(true);
    expect(looksLikeCurl('https://example.com/curl')).toBe(false);
    expect(looksLikeCurl('curl')).toBe(false);
    expect(looksLikeCurl('curly.example.com')).toBe(false);
    expect(looksLikeCurl('{{baseUrl}}/curl -x')).toBe(false);
    expect(looksLikeCurl('https://example.com/curl -x')).toBe(false);
    expect(looksLikeCurl('C:\\tools\\curl.exe https://example.com')).toBe(true);
  });
});

describe('applyCurl', () => {
  const parsed = parseCurl(`curl -X POST 'https://api.example.com/users?page=2' -H 'Content-Type: application/json' -H 'Authorization: Bearer abc' --data-raw '{"a":1}'`);

  it('takes what the command describes and keeps the rest of the request', () => {
    const request = newApiRequest({
      id: 'r1',
      name: 'Mine',
      collectionId: 'c1',
      description: 'notes',
      options: { timeoutMs: 5000 },
      checks: [{ id: 'k', enabled: true, on: 'status', path: '', op: 'eq', expected: '200' }],
      headers: [{ id: 'h', key: 'X-Old', value: '1', enabled: true }],
    });
    const next = applyCurl(request, parsed);
    expect(next).toMatchObject({ id: 'r1', name: 'Mine', collectionId: 'c1', description: 'notes', options: { timeoutMs: 5000 }, method: 'POST', url: 'https://api.example.com/users' });
    expect(next.checks).toEqual(request.checks);
    expect(next.params).toMatchObject([{ key: 'page', value: '2' }]);
    expect(next.headers.map((h) => h.key)).toEqual(['Content-Type']);
    expect(next.body).toEqual({ type: 'json', content: '{"a":1}' });
    expect(next.auth).toEqual({ type: 'bearer', token: 'abc' });
  });

  it('keeps an inherited auth when the command carries none, and replaces any other', () => {
    const plain = parseCurl('curl https://api.example.com/');
    expect(applyCurl(newApiRequest({ auth: { type: 'inherit' } }), plain).auth).toEqual({ type: 'inherit' });
    expect(applyCurl(newApiRequest({ auth: { type: 'bearer', token: 'old' } }), plain).auth).toEqual({ type: 'none' });
    expect(applyCurl(newApiRequest({ auth: { type: 'inherit' } }), parsed).auth).toEqual({ type: 'bearer', token: 'abc' });
  });
});
