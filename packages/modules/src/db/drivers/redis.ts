import { QuiverError, parseRedisCommands, type DbConnection, type DbQueryResult, type DbTable, type DbTableDetail, type DbTableRows, type RedisKeyDetail, type RedisKeyInfo, type RedisScanResult } from '@quiver/core';
import { Redis } from 'ioredis';
import { normalizeValue, type RedisDriverApi, type RunOptions, type TableRowsOptions } from './types';

export class RedisDriver implements RedisDriverApi {
  readonly kind = 'redis' as const;
  private client: Redis | null = null;

  constructor(
    private readonly config: DbConnection,
    private readonly password: string,
  ) {}

  async connect(): Promise<void> {
    const client = new Redis({
      host: this.config.host,
      port: this.config.port || 6379,
      username: this.config.user || undefined,
      password: this.password || undefined,
      db: this.config.dbIndex,
      tls: this.config.ssl ? { rejectUnauthorized: false } : undefined,
      lazyConnect: true,
      connectTimeout: 10_000,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
      enableOfflineQueue: false,
    });
    // ioredis reports handshake failures (bad password, ACL) on 'error' and then rejects connect()
    // with a generic "Connection is closed", so keep the specific one to show the user.
    let lastError: unknown = null;
    client.on('error', (err) => {
      lastError = err;
    });
    try {
      await client.connect();
    } catch (err) {
      client.disconnect();
      throw wrapError(lastError && /closed/i.test((err as Error).message ?? '') ? lastError : err);
    }
    this.client = client;
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (client) await client.quit().catch(() => client.disconnect());
  }

  isAlive(): boolean {
    return this.client !== null && this.client.status === 'ready';
  }

  private c(): Redis {
    if (!this.client || this.client.status !== 'ready') throw new QuiverError('REQUEST_FAILED', 'Redis connection is closed');
    return this.client;
  }

  private async call(argv: string[]): Promise<unknown> {
    const [cmd, ...args] = argv;
    try {
      return await this.c().call(cmd, ...args);
    } catch (err) {
      throw wrapError(err);
    }
  }

  async ping(): Promise<{ serverVersion: string }> {
    const info = String(await this.call(['INFO', 'server']));
    const version = /redis_version:([^\r\n]+)/.exec(info)?.[1] ?? 'unknown';
    return { serverVersion: `Redis ${version}` };
  }

  async databases(): Promise<string[]> {
    return [];
  }

  async tables(): Promise<DbTable[]> {
    return [];
  }

  async table(): Promise<DbTableDetail> {
    throw new QuiverError('INVALID_INPUT', 'Redis has no tables. Use the key browser or db.redis.keys.');
  }

  async tableRows(_name: string, _options: TableRowsOptions): Promise<DbTableRows> {
    throw new QuiverError('INVALID_INPUT', 'Redis has no tables. Use db.redis.keys and db.redis.key.');
  }

  /** Each line is one command, shell-style quoting. Replies come back as-is under `value`. */
  async run(query: string, _options: RunOptions): Promise<DbQueryResult[]> {
    const commands = parseRedisCommands(query);
    if (!commands.length) throw new QuiverError('INVALID_INPUT', 'Enter a Redis command, e.g. GET mykey');
    const results: DbQueryResult[] = [];
    for (const argv of commands) {
      const started = performance.now();
      const value = normalizeValue(await this.call(argv));
      results.push({
        statement: argv.join(' '),
        kind: 'value',
        columns: [],
        rows: [],
        rowCount: Array.isArray(value) ? value.length : 0,
        truncated: false,
        affectedRows: null,
        insertId: null,
        value,
        durationMs: performance.now() - started,
        message: null,
      });
    }
    return results;
  }

