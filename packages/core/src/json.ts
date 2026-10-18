// JSON.parse source text access (Node 21+, Chromium 114+), not in the ES2023 lib yet.
const rawJSON = (JSON as unknown as { rawJSON?: (text: string) => unknown }).rawJSON;

/** Keeps every number as written, so a 64-bit id or `1.50` reads the same after formatting. */
function exactNumbers(_key: string, value: unknown, context?: { source?: string }): unknown {
  return typeof value === 'number' && rawJSON && context?.source !== undefined ? rawJSON(context.source) : value;
}

/**
 * Pretty-prints text that holds a JSON object or array, or null when it does not, so plain
 * strings, numbers and broken JSON stay as they were.
 */
export function prettyJson(text: string, indent = 2): string | null {
  const trimmed = text.trim();
  if (!/^[[{]/.test(trimmed)) return null;
  try {
    return JSON.stringify(JSON.parse(trimmed, exactNumbers), null, indent);
  } catch {
    return null;
  }
}

/** JSON with keys sorted at every depth and two-space indents, so two bodies compare by content; null when it is not JSON. */
export function normalizeJson(text: string): string | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])]));
    return v;
  };
  return JSON.stringify(sort(value), null, 2);
}
