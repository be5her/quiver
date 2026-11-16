import { describe, expect, it } from 'vitest';
import { readCurl } from './curl';
import { newApiRequest } from './models/api';
import { QUICK_REQUEST_NAME, applyCurl, isQuickRequestId, isUnsavedRequestId, looksLikeCurl, newQuickRequest, restorableTabs } from './quick-request';

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
    expect(isUnsavedRequestId(a.id)).toBe(true);
    expect(isUnsavedRequestId('history-123')).toBe(true);
    expect(isUnsavedRequestId(newApiRequest().id)).toBe(false);
    expect(isUnsavedRequestId(null)).toBe(false);
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
  const reading = readCurl(`curl -X POST 'https://api.example.com/users?page=2' -H 'Content-Type: application/json' -H 'Authorization: Bearer abc' --data-raw '{"a":1}'`);

  it('takes what the command describes and keeps the rest of the request', () => {
    const request = newApiRequest({
      id: 'r1',
      name: 'Mine',
      collectionId: 'c1',
      description: 'notes',
      options: { timeoutMs: 5000, cookies: false },
      checks: [{ id: 'k', enabled: true, on: 'status', path: '', op: 'eq', expected: '200' }],
      headers: [{ id: 'h', key: 'X-Old', value: '1', enabled: true }],
    });
    const next = applyCurl(request, reading);
    expect(next).toMatchObject({ id: 'r1', name: 'Mine', collectionId: 'c1', description: 'notes', method: 'POST', url: 'https://api.example.com/users' });
    // The command's options replace the timeout, redirects and TLS settings; the cookie jar setting stays. No -L: no redirects followed, as curl.
    expect(next.options).toEqual({ cookies: false, followRedirects: false });
    expect(next.checks).toEqual(request.checks);
    expect(next.params).toMatchObject([{ key: 'page', value: '2' }]);
    expect(next.headers.map((h) => h.key)).toEqual(['Content-Type']);
    expect(next.body).toEqual({ type: 'json', content: '{"a":1}' });
    expect(next.auth).toEqual({ type: 'bearer', token: 'abc' });
  });

  it('names a quick request after the command, and leaves no options when the command sets none that differ', () => {
    const next = applyCurl(newQuickRequest({ options: { insecure: true } }), readCurl('curl -L https://api.example.com/users/7'));
    expect(next.name).toBe('GET /users/7');
    expect(next.options).toBeUndefined();
    expect(applyCurl(newQuickRequest(), readCurl('curl -kL -m 2.5 https://api.example.com/')).options).toEqual({ insecure: true, timeoutMs: 2500 });
  });

  it('keeps an inherited auth when the command carries none, and replaces any other', () => {
    const plain = readCurl('curl https://api.example.com/');
    expect(applyCurl(newApiRequest({ auth: { type: 'inherit' } }), plain).auth).toEqual({ type: 'inherit' });
    expect(applyCurl(newApiRequest({ auth: { type: 'bearer', token: 'old' } }), plain).auth).toEqual({ type: 'none' });
    expect(applyCurl(newApiRequest({ auth: { type: 'inherit' } }), reading).auth).toEqual({ type: 'bearer', token: 'abc' });
  });
});

describe('restorableTabs', () => {
  const tab = (id: string, type: string, requestId?: string) => ({ id, type, data: requestId ? { id: requestId } : {} });

  it('drops unsaved request tabs and falls back to the first tab when the active one was dropped', () => {
    const tabs = [tab('a', 'api.request', 'saved1'), tab('b', 'api.request', 'quick-1'), tab('c', 'api.request', 'history-2'), tab('d', 'db.query', 'quick-3')];
    expect(restorableTabs(tabs, 'b')).toEqual({ tabs: [tabs[0], tabs[3]], activeTabId: 'a' });
    expect(restorableTabs(tabs, 'd').activeTabId).toBe('d');
    expect(restorableTabs([tabs[1]], 'b')).toEqual({ tabs: [], activeTabId: null });
    expect(restorableTabs(tabs, null).activeTabId).toBe('a');
  });
});
