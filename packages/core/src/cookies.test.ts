import { describe, expect, it } from 'vitest';
import { cookieExpiry, parseSetCookie } from './cookies';

describe('parseSetCookie', () => {
  it('reads the pair and every attribute', () => {
    expect(parseSetCookie('sid=abc=1; Domain=.Example.com; Path=/app; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Max-Age=60; Secure; HttpOnly; SameSite=lax')).toEqual({
      name: 'sid',
      value: 'abc=1',
      domain: 'example.com',
      path: '/app',
      expires: 'Wed, 21 Oct 2026 07:28:00 GMT',
      maxAge: 60,
      secure: true,
      httpOnly: true,
      sameSite: 'Lax',
    });
  });

  it('unquotes a quoted value and ignores unknown or malformed attributes', () => {
    expect(parseSetCookie('a="b c"; Priority=High; Path=relative; Max-Age=soon')).toEqual({ name: 'a', value: 'b c', secure: false, httpOnly: false });
  });

  it('is null without a name=value pair', () => {
    expect(parseSetCookie('justaname')).toBeNull();
    expect(parseSetCookie('=value')).toBeNull();
  });
});

describe('cookieExpiry', () => {
  const now = Date.parse('2026-10-17T00:00:00Z');
  const base = { name: 'a', value: '', secure: false, httpOnly: false };

  it('prefers Max-Age, then Expires, else a session cookie', () => {
    expect(cookieExpiry({ ...base, maxAge: 60, expires: 'Thu, 01 Jan 2099 00:00:00 GMT' }, now)).toBe(now + 60_000);
    expect(cookieExpiry({ ...base, expires: 'Sat, 17 Oct 2026 01:00:00 GMT' }, now)).toBe(now + 3_600_000);
    expect(cookieExpiry(base, now)).toBeNull();
    expect(cookieExpiry({ ...base, maxAge: 0 }, now)).toBe(0);
  });
});
