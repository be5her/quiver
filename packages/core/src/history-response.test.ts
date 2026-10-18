import { describe, expect, it } from 'vitest';
import { HISTORY_RESPONSES_KEPT, MAX_HISTORY_ENTRIES, MAX_HISTORY_RESPONSE_BYTES, pruneHistory, responseFromHistory, toHistoryResponse } from './history-response';
import { newApiRequest, type ApiResponse, type HistoryEntry } from './models/api';
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
    ['X-Auth-Token', 'tok-secret-1'],
    ['Location', 'https://api.test/next?access_token=other-2&page=1'],
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
  it('keeps the status, headers and body, with cookie values masked and known secrets scrubbed from headers and body', () => {
    const kept = toHistoryResponse(response, ['tok-secret-1'])!;
    expect(kept.headers).toEqual([
      ['Content-Type', 'application/json'],
      ['Set-Cookie', `sid=${REDACTED}; Path=/; HttpOnly`],
      ['set-cookie', 'flag'],
      ['X-Auth-Token', REDACTED],
      ['Location', `https://api.test/next?access_token=${REDACTED}&page=1`],
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

describe('pruneHistory', () => {
  const entry = (n: number, withResponse: boolean): HistoryEntry => ({
    id: `e${n}`,
    at: '2026-10-18T00:00:00Z',
    requestId: null,
    method: 'GET',
    url: `https://api.test/${n}`,
    status: 200,
    durationMs: 1,
    error: null,
    request: newApiRequest({ name: `r${n}` }),
    ...(withResponse ? { response: toHistoryResponse(response) } : {}),
  });

  it('keeps the newest entries, responses only on the newest of those, and says when something went', () => {
    const entries = Array.from({ length: 6 }, (_, n) => entry(n, true));
    const pruned = pruneHistory(entries, { maxEntries: 4, responsesKept: 2 });
    expect(pruned.changed).toBe(true);
    expect(pruned.entries.map((e) => [e.id, e.response !== undefined])).toEqual([
      ['e0', true],
      ['e1', true],
      ['e2', false],
      ['e3', false],
    ]);
    // The rest of a pruned entry stays as it was.
    expect(pruned.entries[2]).toEqual({ ...entries[2], response: undefined });
    expect('response' in pruned.entries[2]).toBe(false);
  });

  it('changes nothing within the limits', () => {
    const entries = [entry(0, true), entry(1, false)];
    const pruned = pruneHistory(entries, { maxEntries: 2, responsesKept: 1 });
    expect(pruned.changed).toBe(false);
    expect(pruned.entries).toEqual(entries);
  });

  it('defaults to 1000 entries and 200 responses', () => {
    expect(MAX_HISTORY_ENTRIES).toBe(1000);
    expect(HISTORY_RESPONSES_KEPT).toBe(200);
  });
});
