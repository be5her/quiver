import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ApiRequestSchema } from './models/api';
import { keepUnknownFields } from './unknown-fields';

describe('keepUnknownFields', () => {
  const ts = '2026-01-01T00:00:00.000Z';
  const header = (id: string, key: string) => ({ id, key, value: 'v', enabled: true });
  /** A request file as a newer Quiver wrote it: fields at the top, in a header, in the body and in the auth. */
  const stored = {
    id: 'r1',
    name: 'Get user',
    collectionId: null,
    method: 'GET',
    url: 'https://example.test',
    params: [],
    headers: [{ ...header('h1', 'Accept'), note: 'from v9' }, header('h2', 'X-Old')],
    body: { type: 'json', content: '{}', schemaRef: 'User' },
    auth: { type: 'bearer', token: 't', prefix: 'Token' },
    retries: 3,
    createdAt: ts,
    updatedAt: ts,
  };
  /** The same request edited and saved by this version: parsed through the schema, so the new fields are gone. */
  const saved = ApiRequestSchema.parse({ ...stored, name: 'Get a user', headers: [{ ...stored.headers[0], value: 'json' }], updatedAt: 'later' });

  it('puts back unknown fields at the top, in array items matched by id, and in a union option that still fits', () => {
    expect(saved).not.toHaveProperty('retries');
    expect(keepUnknownFields(ApiRequestSchema, stored, saved)).toEqual({
      ...saved,
      retries: 3,
      headers: [{ ...header('h1', 'Accept'), value: 'json', note: 'from v9' }],
      body: { type: 'json', content: '{}', schemaRef: 'User' },
      auth: { type: 'bearer', token: 't', prefix: 'Token' },
    });
  });

  it('keeps out known fields the save left out, items it removed, and everything of a union option it switched from', () => {
    const switched = { ...saved, body: { type: 'none' as const }, auth: { type: 'basic' as const, username: 'u', password: 'p' }, description: undefined };
    const result = keepUnknownFields(ApiRequestSchema, { ...stored, description: 'gone' }, switched);
    expect(result.body).toEqual({ type: 'none' });
    expect(result.auth).toEqual({ type: 'basic', username: 'u', password: 'p' });
    expect(result.headers).toHaveLength(1);
    expect(result.description).toBeUndefined();
  });

  it('leaves the saved value alone with nothing stored, and lets loose and strict objects decide for themselves', () => {
    expect(keepUnknownFields(ApiRequestSchema, undefined, saved)).toBe(saved);
    const strict = z.object({ inner: z.strictObject({ a: z.number() }) });
    expect(keepUnknownFields(strict, { inner: { a: 1, b: 2 } }, { inner: { a: 3 } })).toEqual({ inner: { a: 3 } });
    const loose = z.looseObject({ a: z.number() });
    expect(keepUnknownFields(loose, { a: 1, b: 2 }, { a: 3 })).toEqual({ a: 3 });
  });

  it('follows records by key and goes through optional, nullable, default and lazy wrappers', () => {
    const schema = z.object({ byName: z.record(z.string(), z.object({ a: z.number() })).nullable().default({}), later: z.lazy(() => z.object({ a: z.number() })).optional() });
    const previous = { byName: { x: { a: 1, extra: true }, y: { a: 2, extra: true } }, later: { a: 1, extra: true } };
    expect(keepUnknownFields(schema, previous, { byName: { x: { a: 5 } }, later: { a: 6 } })).toEqual({ byName: { x: { a: 5, extra: true } }, later: { a: 6, extra: true } });
  });
});
