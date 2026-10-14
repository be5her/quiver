import { describe, expect, it } from 'vitest';
import { parseConnectionUrl } from './db-url';

describe('parseConnectionUrl', () => {
  it('reads a MySQL URL with credentials and a database', () => {
    expect(parseConnectionUrl('mysql://root:p%40ss@db.internal:3307/shop')).toEqual({
      connection: { kind: 'mysql', host: 'db.internal', port: 3307, user: 'root', ssl: false, database: 'shop', name: 'MySQL db.internal' },
      password: 'p@ss',
    });
  });
  it('reads Postgres URLs and sslmode', () => {
    const parsed = parseConnectionUrl('postgresql://app@localhost/app?sslmode=require');
    expect(parsed?.connection).toMatchObject({ kind: 'postgres', host: 'localhost', port: 0, user: 'app', database: 'app', ssl: true });
    expect(parsed?.password).toBeNull();
  });
  it('reads Redis URLs with the database index and TLS from rediss', () => {
    expect(parseConnectionUrl('rediss://:secret@cache:6380/2')?.connection).toMatchObject({ kind: 'redis', host: 'cache', port: 6380, user: '', ssl: true, dbIndex: 2 });
    expect(parseConnectionUrl('rediss://:secret@cache:6380/2')?.password).toBe('secret');
    expect(parseConnectionUrl('redis://cache')?.connection).toMatchObject({ kind: 'redis', host: 'cache', port: 0, dbIndex: 0 });
  });
  it('reads SQLite paths', () => {
    expect(parseConnectionUrl('sqlite:data/app.db')?.connection).toEqual({ kind: 'sqlite', file: 'data/app.db', name: 'SQLite app.db' });
    expect(parseConnectionUrl('C:\\work\\app.sqlite')?.connection).toMatchObject({ kind: 'sqlite', file: 'C:\\work\\app.sqlite' });
  });
  it('returns null for other text', () => {
    expect(parseConnectionUrl('')).toBeNull();
    expect(parseConnectionUrl('https://example.com')).toBeNull();
    expect(parseConnectionUrl('SELECT 1')).toBeNull();
  });
});
