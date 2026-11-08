import { describe, expect, it } from 'vitest';
import { nextRequest, type WireRequest } from './redirect';

const post: WireRequest<string> = {
  method: 'POST',
  url: 'https://api.test/login?x=1',
  headers: [
    ['Content-Type', 'application/json'],
    ['Authorization', 'Bearer t'],
    ['Cookie', 'sid=1'],
    ['X-API-Key', 'k'],
    ['X-Trace', 'abc'],
  ],
  body: '{"a":1}',
};

describe('nextRequest', () => {
  it('turns a POST into a GET without a body on 301, 302 and 303', () => {
    for (const status of [301, 302, 303]) {
      expect(nextRequest(post, status, '/home')).toEqual({
        method: 'GET',
        url: 'https://api.test/home',
        headers: [
          ['Authorization', 'Bearer t'],
          ['Cookie', 'sid=1'],
          ['X-API-Key', 'k'],
          ['X-Trace', 'abc'],
        ],
        body: null,
      });
    }
  });

  it('repeats the request as it was on 307 and 308', () => {
    for (const status of [307, 308]) expect(nextRequest(post, status, 'https://api.test/v2/login')).toEqual({ ...post, url: 'https://api.test/v2/login' });
  });

  it('keeps PUT on 301 and 302, and HEAD on 303', () => {
    expect(nextRequest({ ...post, method: 'PUT' }, 302, '/x')?.method).toBe('PUT');
    expect(nextRequest({ ...post, method: 'HEAD', body: null }, 303, '/x')?.method).toBe('HEAD');
    expect(nextRequest({ ...post, method: 'DELETE' }, 303, '/x')?.method).toBe('GET');
  });

  it('drops credentials, API-key headers among them, when the redirect leaves the origin', () => {
    expect(nextRequest(post, 307, 'https://other.test/login')?.headers.map(([k]) => k)).toEqual(['Content-Type', 'X-Trace']);
    // Another scheme or port is another origin: a downgrade to http would send them in the clear.
    expect(nextRequest(post, 307, 'http://api.test/login')?.headers.map(([k]) => k)).toEqual(['Content-Type', 'X-Trace']);
    expect(nextRequest(post, 307, 'https://api.test:8443/login')?.headers.map(([k]) => k)).toEqual(['Content-Type', 'X-Trace']);
    expect(nextRequest({ ...post, headers: [['X-Auth-Token', 't'], ['Ocp-Apim-Subscription-Key', 's'], ['Accept', '*/*']] }, 302, 'https://other.test/')?.headers).toEqual([['Accept', '*/*']]);
  });

  it('refuses a location that is not an http URL', () => {
    expect(nextRequest(post, 302, 'javascript:alert(1)')).toBeNull();
    expect(nextRequest({ ...post, url: 'not a url' }, 302, '/x')).toBeNull();
  });
});
