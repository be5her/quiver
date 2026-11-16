import type { DbKind } from './models/db';

/**
 * The workspace state key (per machine, under `.quiver/local`) that holds which schemas the Databases tree shows under
 * each connection: connection id to the names picked. A connection without an entry shows every schema.
 */
export const DB_SCHEMA_FILTER_KEY = 'db.schemaFilter';

export type DbSchemaFilters = Record<string, string[]>;

/** Whether a kind lists schemas (PostgreSQL) or databases (MySQL) under its connection in the tree, so it can filter them. */
export function hasSchemaFilter(kind: DbKind): boolean {
  return kind === 'mysql' || kind === 'postgres';
}

/** What the tree calls the level under a connection: "schemas" for PostgreSQL, "databases" for MySQL. */
export function schemaNoun(kind: DbKind, count = 2): string {
  const word = kind === 'mysql' ? 'database' : 'schema';
  return count === 1 ? word : `${word}s`;
}

/** The saved filters as read back from workspace state, anything malformed left out. */
export function parseSchemaFilters(value: unknown): DbSchemaFilters {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: DbSchemaFilters = {};
  for (const [id, names] of Object.entries(value)) {
    if (Array.isArray(names)) out[id] = [...new Set(names.filter((n): n is string => typeof n === 'string'))];
  }
  return out;
}

/**
 * The schemas to show, in the server's order: only the picked ones when there is a filter ("show only these"), so
 * a schema created on the server later stays hidden until it is picked. Without a filter (null), all of them.
 */
export function visibleSchemas(all: readonly string[], picked: readonly string[] | null | undefined): string[] {
  if (!picked) return [...all];
  const keep = new Set(picked);
  return all.filter((name) => keep.has(name));
}

/** The filters with one connection's set to `picked`, or dropped with null (show everything, or the connection is gone). */
export function withSchemaFilter(filters: DbSchemaFilters, connectionId: string, picked: readonly string[] | null): DbSchemaFilters {
  const next = { ...filters };
  if (picked) next[connectionId] = [...new Set(picked)];
  else delete next[connectionId];
  return next;
}
