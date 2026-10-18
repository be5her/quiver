import { jsonPath } from './json-path';
import type { ApiResponse, Check, CheckOp, CheckResult, CheckTarget } from './models/api';
import { scrubSecrets } from './redact';

/** The parts of a response checks read. */
export type CheckSourceResponse = Pick<ApiResponse, 'status' | 'headers' | 'body' | 'bodyEncoding' | 'size' | 'timings'>;

/** How much of a text a regex check is tested on: a pattern is applied to the first 64 KB of a body. */
export const MATCH_TEXT_LIMIT = 64 * 1024;

/** The index of the `]` closing a character class that opens at `from`, or the end of the pattern. */
function classEnd(pattern: string, from: number): number {
  for (let i = from + 1; i < pattern.length; i++) {
    if (pattern[i] === '\\') i++;
    else if (pattern[i] === ']') return i;
  }
  return pattern.length;
}

/**
 * Whether a pattern repeats a group that repeats inside (`(a+)+`, `(.*)*`, `((\d+)-)*`, `(a{1,3})+`):
 * on text that does not match, such a pattern tries every way of splitting it and runs for ages, on
 * the main process. A fixed count (`(a+){3}`) is left alone, as are classes and escapes.
 */
export function hasNestedRepetition(pattern: string): boolean {
  /** For each open group, whether something inside it repeats. */
  const open: boolean[] = [];
  let closedHadRepeat = false;
  let afterGroup = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\') {
      i++;
      afterGroup = false;
      continue;
    }
    if (c === '[') {
      i = classEnd(pattern, i);
      afterGroup = false;
      continue;
    }
    if (c === '(') {
      open.push(false);
      afterGroup = false;
      continue;
    }
    if (c === ')') {
      closedHadRepeat = open.pop() ?? false;
      afterGroup = true;
      continue;
    }
    const brace = c === '{' ? /^\{(\d+)(?:,(\d*))?\}/.exec(pattern.slice(i)) : null;
    const repeats = c === '+' || c === '*' || (brace !== null && brace[2] !== undefined && brace[1] !== brace[2]);
    if (repeats) {
      if (afterGroup && closedHadRepeat) return true;
      for (let d = 0; d < open.length; d++) open[d] = true;
    }
    if (brace) i += brace[0].length - 1;
    afterGroup = false;
  }
  return false;
}

export const CHECK_TARGETS: { value: CheckTarget; label: string; path?: string }[] = [
  { value: 'status', label: 'Status' },
  { value: 'jsonPath', label: 'JSON path', path: '$.data.id' },
  { value: 'header', label: 'Header', path: 'Content-Type' },
  { value: 'body', label: 'Body' },
  { value: 'time', label: 'Time (ms)' },
  { value: 'size', label: 'Size (bytes)' },
];

export const CHECK_OPS: { value: CheckOp; label: string }[] = [
  { value: 'eq', label: 'equals' },
  { value: 'neq', label: 'does not equal' },
  { value: 'lt', label: 'less than' },
  { value: 'gt', label: 'greater than' },
  { value: 'contains', label: 'contains' },
  { value: 'matches', label: 'matches regex' },
  { value: 'exists', label: 'exists' },
  { value: 'isType', label: 'is of type' },
];

/** Types `isType` knows, as JSON names them. */
export const CHECK_TYPES = ['string', 'number', 'boolean', 'object', 'array', 'null'] as const;

type Read = { found: true; value: unknown } | { found: false; why: string };

