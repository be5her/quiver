import { describe, expect, it } from 'vitest';
import { cookiesFor, defaultCookiePath, domainMatches, expireCookies, isPublicSuffix, mergeCookieHeader, pathMatches, storeCookies } from './cookie-jar';

const now = Date.parse('2026-10-17T00:00:00Z');
const names = (cookies: { name: string }[]) => cookies.map((c) => c.name);

describe('matching', () => {
  it('matches a domain or its subdomains, never for an IP', () => {
    expect(domainMatches('api.example.com', 'example.com')).toBe(true);
    expect(domainMatches('example.com', 'example.com')).toBe(true);
    expect(domainMatches('badexample.com', 'example.com')).toBe(false);
    expect(domainMatches('1.2.3.4', '2.3.4')).toBe(false);
  });

  it('matches paths at slash boundaries', () => {
    expect(pathMatches('/api/users', '/api')).toBe(true);
    expect(pathMatches('/api', '/api')).toBe(true);
    expect(pathMatches('/apix', '/api')).toBe(false);
    expect(pathMatches('/api/x', '/api/')).toBe(true);
    expect(pathMatches('/other', '/api')).toBe(false);
  });

  it('defaults the path to the directory of the request', () => {
    expect(defaultCookiePath('/auth/login')).toBe('/auth');
    expect(defaultCookiePath('/login')).toBe('/');
    expect(defaultCookiePath('')).toBe('/');
  });
});

describe('storeCookies', () => {
  it('stores host-only and Domain cookies with their path and expiry, and replaces by name, domain and path', () => {
    let { jar, stored } = storeCookies([], 'https://api.example.com/auth/login', ['sid=1; HttpOnly', 'pref=a; Domain=.Example.com; Path=/; Max-Age=60; Secure; SameSite=lax'], now);
    expect(stored).toEqual(['sid', 'pref']);
    expect(jar).toEqual([
      { name: 'sid', value: '1', domain: 'api.example.com', hostOnly: true, path: '/auth', expiresAt: null, secure: false, httpOnly: true, createdAt: now },
      { name: 'pref', value: 'a', domain: 'example.com', hostOnly: false, path: '/', expiresAt: now + 60_000, secure: true, httpOnly: false, sameSite: 'Lax', createdAt: now },
    ]);
    ({ jar } = storeCookies(jar, 'https://api.example.com/auth/again', ['sid=2'], now + 5));
    expect(jar.filter((c) => c.name === 'sid')).toMatchObject([{ value: '2', createdAt: now }]);
  });

  it('deletes with Max-Age=0 and rejects foreign or too broad domains', () => {
    const { jar } = storeCookies([], 'http://x.test/', ['a=1'], now);
    const result = storeCookies(jar, 'http://x.test/', ['a=; Max-Age=0', 'b=1; Domain=other.test', 'c=1; Domain=test'], now);
    expect(result.jar).toEqual([]);
    expect(result.deleted).toEqual(['a']);
    expect(result.rejected.map((r) => r.name)).toEqual(['b', 'c']);
  });

  it('rejects a Domain that is a public suffix or a hosting platform, so one site cannot set cookies for every other', () => {
    for (const domain of ['co.uk', 'com.au', 'ne.jp', 'gov.br', 'herokuapp.com', 'github.io', 'azurewebsites.net', 'localhost', 'com']) expect(isPublicSuffix(domain), domain).toBe(true);
    for (const domain of ['example.com', 'me.com', 'app.co.uk', 'user.github.io', 'my.herokuapp.com', 'co.example']) expect(isPublicSuffix(domain), domain).toBe(false);
    const uk = storeCookies([], 'https://evil.co.uk/', ['wide=1; Domain=co.uk', 'own=1; Domain=evil.co.uk'], now);
    expect(uk.stored).toEqual(['own']);
    expect(uk.rejected).toEqual([{ name: 'wide', reason: 'Domain co.uk is too broad' }]);
    const platform = storeCookies([], 'https://one.herokuapp.com/', ['all=1; Domain=herokuapp.com', 'mine=1; Domain=one.herokuapp.com'], now);
    expect(platform.stored).toEqual(['mine']);
    expect(platform.rejected.map((r) => r.name)).toEqual(['all']);
    // The host itself may be a single label on an intranet.
    expect(storeCookies([], 'http://intranet/', ['i=1; Domain=intranet'], now).stored).toEqual(['i']);
    expect(storeCookies([], 'http://app.localhost/', ['l=1; Domain=localhost'], now).rejected.map((r) => r.name)).toEqual(['l']);
  });

  it('rejects a Secure cookie set over plain http, except from a loopback host', () => {
    const plain = storeCookies([], 'http://x.test/', ['s=1; Secure', 'p=1'], now);
    expect(plain.stored).toEqual(['p']);
    expect(plain.rejected).toEqual([{ name: 's', reason: 'Secure cookie set over http' }]);
    expect(storeCookies([], 'https://x.test/', ['s=1; Secure'], now).stored).toEqual(['s']);
    expect(storeCookies([], 'http://localhost:3000/', ['s=1; Secure'], now).stored).toEqual(['s']);
  });
});

describe('cookiesFor', () => {
  const { jar } = storeCookies(
    [],
    'https://api.example.com/auth/login',
    ['sid=1', 'root=r; Path=/', 'deep=d; Path=/auth/login/x', 'wide=w; Domain=example.com; Path=/', 'sec=s; Secure; Path=/', 'old=o; Max-Age=10; Path=/'],
    now,
  );

  it('sends what matches host, path and scheme, longest path first', () => {
    expect(names(cookiesFor(jar, 'https://api.example.com/auth/me', now))).toEqual(['sid', 'root', 'wide', 'sec', 'old']);
    expect(names(cookiesFor(jar, 'https://www.example.com/', now))).toEqual(['wide']);
    expect(names(cookiesFor(jar, 'http://api.example.com/', now))).toEqual(['root', 'wide', 'old']);
    expect(names(cookiesFor(jar, 'https://api.example.com/auth/login/x/y', now))).toEqual(['deep', 'sid', 'root', 'wide', 'sec', 'old']);
  });

  it('leaves out expired cookies and sends secure ones to a loopback host over http', () => {
    expect(names(cookiesFor(jar, 'https://api.example.com/', now + 20_000))).not.toContain('old');
    expect(expireCookies(jar, now + 20_000).some((c) => c.name === 'old')).toBe(false);
    const local = storeCookies([], 'http://127.0.0.1:8080/', ['s=1; Secure'], now).jar;
    expect(names(cookiesFor(local, 'http://127.0.0.1:8080/x', now))).toEqual(['s']);
  });
});

describe('mergeCookieHeader', () => {
  it('adds jar cookies the request does not set itself', () => {
    expect(mergeCookieHeader('a=mine; b=2', [{ name: 'a', value: 'jar' }, { name: 'c', value: '3' }])).toBe('a=mine; b=2; c=3');
    expect(mergeCookieHeader(null, [{ name: 'c', value: '3' }])).toBe('c=3');
    expect(mergeCookieHeader(null, [])).toBeNull();
  });
});
