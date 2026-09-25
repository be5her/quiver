import { createHash } from 'node:crypto';
import { QuiverError, defineCommand, defineModule } from '@quiver/core';
import { z } from 'zod';

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new QuiverError('INVALID_INPUT', `Invalid JSON: ${(err as Error).message}`);
  }
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKeysDeep((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

const jsonFormat = defineCommand({
  id: 'tools.json.format',
  title: 'Format JSON',
  description: 'Pretty-prints JSON with the given indent. Optionally sorts object keys.',
  scope: 'global',
  input: z.object({ text: z.string(), indent: z.number().int().min(0).max(8).default(2), sortKeys: z.boolean().default(false) }),
  handler: async ({ text, indent, sortKeys }) => {
    const value = parseJson(text);
    return { text: JSON.stringify(sortKeys ? sortKeysDeep(value) : value, null, indent) };
  },
});

const jsonMinify = defineCommand({
  id: 'tools.json.minify',
  title: 'Minify JSON',
  description: 'Removes whitespace from JSON.',
  scope: 'global',
  input: z.object({ text: z.string() }),
  handler: async ({ text }) => ({ text: JSON.stringify(parseJson(text)) }),
});

const base64Encode = defineCommand({
  id: 'tools.base64.encode',
  title: 'Base64 encode',
  description: 'Encodes UTF-8 text as base64 (standard or URL-safe).',
  scope: 'global',
  input: z.object({ text: z.string(), urlSafe: z.boolean().default(false) }),
  handler: async ({ text, urlSafe }) => ({ text: Buffer.from(text, 'utf8').toString(urlSafe ? 'base64url' : 'base64') }),
});

const base64Decode = defineCommand({
  id: 'tools.base64.decode',
  title: 'Base64 decode',
  description: 'Decodes base64 or base64url into UTF-8 text.',
  scope: 'global',
  input: z.object({ text: z.string() }),
  handler: async ({ text }) => ({ text: Buffer.from(text.trim(), 'base64').toString('utf8') }),
});

const urlEncode = defineCommand({
  id: 'tools.url.encode',
  title: 'URL encode',
  description: 'Percent-encodes text. Component mode also encodes reserved characters like / and ?.',
  scope: 'global',
  input: z.object({ text: z.string(), component: z.boolean().default(true) }),
  handler: async ({ text, component }) => ({ text: component ? encodeURIComponent(text) : encodeURI(text) }),
});

const urlDecode = defineCommand({
  id: 'tools.url.decode',
  title: 'URL decode',
  description: 'Decodes percent-encoded text.',
  scope: 'global',
  input: z.object({ text: z.string() }),
  handler: async ({ text }) => {
    try {
      return { text: decodeURIComponent(text.replace(/\+/g, ' ')) };
    } catch (err) {
      throw new QuiverError('INVALID_INPUT', (err as Error).message);
    }
  },
});

function decodeSegment(segment: string): unknown {
  const json = Buffer.from(segment, 'base64url').toString('utf8');
  return parseJson(json);
}

const jwtDecode = defineCommand({
  id: 'tools.jwt.decode',
  title: 'Decode JWT',
  description: 'Decodes a JSON Web Token without verifying it. Reports expiry.',
  scope: 'global',
  input: z.object({ token: z.string() }),
  handler: async ({ token }) => {
    const parts = token.trim().replace(/^bearer\s+/i, '').split('.');
    if (parts.length !== 3) throw new QuiverError('INVALID_INPUT', 'A JWT has three dot-separated parts');
    const header = decodeSegment(parts[0]) as Record<string, unknown>;
    const payload = decodeSegment(parts[1]) as Record<string, unknown>;
    const toDate = (v: unknown) => (typeof v === 'number' ? new Date(v * 1000).toISOString() : null);
    const exp = typeof payload.exp === 'number' ? payload.exp : null;
    return {
      header,
      payload,
      signature: parts[2],
      issuedAt: toDate(payload.iat),
      notBefore: toDate(payload.nbf),
      expiresAt: toDate(exp),
      isExpired: exp !== null ? exp * 1000 < Date.now() : null,
    };
  },
});

const uuidGenerate = defineCommand({
  id: 'tools.uuid.generate',
  title: 'Generate UUID',
  description: 'Generates one or more random v4 UUIDs.',
  scope: 'global',
  input: z.object({ count: z.number().int().min(1).max(100).default(1), uppercase: z.boolean().default(false) }),
  handler: async ({ count, uppercase }) => {
    const ids = Array.from({ length: count }, () => globalThis.crypto.randomUUID());
    const text = (uppercase ? ids.map((i) => i.toUpperCase()) : ids).join('\n');
    return { text, ids };
  },
});

const hashDigest = defineCommand({
  id: 'tools.hash.digest',
  title: 'Hash text',
  description: 'Computes a hex digest of UTF-8 text.',
  scope: 'global',
  input: z.object({ text: z.string(), algorithm: z.enum(['md5', 'sha1', 'sha256', 'sha512']).default('sha256') }),
  handler: async ({ text, algorithm }) => ({ text: createHash(algorithm).update(text, 'utf8').digest('hex'), algorithm }),
});

const timestampConvert = defineCommand({
  id: 'tools.timestamp.convert',
  title: 'Convert timestamp',
  description: 'Accepts unix seconds, unix milliseconds, an ISO date, or "now" and returns every common representation.',
  scope: 'global',
  input: z.object({ value: z.string().default('now') }),
  handler: async ({ value }) => {
    const raw = value.trim();
    let date: Date;
    if (!raw || raw === 'now') date = new Date();
    else if (/^-?\d+$/.test(raw)) {
      const n = Number(raw);
      date = new Date(Math.abs(n) < 1e11 ? n * 1000 : n);
    } else date = new Date(raw);
    if (Number.isNaN(date.getTime())) throw new QuiverError('INVALID_INPUT', `Cannot parse "${raw}" as a date`);
    const diff = date.getTime() - Date.now();
    return {
      iso: date.toISOString(),
      unixSeconds: Math.floor(date.getTime() / 1000),
      unixMs: date.getTime(),
      utc: date.toUTCString(),
      local: date.toString(),
      relative: relative(diff),
      dayOfWeek: date.toLocaleDateString('en-US', { weekday: 'long' }),
    };
  },
});

function relative(diffMs: number): string {
  const abs = Math.abs(diffMs);
  const units: [string, number][] = [
    ['year', 365 * 24 * 3600e3],
    ['month', 30 * 24 * 3600e3],
    ['day', 24 * 3600e3],
    ['hour', 3600e3],
    ['minute', 60e3],
    ['second', 1e3],
  ];
  for (const [name, size] of units) {
    if (abs >= size) {
      const n = Math.round(abs / size);
      return `${n} ${name}${n === 1 ? '' : 's'} ${diffMs < 0 ? 'ago' : 'from now'}`;
    }
  }
  return 'now';
}

export const toolsModule = defineModule({
  id: 'tools',
  commands: [jsonFormat, jsonMinify, base64Encode, base64Decode, urlEncode, urlDecode, jwtDecode, uuidGenerate, hashDigest, timestampConvert],
});
