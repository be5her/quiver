import { describe, expect, it } from 'vitest';
import { captureIsSecret, extractCapture, type CaptureSourceResponse } from './capture';

const response: CaptureSourceResponse = {
  status: 201,
  headers: [
    ['content-type', 'application/json'],
    ['X-Request-Id', 'r-1'],
    ['x-request-id', 'r-2'],
  ],
  body: '{"token":"tok-123","user":{"id":7,"roles":["a","b"]},"ok":true}',
  bodyEncoding: 'utf8',
  setCookies: ['session=sess-9; Path=/; HttpOnly', 'theme=dark'],
};

const capture = (from: 'body' | 'header' | 'cookie' | 'status', path: string, variable = 'v') => extractCapture({ variable, from, path }, response);

describe('extractCapture', () => {
  it('reads the body by JSON path, strings as they are and anything else as JSON', () => {
    expect(capture('body', '$.token')).toEqual({ ok: true, value: 'tok-123' });
    expect(capture('body', 'user.id')).toEqual({ ok: true, value: '7' });
    expect(capture('body', '$.user.roles')).toEqual({ ok: true, value: '["a","b"]' });
    expect(capture('body', '$.ok')).toEqual({ ok: true, value: 'true' });
    expect(capture('body', '')).toEqual({ ok: true, value: response.body });
  });

  it('says why the body gave nothing', () => {
    expect(capture('body', '$.missing')).toEqual({ ok: false, error: '$.missing matched nothing in the body' });
    expect(extractCapture({ variable: 'v', from: 'body', path: '$.a' }, { ...response, body: 'plain' })).toEqual({ ok: false, error: 'The body is not JSON' });
    expect(extractCapture({ variable: 'v', from: 'body', path: '' }, { ...response, bodyEncoding: 'base64' })).toEqual({ ok: false, error: 'The body is binary' });
    expect(capture('body', '$.user[').ok).toBe(false);
  });

  it('reads nothing from a null, so a failed call does not write "null" over the variable', () => {
    const failed = { ...response, body: '{"IsSuccess":false,"ReturnedValue":null}' };
    expect(extractCapture({ variable: 'v', from: 'body', path: '$.ReturnedValue' }, failed)).toEqual({ ok: false, error: '$.ReturnedValue is null in the body' });
    expect(extractCapture({ variable: 'v', from: 'body', path: '' }, { ...response, body: 'null' })).toEqual({ ok: true, value: 'null' });
  });

  it('reads a header without case, the last of repeated ones', () => {
    expect(capture('header', 'x-REQUEST-id')).toEqual({ ok: true, value: 'r-2' });
    expect(capture('header', 'X-Nope')).toEqual({ ok: false, error: 'The response has no X-Nope header' });
  });

  it('reads a cookie the response set, and the status', () => {
    expect(capture('cookie', 'session')).toEqual({ ok: true, value: 'sess-9' });
    expect(capture('cookie', 'nope').ok).toBe(false);
    expect(capture('status', '')).toEqual({ ok: true, value: '201' });
  });

  it('refuses a name that cannot be a variable', () => {
    expect(capture('status', '', '$uuid').ok).toBe(false);
    expect(capture('status', '', 'two words').ok).toBe(false);
  });
});

describe('captureIsSecret', () => {
  it('is secret when marked, when the variable is named like a credential, or when the variable already is', () => {
    expect(captureIsSecret({ variable: 'userId', secret: true })).toBe(true);
    expect(captureIsSecret({ variable: 'userId', secret: false })).toBe(false);
    for (const variable of ['token', 'accessToken', 'apiKey', 'password', 'client_secret', ' accessKey ']) expect(captureIsSecret({ variable, secret: false }), variable).toBe(true);
    const variables = [
      { key: 'userId', enabled: true, secret: true },
      { key: 'other', enabled: false, secret: true },
    ];
    expect(captureIsSecret({ variable: 'userId', secret: false }, variables)).toBe(true);
    expect(captureIsSecret({ variable: 'other', secret: false }, variables)).toBe(false);
  });
});
