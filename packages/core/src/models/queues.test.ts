import { describe, expect, it } from 'vitest';
import { QueueConnectionSchema, urlHasCredentials } from './queues';

describe('queue connections', () => {
  it('refuse a committed URL that carries a user or password', () => {
    // The connection file is committed; a pasted `http://guest:guest@host` would put the password in git history.
    for (const bad of ['http://admin:s3cret@rabbit.internal:15672', 'amqps://user@host', 'http://user:pw@localhost:4566/', 'custom-scheme://u:p@h']) {
      expect(urlHasCredentials(bad), bad).toBe(true);
      expect(QueueConnectionSchema.safeParse({ id: 'c', kind: 'rabbit', managementUrl: bad }).success, bad).toBe(false);
      expect(QueueConnectionSchema.safeParse({ id: 'c', kind: 'sqs', endpoint: bad }).success, bad).toBe(false);
    }
  });

  it('accept plain URLs, an empty field, and text that is not a URL', () => {
    for (const ok of ['', 'http://localhost:15672', 'https://rabbit.internal:15672/api', 'http://localhost:4566', 'localhost:4566', 'not a url']) {
      expect(urlHasCredentials(ok), ok).toBe(false);
      expect(QueueConnectionSchema.safeParse({ id: 'c', managementUrl: ok, endpoint: ok }).success, ok).toBe(true);
    }
    expect(QueueConnectionSchema.parse({ id: 'c' })).toMatchObject({ kind: 'memory', endpoint: '', managementUrl: '', vhost: '/' });
  });
});
