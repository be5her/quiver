import { parseSetCookie } from './cookies';
import { jsonPath } from './json-path';
import type { ApiResponse, Capture } from './models/api';
import { isSecretName } from './redact';
import { DEFINABLE_VARIABLE_NAME } from './variables';

export type CaptureResult = { ok: true; value: string } | { ok: false; error: string };

/**
 * Whether what a capture writes is a secret: when it is marked so, when its variable is named like a
 * credential (`token`, `password`, `apiKey`), or when the variable it writes is already secret in
 * `variables`. A credential captured with the box unticked would otherwise land in the committed
 * environment file in plain text.
 */
export function captureIsSecret(capture: Pick<Capture, 'variable' | 'secret'>, variables: { key: string; enabled: boolean; secret?: boolean }[] = []): boolean {
  const name = capture.variable.trim();
  return capture.secret || isSecretName(name) || variables.some((v) => v.enabled && v.key.trim() === name && v.secret === true);
}

/** The parts of a response a capture reads. */
export type CaptureSourceResponse = Pick<ApiResponse, 'status' | 'headers' | 'body' | 'bodyEncoding' | 'setCookies'>;

/**
 * Read one capture from a response: the status code; a header by name (case-insensitive, the last
 * one when repeated); a cookie the response set, by name; or the body, whole when the path is empty,
 * else the first value a JSON path selects (strings as they are, anything else as JSON).
 */
export function extractCapture(capture: Pick<Capture, 'variable' | 'from' | 'path'>, response: CaptureSourceResponse): CaptureResult {
  const name = capture.variable.trim();
  if (!DEFINABLE_VARIABLE_NAME.test(name)) return { ok: false, error: `"${name}" is not a variable name (letters, digits, _, . and -, starting with a letter or _)` };
  const path = capture.path.trim();
  switch (capture.from) {
    case 'status':
      return { ok: true, value: String(response.status) };
    case 'header': {
      if (!path) return { ok: false, error: 'Name the header to capture' };
      const lower = path.toLowerCase();
      const found = response.headers.filter(([key]) => key.toLowerCase() === lower).pop();
      return found ? { ok: true, value: found[1] } : { ok: false, error: `The response has no ${path} header` };
    }
    case 'cookie': {
      if (!path) return { ok: false, error: 'Name the cookie to capture' };
      const cookie = response.setCookies
        .map((header) => parseSetCookie(header))
        .filter((c) => c?.name === path)
        .pop();
      return cookie ? { ok: true, value: cookie.value } : { ok: false, error: `The response set no ${path} cookie` };
    }
    case 'body': {
      if (response.bodyEncoding !== 'utf8') return { ok: false, error: 'The body is binary' };
      if (!path) return { ok: true, value: response.body };
      let parsed: unknown;
      try {
        parsed = JSON.parse(response.body);
      } catch {
        return { ok: false, error: 'The body is not JSON' };
      }
      let values: unknown[];
      try {
        values = jsonPath(parsed, path);
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
      if (!values.length || values[0] === undefined) return { ok: false, error: `${path} matched nothing in the body` };
      const value = values[0];
      return { ok: true, value: typeof value === 'string' ? value : JSON.stringify(value) };
    }
  }
}
