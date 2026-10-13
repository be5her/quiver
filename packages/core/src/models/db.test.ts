import { describe, expect, it } from 'vitest';
import { DbConnectionSchema, newDbConnection, resolveConnectionTemplate } from './db';

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