  async scanKeys(pattern: string, cursor: string, count: number): Promise<RedisScanResult> {
    const client = this.c();
    let next: string;
    let keys: string[];
    try {
      [next, keys] = await client.scan(cursor, 'MATCH', pattern || '*', 'COUNT', count);
    } catch (err) {
      throw wrapError(err);
    }
    const infos: RedisKeyInfo[] = [];
    if (keys.length) {
      const pipeline = client.pipeline();
      for (const key of keys) {
        pipeline.type(key);
        pipeline.ttl(key);
      }
      const replies = (await pipeline.exec()) ?? [];
      keys.forEach((key, i) => {
        infos.push({ key, type: String(replies[i * 2]?.[1] ?? 'unknown'), ttl: Number(replies[i * 2 + 1]?.[1] ?? -1) });
      });
    }
    infos.sort((a, b) => a.key.localeCompare(b.key));
    return { cursor: next, done: next === '0', keys: infos };
  }

  async keyDetail(key: string, limit: number): Promise<RedisKeyDetail> {
    const client = this.c();
    const type = String(await this.call(['TYPE', key]));
    if (type === 'none') throw new QuiverError('NOT_FOUND', `Key ${key} does not exist`);
    const ttl = Number(await this.call(['TTL', key]));
    let encoding: string | null = null;
    let memory: number | null = null;
    try {
      encoding = String(await client.call('OBJECT', 'ENCODING', key));
    } catch {
      encoding = null;
    }
    try {
      const m = await client.call('MEMORY', 'USAGE', key);
      memory = m === null ? null : Number(m);
    } catch {
      memory = null;
    }

    let value: unknown = null;
    let length: number | null = null;
    let truncated = false;
    try {
      switch (type) {
        case 'string': {
          value = await client.get(key);
          length = Number(await client.strlen(key));
          break;
        }
        case 'hash': {
          length = Number(await client.hlen(key));
          if (length <= limit) {
            value = await client.hgetall(key);
          } else {
            const [, flat] = await client.hscan(key, '0', 'COUNT', limit);
            const obj: Record<string, string> = {};
            for (let i = 0; i + 1 < flat.length && Object.keys(obj).length < limit; i += 2) obj[flat[i]] = flat[i + 1];
            value = obj;
            truncated = true;
          }
          break;
        }
        case 'list': {
          length = Number(await client.llen(key));
          value = await client.lrange(key, 0, limit - 1);
          truncated = length > limit;
          break;
        }
        case 'set': {
          length = Number(await client.scard(key));
          if (length <= limit) {
            value = (await client.smembers(key)).sort();
          } else {
            const [, members] = await client.sscan(key, '0', 'COUNT', limit);
            value = members.slice(0, limit);
            truncated = true;
          }
          break;
        }
        case 'zset': {
          length = Number(await client.zcard(key));
          const flat = await client.zrange(key, '0', String(limit - 1), 'WITHSCORES');
          const pairs: [string, number][] = [];
          for (let i = 0; i + 1 < flat.length; i += 2) pairs.push([flat[i], Number(flat[i + 1])]);
          value = pairs;
          truncated = length > limit;
          break;
        }
        case 'stream': {
          length = Number(await client.xlen(key));
          const entries = await client.xrevrange(key, '+', '-', 'COUNT', String(limit));
          value = entries.map(([id, fields]) => {
            const obj: Record<string, string> = {};
            for (let i = 0; i + 1 < fields.length; i += 2) obj[fields[i]] = fields[i + 1];
            return { id, fields: obj };
          });
          truncated = length > limit;
          break;
        }
        default: {
          // Module types (ReJSON, TimeSeries, ...) fall back to DUMP length only.
          value = null;
        }
      }
    } catch (err) {
      throw wrapError(err);
    }
    return { key, type, ttl, length, encoding, memory, value: normalizeValue(value), truncated };
  }
}

function wrapError(err: unknown): QuiverError {
  if (err instanceof QuiverError) return err;
  const e = err as { message?: string; code?: string; command?: { name?: string } };
  let message = e.message ?? String(err);
  if (/ECONNREFUSED/.test(message)) message = `Connection refused (${message.replace(/^.*ECONNREFUSED\s*/, '').trim() || 'is Redis running?'})`;
  return new QuiverError('REQUEST_FAILED', message, { code: e.code, command: e.command?.name });
}
