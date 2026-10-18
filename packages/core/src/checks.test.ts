import { describe, expect, it } from 'vitest';
import { MATCH_TEXT_LIMIT, checkSummary, evaluateCheck, evaluateChecks, hasNestedRepetition, scrubCheckResults, type CheckSourceResponse } from './checks';
import type { Check } from './models/api';
import { REDACTED } from './redact';

const response: CheckSourceResponse = {
  status: 201,
  headers: [
    ['Content-Type', 'application/json; charset=utf-8'],
    ['Set-Cookie', 'a=1'],
    ['set-cookie', 'b=2'],
  ],
  body: JSON.stringify({ data: { id: 7, name: 'Ada', tags: ['x', 'y'], active: true, owner: null }, items: [{ n: 1 }, { n: 2 }] }),
  bodyEncoding: 'utf8',
  size: 120,
  timings: { total: 41.6, ttfb: 30, download: 11 },
};

const check = (partial: Partial<Check>): Check => ({ id: 'c', enabled: true, on: 'status', path: '', op: 'eq', expected: '', ...partial });
const run = (partial: Partial<Check>) => evaluateCheck(check(partial), response);

describe('evaluateCheck', () => {
  it('compares the status, time and size as numbers', () => {
    expect(run({ expected: '201' })).toEqual({ id: 'c', ok: true, actual: '201', message: 'Status is 201' });
    expect(run({ expected: '200' })).toMatchObject({ ok: false, message: 'Expected Status to equal 200, got 201' });
    expect(run({ op: 'lt', expected: '300' }).ok).toBe(true);
    expect(run({ on: 'time', op: 'lt', expected: '40' })).toMatchObject({ ok: false, actual: '42', message: 'Expected Time to be less than 40, got 42 ms' });
    expect(run({ on: 'size', op: 'gt', expected: '100' }).ok).toBe(true);
    expect(run({ op: 'gt', expected: 'many' }).message).toBe('"many" is not a number');
  });

  it('reads headers by name, joining repeats, and says when one is missing', () => {
    expect(run({ on: 'header', path: 'content-type', op: 'contains', expected: 'json' }).ok).toBe(true);
    expect(run({ on: 'header', path: 'Set-Cookie', op: 'eq', expected: 'a=1, b=2' }).ok).toBe(true);
    expect(run({ on: 'header', path: 'X-Nope', op: 'exists' })).toMatchObject({ ok: false, actual: null, message: 'Expected Header X-Nope to exist: The response has no X-Nope header' });
    expect(run({ on: 'header', path: '', op: 'exists' }).message).toMatch(/Name the header/);
  });

  it('reads JSON paths with values compared as JSON, and several matches as an array', () => {
    expect(run({ on: 'jsonPath', path: '$.data.id', expected: '7' }).ok).toBe(true);
    expect(run({ on: 'jsonPath', path: '$.data.name', expected: 'Ada' }).ok).toBe(true);
    expect(run({ on: 'jsonPath', path: '$.data.active', expected: 'true' }).ok).toBe(true);
    expect(run({ on: 'jsonPath', path: '$.data.tags', expected: '["x","y"]' }).ok).toBe(true);
    expect(run({ on: 'jsonPath', path: '$.data.tags', op: 'contains', expected: 'y' }).ok).toBe(true);
    expect(run({ on: 'jsonPath', path: '$.items[*].n', op: 'contains', expected: '2' }).ok).toBe(true);
    expect(run({ on: 'jsonPath', path: '$.data.owner', op: 'isType', expected: 'null' }).ok).toBe(true);
    expect(run({ on: 'jsonPath', path: '$.items', op: 'isType', expected: 'object' })).toMatchObject({ ok: false, message: 'Expected $.items to be of type object, got array' });
    expect(run({ on: 'jsonPath', path: '$.data.missing', op: 'exists' }).ok).toBe(false);
    expect(run({ on: 'jsonPath', path: '$.data.missing', op: 'eq', expected: '1' }).message).toBe('$.data.missing matched nothing in the body');
    expect(run({ on: 'jsonPath', path: '$.data[', expected: '1' }).ok).toBe(false);
  });

  it('matches the body with a regular expression and reports a broken one', () => {
    expect(run({ on: 'body', op: 'matches', expected: '"name":"A\\w+"' }).ok).toBe(true);
    expect(run({ on: 'body', op: 'matches', expected: '(' }).message).toMatch(/is not a regular expression/);
    expect(run({ on: 'body', op: 'neq', expected: '' }).ok).toBe(true);
    expect(evaluateCheck(check({ on: 'jsonPath', path: '$', op: 'exists' }), { ...response, body: 'plain' }).message).toMatch(/not JSON/);
    expect(evaluateCheck(check({ on: 'body', op: 'contains', expected: 'x' }), { ...response, bodyEncoding: 'base64' }).message).toBe('The body is binary');
  });

  it('refuses a pattern that repeats a repeating group, and tests only the start of a long body', () => {
    for (const pattern of ['^(a+)+$', '(.*)*x', '((\\d+)-)*', '(a{1,3})+', '(a|b+)*', '(a+){2,}']) expect(hasNestedRepetition(pattern), pattern).toBe(true);
    for (const pattern of ['^a+$', '(a+)', '(a+){3}', '(ab)+', '[a+]+', '\\(a+\\)+', '(?:a|b)+c*', '(a+)?', '(a)+(b)*']) expect(hasNestedRepetition(pattern), pattern).toBe(false);
    const started = Date.now();
    const refused = run({ on: 'body', op: 'matches', expected: '^(a+)+$' });
    expect(refused.ok).toBe(false);
    expect(refused.message).toMatch(/repeats inside/);
    expect(Date.now() - started).toBeLessThan(500);
    const long = { ...response, body: `${'x'.repeat(MATCH_TEXT_LIMIT)}needle` };
    expect(evaluateCheck(check({ on: 'body', op: 'matches', expected: 'x{3}' }), long).ok).toBe(true);
    const miss = evaluateCheck(check({ on: 'body', op: 'matches', expected: 'needle' }), long);
    expect(miss.ok).toBe(false);
    expect(miss.message).toMatch(/in its first 64 KB/);
    expect(evaluateCheck(check({ on: 'body', op: 'matches', expected: 'needle' }), { ...response, body: 'a needle' }).ok).toBe(true);
  });
});