/** What a check reads from the response. A JSON path selecting several values reads them as an array. */
function read(check: Pick<Check, 'on' | 'path'>, response: CheckSourceResponse): Read {
  const path = check.path.trim();
  switch (check.on) {
    case 'status':
      return { found: true, value: response.status };
    case 'time':
      return { found: true, value: Math.round(response.timings.total) };
    case 'size':
      return { found: true, value: response.size };
    case 'header': {
      if (!path) return { found: false, why: 'Name the header to check' };
      const lower = path.toLowerCase();
      const values = response.headers.filter(([key]) => key.toLowerCase() === lower).map(([, value]) => value);
      return values.length ? { found: true, value: values.join(', ') } : { found: false, why: `The response has no ${path} header` };
    }
    case 'body':
      return response.bodyEncoding === 'utf8' ? { found: true, value: response.body } : { found: false, why: 'The body is binary' };
    case 'jsonPath': {
      if (response.bodyEncoding !== 'utf8') return { found: false, why: 'The body is binary' };
      let parsed: unknown;
      try {
        parsed = JSON.parse(response.body);
      } catch {
        return { found: false, why: 'The body is not JSON' };
      }
      let values: unknown[];
      try {
        values = jsonPath(parsed, path || '$');
      } catch (err) {
        return { found: false, why: (err as Error).message };
      }
      const defined = values.filter((v) => v !== undefined);
      if (!defined.length) return { found: false, why: `${path || '$'} matched nothing in the body` };
      return { found: true, value: defined.length === 1 ? defined[0] : defined };
    }
  }
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** Equal as the expected text means it: numbers as numbers, JSON values as JSON, strings as they are. */
function equals(actual: unknown, expected: string): boolean {
  if (typeof actual === 'string') return actual === expected;
  if (typeof actual === 'number') return expected.trim() !== '' && Number(expected) === actual;
  try {
    return JSON.stringify(JSON.parse(expected)) === JSON.stringify(actual);
  } catch {
    return asText(actual) === expected;
  }
}

function number(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

function label(check: Pick<Check, 'on' | 'path'>): string {
  const path = check.path.trim();
  switch (check.on) {
    case 'status':
      return 'Status';
    case 'time':
      return 'Time';
    case 'size':
      return 'Size';
    case 'body':
      return 'Body';
    case 'header':
      return `Header ${path}`;
    case 'jsonPath':
      return path || '$';
  }
}

function shown(check: Pick<Check, 'on'>, value: unknown): string {
  const text = asText(value);
  const short = text.length > 80 ? `${text.slice(0, 77)}…` : text;
  if (check.on === 'time') return `${short} ms`;
  if (check.on === 'size') return `${short} B`;
  return typeof value === 'string' ? `"${short}"` : short;
}

const OP_WORDS: Record<CheckOp, string> = {
  eq: 'to equal',
  neq: 'not to equal',
  lt: 'to be less than',
  gt: 'to be greater than',
  contains: 'to contain',
  matches: 'to match',
  exists: 'to exist',
  isType: 'to be of type',
};

/** One check against a response; `expected` should already have its variables resolved. */
export function evaluateCheck(check: Check, response: CheckSourceResponse): CheckResult {
  const what = label(check);
  const expected = check.expected;
  const got = read(check, response);
  const want = check.op === 'exists' ? `${what} to exist` : `${what} ${OP_WORDS[check.op]} ${check.op === 'matches' ? `/${expected}/` : expected}`;
  if (!got.found) return { id: check.id, ok: false, actual: null, message: check.op === 'exists' ? `Expected ${want}: ${got.why}` : got.why };
  const actual = got.value;
  const result = (ok: boolean, why?: string): CheckResult => ({
    id: check.id,
    ok,
    actual: asText(actual),
    message: ok ? `${what} is ${shown(check, actual)}` : why ?? `Expected ${want}, got ${shown(check, actual)}`,
  });
  switch (check.op) {
    case 'exists':
      return result(true);
    case 'eq':
      return result(equals(actual, expected));
    case 'neq':
      return result(!equals(actual, expected));
    case 'lt':
    case 'gt': {
      const a = number(actual);
      const e = number(expected);
      if (e === null) return result(false, `"${expected}" is not a number`);
      if (a === null) return result(false, `Expected ${want}, got ${shown(check, actual)}, which is not a number`);
      return result(check.op === 'lt' ? a < e : a > e);
    }
    case 'contains':
      return result(Array.isArray(actual) ? actual.some((item) => equals(item, expected)) : asText(actual).includes(expected));
    case 'matches': {
      if (hasNestedRepetition(expected)) return result(false, `/${expected}/ is not a regular expression Quiver runs: a repeated group that repeats inside, like (a+)+, can take forever on text that does not match`);
      let pattern: RegExp;
      try {
        pattern = new RegExp(expected);
      } catch (err) {
        return result(false, `/${expected}/ is not a regular expression: ${(err as Error).message}`);
      }
      // A body can be megabytes: the pattern is tried on its start only, and a miss says so.
      const text = asText(actual);
      const ok = pattern.test(text.length > MATCH_TEXT_LIMIT ? text.slice(0, MATCH_TEXT_LIMIT) : text);
      return result(ok, ok || text.length <= MATCH_TEXT_LIMIT ? undefined : `Expected ${want} in its first ${MATCH_TEXT_LIMIT / 1024} KB, got ${shown(check, actual)}`);
    }
    case 'isType':
      return result(typeOf(actual) === expected.trim().toLowerCase(), `Expected ${want}, got ${typeOf(actual)}`);
  }
}

/** The enabled checks of a request against its response, `{{variables}}` in `expected` resolved by `resolve`. */
export function evaluateChecks(checks: Check[] | undefined, response: CheckSourceResponse, resolve: (text: string) => string = (t) => t): CheckResult[] {
  return (checks ?? []).filter((c) => c.enabled).map((c) => evaluateCheck({ ...c, expected: resolve(c.expected) }, response));
}

/**
 * Check results as they may be written down or handed to an agent: the known secret values scrubbed
 * from what each check read and from the message quoting it. A check on a token's JSON path, or on a
 * header a secret capture reads, would otherwise put the value in the run log in plain text.
 */
export function scrubCheckResults(results: CheckResult[], secretValues: string[]): CheckResult[] {
  if (!secretValues.length) return results;
  return results.map((r) => ({ ...r, actual: r.actual === null ? null : scrubSecrets(r.actual, secretValues), message: scrubSecrets(r.message, secretValues) }));
}

/** Passed and total, for the history and the status line. */
export function checkSummary(results: CheckResult[] | undefined): { passed: number; total: number } | undefined {
  if (!results?.length) return undefined;
  return { passed: results.filter((r) => r.ok).length, total: results.length };
}
