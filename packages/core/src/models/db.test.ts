import { describe, expect, it } from 'vitest';
import {
  DbConnectionSchema,
  dbConnectionOrderOf,
  dbConnectionsLastUsed,
  isDbConnectionSort,
  moveDbConnection,
  newDbConnection,
  reorderDbConnections,
  resolveConnectionTemplate,
  sortDbConnections,
  type DbKind,
} from './db';

describe('resolveConnectionTemplate', () => {
  it('resolves variables in the fields that name a server, a file or a tunnel', () => {
    const conn = newDbConnection('mysql', {
      host: '{{DB_HOST}}',
      user: '{{DB_USER}}',
      database: 'app_{{env}}',
      access: { type: 'command', command: 'ssh -L {port}:{{DB_HOST}}:3306 bastion' },
    });
    const resolved = resolveConnectionTemplate(conn, { DB_HOST: 'db.internal', DB_USER: 'app', env: 'prod' });
    expect(resolved).toMatchObject({ host: 'db.internal', user: 'app', database: 'app_prod', access: { type: 'command', command: 'ssh -L {port}:db.internal:3306 bastion' } });
    expect(resolveConnectionTemplate(conn, {}).host).toBe('{{DB_HOST}}');
  });
  it('defaults the production flag to false for older connections', () => {
    const parsed = DbConnectionSchema.parse({ id: 'x', name: 'n', kind: 'postgres', createdAt: 't', updatedAt: 't' });
    expect(parsed.production).toBe(false);
    expect(parsed.port).toBe(0);
  });
});

describe('connection order', () => {
  const conn = (id: string, name: string, kind: DbKind) => ({ id, name, kind });
  const list = [conn('a', 'staging', 'postgres'), conn('b', 'cache', 'redis'), conn('c', 'prod', 'mysql'), conn('d', 'app 10', 'sqlite'), conn('e', 'app 2', 'postgres')];
  // c then a were placed by hand; 'gone' was deleted since.
  const order = ['c', 'gone', 'a'];
  const ids = (cs: { id: string }[]) => cs.map((c) => c.id).join();

  it('keeps the manual order first, then the rest by name with numbers in order', () => {
    expect(ids(sortDbConnections(list, 'manual', { order }))).toBe('c,a,e,d,b');
    expect(ids(sortDbConnections(list, 'manual'))).toBe('e,d,b,c,a');
  });
  it('sorts by name, by type and by last use, keeping the manual order for ties', () => {
    expect(ids(sortDbConnections(list, 'name', { order }))).toBe('e,d,b,c,a');
    // MySQL, PostgreSQL (manual: staging, then app 2), Redis, SQLite.
    expect(ids(sortDbConnections(list, 'kind', { order }))).toBe('c,a,e,b,d');
    const lastUsed = dbConnectionsLastUsed([
      { connectionId: 'b', at: '2026-01-01T00:00:00Z' },
      { connectionId: 'd', at: '2026-03-01T00:00:00Z' },
      { connectionId: 'b', at: '2026-02-01T00:00:00Z' },
    ]);
    expect(lastUsed).toEqual({ b: '2026-02-01T00:00:00Z', d: '2026-03-01T00:00:00Z' });
    expect(ids(sortDbConnections(list, 'recent', { order, lastUsed }))).toBe('d,b,c,a,e');
  });
  it('moves a connection to where it was dropped among the others, or one step', () => {
    const manual = sortDbConnections(list, 'manual', { order }).map((c) => c.id);
    expect(moveDbConnection(manual, 'b', 0).join()).toBe('b,c,a,e,d');
    expect(moveDbConnection(manual, 'c', 99).join()).toBe('a,e,d,b,c');
    expect(moveDbConnection(manual, 'a', 2).join()).toBe('c,e,a,d,b');
    expect(moveDbConnection(manual, 'a', 0).join()).toBe('a,c,e,d,b');
    expect(moveDbConnection(manual, 'missing', 0).join()).toBe('c,a,e,d,b');
  });
  it('reorders the named ids first and keeps the others placed in their order, dropping deleted ones', () => {
    const existing = list.map((c) => c.id);
    expect(reorderDbConnections(['c', 'gone', 'a', 'e'], ['e', 'b', 'e'], existing).join()).toBe('e,b,c,a');
    expect(reorderDbConnections([], ['a', 'nope'], existing).join()).toBe('a');
  });
  it('reads a stored order and knows the sort modes', () => {
    expect(dbConnectionOrderOf(['a', 1, 'b'])).toEqual(['a', 'b']);
    expect(dbConnectionOrderOf(null)).toEqual([]);
    expect(isDbConnectionSort('kind')).toBe(true);
    expect(isDbConnectionSort('size')).toBe(false);
    expect(isDbConnectionSort(null)).toBe(false);
  });
});
