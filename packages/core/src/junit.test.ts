import { describe, expect, it } from 'vitest';
import { junitReport } from './junit';
import type { ApiRun } from './models/api';

const run: ApiRun = {
  id: 'r1',
  collectionId: 'c1',
  collectionName: 'Orders & <payments>',
  environmentId: null,
  startedAt: '2026-10-22T10:00:00.000Z',
  finishedAt: '2026-10-22T10:00:01.500Z',
  status: 'failed',
  stopOnFail: false,
  passed: 1,
  failed: 2,
  items: [
    { requestId: 'a', name: 'List orders', method: 'GET', url: 'http://127.0.0.1/orders', status: 'passed', httpStatus: 200, durationMs: 120, checks: [{ id: 'k1', ok: true, actual: '200', message: 'Status is 200' }] },
    {
      requestId: 'b',
      name: 'Create "order"',
      method: 'POST',
      url: 'http://127.0.0.1/orders',
      status: 'failed',
      httpStatus: 500,
      durationMs: 80,
      checks: [
        { id: 'k2', ok: false, actual: '500', message: 'Expected status equals 201, got 500' },
        { id: 'k3', ok: true, actual: 'x', message: 'Header is x' },
      ],
    },
    { requestId: 'c', name: 'Refund', method: 'POST', url: null, status: 'error', httpStatus: null, durationMs: null, error: 'connect ECONNREFUSED\u0001' },
    { requestId: 'd', name: 'Cleanup', method: 'DELETE', url: null, status: 'skipped', httpStatus: null, durationMs: null },
  ],
};

describe('junitReport', () => {
  const xml = junitReport([run]);

  it('counts tests, failures, errors and skipped, with the run time', () => {
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="Quiver" tests="4" failures="1" errors="1" skipped="1" time="1.500">')).toBe(true);
    expect(xml).toContain('<testsuite name="Orders &amp; &lt;payments&gt;" tests="4" failures="1" errors="1" skipped="1" time="1.500" timestamp="2026-10-22T10:00:00.000Z">');
  });

  it('writes one test case per request', () => {
    expect(xml.match(/<testcase /g)).toHaveLength(4);
    expect(xml).toContain('<testcase name="List orders" classname="Orders &amp; &lt;payments&gt;" time="0.120">');
    expect(xml).toContain('<testcase name="Create &quot;order&quot;"');
  });

  it('gives a failed check as a failure, no response as an error, an item not run as skipped', () => {
    expect(xml).toContain('<failure type="check" message="Expected status equals 201, got 500">Expected status equals 201, got 500</failure>');
    expect(xml).toContain('<error type="request" message="connect ECONNREFUSED">connect ECONNREFUSED</error>');
    expect(xml).toContain('<skipped message="Skipped after an earlier failure"/>');
    expect(xml).toContain('<system-out>POST http://127.0.0.1/orders -&gt; 500\nFAIL Expected status equals 201, got 500\nPASS Header is x</system-out>');
  });

  it('leaves out characters XML cannot hold', () => {
    expect(xml).not.toContain('\u0001');
  });

  it('leaves out half a surrogate pair and keeps whole ones', () => {
    const broken = junitReport([{ ...run, collectionName: 'a\uD800b\uDC00c 😀' }]);
    expect(broken).toContain('name="abc 😀"');
  });

  it('adds runs up', () => {
    expect(junitReport([run, { ...run, id: 'r2' }])).toContain('<testsuites name="Quiver" tests="8" failures="2" errors="2" skipped="2" time="3.000">');
    expect(junitReport([])).toBe('<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="Quiver" tests="0" failures="0" errors="0" skipped="0" time="0.000">\n</testsuites>\n');
  });
});
