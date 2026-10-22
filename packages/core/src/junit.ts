import type { ApiRun, ApiRunItem } from './models/api';

/** Characters XML 1.0 cannot hold at all, even escaped; a response can carry them. */
// eslint-disable-next-line no-control-regex
const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;

function xml(text: string): string {
  return text.replace(INVALID_XML, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function seconds(ms: number | null | undefined): string {
  return ((ms ?? 0) / 1000).toFixed(3);
}

function runMs(run: ApiRun): number {
  if (run.finishedAt) {
    const ms = Date.parse(run.finishedAt) - Date.parse(run.startedAt);
    if (Number.isFinite(ms) && ms >= 0) return ms;
  }
  return run.items.reduce((sum, item) => sum + (item.durationMs ?? 0), 0);
}

function testcase(run: ApiRun, item: ApiRunItem): string {
  const attrs = `name="${xml(item.name)}" classname="${xml(run.collectionName)}" time="${seconds(item.durationMs)}"`;
  const sent = `${item.method} ${item.url ?? ''}${item.httpStatus !== null ? ` -> ${item.httpStatus}` : ''}`;
  const checks = (item.checks ?? []).map((c) => `${c.ok ? 'PASS' : 'FAIL'} ${c.message}`);
  const out = `      <system-out>${xml([sent, ...checks].join('\n'))}</system-out>\n`;
  switch (item.status) {
    case 'passed':
      return `    <testcase ${attrs}>\n${out}    </testcase>\n`;
    case 'failed': {
      const failed = (item.checks ?? []).filter((c) => !c.ok);
      const message = failed.length ? failed.map((c) => c.message).join('; ') : (item.error ?? 'Failed');
      return `    <testcase ${attrs}>\n      <failure type="check" message="${xml(message)}">${xml(failed.map((c) => c.message).join('\n') || message)}</failure>\n${out}    </testcase>\n`;
    }
    case 'error': {
      const message = item.error ?? 'No response came back';
      return `    <testcase ${attrs}>\n      <error type="request" message="${xml(message)}">${xml(message)}</error>\n${out}    </testcase>\n`;
    }
    default: {
      const message = item.status === 'cancelled' ? 'The run was cancelled' : item.status === 'skipped' ? 'Skipped after an earlier failure' : 'Not run';
      return `    <testcase ${attrs}>\n      <skipped message="${xml(message)}"/>\n    </testcase>\n`;
    }
  }
}

/**
 * A finished collection run as a JUnit XML report, for CI: one test suite per run, one test case per request.
 * A request whose checks failed is a failure, one with no response an error, one that never ran skipped.
 */
export function junitReport(runs: ApiRun[]): string {
  const count = (run: ApiRun, ...statuses: string[]) => run.items.filter((i) => statuses.includes(i.status)).length;
  const totals = { tests: 0, failures: 0, errors: 0, skipped: 0, ms: 0 };
  const suites = runs.map((run) => {
    const tests = run.items.length;
    const failures = count(run, 'failed');
    const errors = count(run, 'error');
    const skipped = count(run, 'skipped', 'cancelled', 'pending', 'running');
    const ms = runMs(run);
    totals.tests += tests;
    totals.failures += failures;
    totals.errors += errors;
    totals.skipped += skipped;
    totals.ms += ms;
    const cases = run.items.map((item) => testcase(run, item)).join('');
    return `  <testsuite name="${xml(run.collectionName)}" tests="${tests}" failures="${failures}" errors="${errors}" skipped="${skipped}" time="${seconds(ms)}" timestamp="${xml(run.startedAt)}">\n${cases}  </testsuite>\n`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="Quiver" tests="${totals.tests}" failures="${totals.failures}" errors="${totals.errors}" skipped="${totals.skipped}" time="${seconds(totals.ms)}">\n${suites.join('')}</testsuites>\n`;
}