describe('evaluateChecks', () => {
  it('runs the enabled checks with variables resolved and sums them up', () => {
    const results = evaluateChecks(
      [check({ id: 'a', expected: '{{code}}' }), check({ id: 'b', enabled: false, expected: '500' }), check({ id: 'c', on: 'jsonPath', path: '$.data.id', expected: '8' })],
      response,
      (text) => text.replace('{{code}}', '201'),
    );
    expect(results.map((r) => [r.id, r.ok])).toEqual([
      ['a', true],
      ['c', false],
    ]);
    expect(checkSummary(results)).toEqual({ passed: 1, total: 2 });
    expect(checkSummary([])).toBeUndefined();
    expect(evaluateChecks(undefined, response)).toEqual([]);
  });

  it('scrubs known secrets from what a check read and from its message', () => {
    const results = evaluateChecks([check({ id: 't', on: 'header', path: 'content-type', op: 'contains', expected: 'json' })], response);
    expect(results[0]).toMatchObject({ ok: true, actual: 'application/json; charset=utf-8', message: 'Header content-type is "application/json; charset=utf-8"' });
    const scrubbed = scrubCheckResults(results, ['application/json']);
    expect(scrubbed[0]).toMatchObject({ ok: true, actual: `${REDACTED}; charset=utf-8`, message: `Header content-type is "${REDACTED}; charset=utf-8"` });
    expect(scrubCheckResults(results, [])).toBe(results);
    expect(scrubCheckResults([{ id: 'x', ok: false, actual: null, message: 'nothing' }], ['application/json'])[0].actual).toBeNull();
  });
});
