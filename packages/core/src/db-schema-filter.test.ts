import { describe, expect, it } from 'vitest';
import { hasSchemaFilter, parseSchemaFilters, schemaNoun, visibleSchemas, withSchemaFilter } from './db-schema-filter';

describe('schema filter', () => {
  it('applies to the kinds whose tree lists schemas or databases', () => {
    expect(['mysql', 'postgres', 'sqlite', 'redis'].filter((k) => hasSchemaFilter(k as never))).toEqual(['mysql', 'postgres']);
    expect(schemaNoun('postgres')).toBe('schemas');
    expect(schemaNoun('mysql', 1)).toBe('database');
  });

  it('shows everything without a filter and only the picked ones, in server order, with one', () => {
    const all = ['public', 'audit', 'billing', 'reporting'];
    expect(visibleSchemas(all, null)).toEqual(all);
    expect(visibleSchemas(all, undefined)).toEqual(all);
    expect(visibleSchemas(all, ['reporting', 'public'])).toEqual(['public', 'reporting']);
    // Picked schemas that are gone from the server are simply not shown; new ones stay hidden.
    expect(visibleSchemas([...all, 'new_one'], ['public', 'dropped'])).toEqual(['public']);
    expect(visibleSchemas(all, [])).toEqual([]);
  });

  it('reads back saved filters, leaving out what is malformed', () => {
    expect(parseSchemaFilters(null)).toEqual({});
    expect(parseSchemaFilters(['a'])).toEqual({});
    expect(parseSchemaFilters({ a: ['public', 'public', 3, 'x'], b: 'nope', c: [] })).toEqual({ a: ['public', 'x'], c: [] });
  });

  it('sets and drops one connection without touching the others', () => {
    const start = { a: ['public'], b: ['x'] };
    expect(withSchemaFilter(start, 'a', ['y', 'y', 'z'])).toEqual({ a: ['y', 'z'], b: ['x'] });
    expect(withSchemaFilter(start, 'a', null)).toEqual({ b: ['x'] });
    expect(withSchemaFilter(start, 'missing', null)).toEqual(start);
    expect(start).toEqual({ a: ['public'], b: ['x'] });
  });
});
