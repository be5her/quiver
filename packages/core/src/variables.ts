import type { Variable } from './types';

const PLACEHOLDER = /\{\{\s*([A-Za-z_$][\w.-]*)\s*\}\}/g;

/** What each built-in dynamic variable produces, for hover help. */
export const DYNAMIC_VARIABLE_HELP: Record<string, string> = {
  $uuid: 'A new random UUID',
  $timestamp: 'Unix time in seconds',
  $timestampMs: 'Unix time in milliseconds',
  $isoTimestamp: 'The current time as ISO 8601',
  $randomInt: 'A random integer from 0 to 999',
};

/** Built-in dynamic values, addressed as `{{$name}}`. */
const dynamics: Record<string, () => string> = {
  $uuid: () => globalThis.crypto.randomUUID(),
  $timestamp: () => String(Math.floor(Date.now() / 1000)),
  $timestampMs: () => String(Date.now()),
  $isoTimestamp: () => new Date().toISOString(),
  $randomInt: () => String(Math.floor(Math.random() * 1000)),
};

/**
 * Flatten variable layers into one map. Later layers override earlier ones,
 * so pass them as [global, environment, request-local].
 */
export function buildVariableMap(layers: Variable[][]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const layer of layers) {
    for (const v of layer) {
      if (!v.enabled || !v.key.trim()) continue;
      map[v.key.trim()] = v.value;
    }
  }
  return map;
}

export function resolveTemplate(input: string, vars: Record<string, string>): string {
  if (!input || !input.includes('{{')) return input;
  return input.replace(PLACEHOLDER, (whole, name: string) => {
    if (name in vars) return vars[name];
    if (name in dynamics) return dynamics[name]();
    return whole;
  });
}

export function findUnresolved(input: string, vars: Record<string, string>): string[] {
  const missing = new Set<string>();
  for (const match of input.matchAll(PLACEHOLDER)) {
    const name = match[1];
    if (!(name in vars) && !(name in dynamics)) missing.add(name);
  }
  return [...missing];
}

/** Resolve every string leaf of an object tree. Non-strings pass through. */
export function resolveDeep<T>(value: T, vars: Record<string, string>): T {
  if (typeof value === 'string') return resolveTemplate(value, vars) as T;
  if (Array.isArray(value)) return value.map((v) => resolveDeep(v, vars)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = resolveDeep(v, vars);
    return out as T;
  }
  return value;
}

export function listDynamicVariables(): string[] {
  return Object.keys(dynamics);
}

export interface VariableSpan {
  /** Offset of the opening `{{`. */
  from: number;
  /** Offset just past the closing `}}`. */
  to: number;
  name: string;
}

/** Where `{{name}}` placeholders sit in a string, with the same rules the resolver uses. */
export function findVariableSpans(input: string): VariableSpan[] {
  if (!input || !input.includes('{{')) return [];
  return [...input.matchAll(PLACEHOLDER)].map((m) => ({ from: m.index, to: m.index + m[0].length, name: m[1] }));
}

export function isDynamicVariable(name: string): boolean {
  return name in dynamics;
}
