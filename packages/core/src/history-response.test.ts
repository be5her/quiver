import { describe, expect, it } from 'vitest';
import { MAX_HISTORY_RESPONSE_BYTES, responseFromHistory, toHistoryResponse } from './history-response';
import type { ApiResponse } from './models/api';
import { REDACTED } from './redact';
import { normalizeJson } from './json';

const response: ApiResponse = {
  ok: true,
  status: 200,
  statusText: 'OK',
  url: 'https://api.test/me',
  headers: [
    ['Content-Type', 'application/json'],
    ['Set-Cookie', 'sid=abc123; Path=/; HttpOnly'],
    ['set-cookie', 'flag'],
  ],
  body: '{"token":"tok-secret-1","name":"Ada"}',
  bodyEncoding: 'utf8',
  contentType: 'application/json',
  size: 37,
  truncated: false,
  timings: { total: 12, ttfb: 10, download: 2 },
  redirects: [],
  setCookies: ['sid=abc123; Path=/; HttpOnly'],
  sent: { method: 'GET', url: 'https://api.test/me', headers: [], bodyPreview: null },
};

describe('toHistoryResponse', () => {
  it('keeps the status, headers and body, with cookie values masked and known secrets scrubbed', () => {
    const kept = toHistoryResponse(response, ['tok-secret-1'])!;
    expect(kept.headers).toEqual([
      ['Content-Type', 'application/json'],
      ['Set-Cookie', `sid=${REDACTED}; Path=/; HttpOnly`],
      ['set-cookie', 'flag'],
    ]);
    expect(kept.body).toBe(`{"token":"${REDACTED}","name":"Ada"}`);
    expect(kept).toMatchObject({ status: 200, statusText: 'OK', contentType: 'application/json', bodyEncoding: 'utf8', truncated: false });
  });

  it('keeps nothing for a big or streamed body', () => {
    expect(toHistoryResponse({ ...response, size: MAX_HISTORY_RESPONSE_BYTES + 1 })).toBeUndefined();
    expect(toHistoryResponse({ ...response, streamId: 's' })).toBeUndefined();
  });

  it('turns back into a response the pane can show', () => {
    const back = responseFromHistory({ url: 'https://api.test/me', method: 'GET', durationMs: 12, response: toHistoryResponse(response) })!;
    expect(back).toMatchObject({ status: 200, ok: true, body: response.body, size: 37, timings: { total: 12 } });
    expect(back.setCookies).toHaveLength(2);
    expect(responseFromHistory({ url: '', method: 'GET', durationMs: null })).toBeNull();
  });
});

describe('normalizeJson', () => {
  it('sorts keys at every depth and indents, leaving arrays in order; null for text that is not JSON', () => {
    expect(normalizeJson('{"b":1,"a":{"d":[3,{"z":1,"y":2}],"c":null}}')).toBe('{\n  "a": {\n    "c": null,\n    "d": [\n      3,\n      {\n        "y": 2,\n        "z": 1\n      }\n    ]\n  },\n  "b": 1\n}');
    expect(normalizeJson('not json')).toBeNull();
  });
});
