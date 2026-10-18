import { connect } from 'node:net';
import { formatRedisCliReply, splitRedisCliLine, type RedisCliValue } from '@quiver/core';

const REDIS_TYPE = 'redis-datasource';

type Reply = RedisCliValue | { error: string };

/** One command to the fake Redis over RESP, the reply decoded; an error reply comes back as `{ error }`. */
function redisCall(port: number, argv: string[]): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    let buf = Buffer.alloc(0);
    socket.on('connect', () => socket.write(`*${argv.length}\r\n${argv.map((a) => `$${Buffer.byteLength(a)}\r\n${a}\r\n`).join('')}`));
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      const parsed = decode(buf, 0);
      if (!parsed) return;
      socket.end();
      resolve(parsed.value);
    });
    socket.on('error', reject);
  });
}

function decode(buf: Buffer, at: number): { value: Reply; next: number } | null {
  const nl = buf.indexOf('\r\n', at);
  if (nl < 0) return null;
  const head = buf.subarray(at + 1, nl).toString();
  switch (String.fromCharCode(buf[at]!)) {
    case '+':
      return { value: head, next: nl + 2 };
    case '-':
      return { value: { error: head }, next: nl + 2 };
    case ':':
      return { value: Number(head), next: nl + 2 };
    case '$': {
      const len = Number(head);
      if (len < 0) return { value: null, next: nl + 2 };
      if (buf.length < nl + 2 + len + 2) return null;
      return { value: buf.subarray(nl + 2, nl + 2 + len).toString(), next: nl + 2 + len + 2 };
    }
    default: {
      const count = Number(head);
      if (count < 0) return { value: null, next: nl + 2 };
      const items: RedisCliValue[] = [];
      let next = nl + 2;
      for (let i = 0; i < count; i++) {
        const item = decode(buf, next);
        if (!item) return null;
        items.push(item.value as RedisCliValue);
        next = item.next;
      }
      return { value: items, next };
    }
  }
}

interface RedisQuery {
  refId: string;
  datasource: { uid: string };
  query?: string;
  cli?: boolean;
  command?: string;
  keyName?: string;
  section?: string;
  cursor?: string;
  match?: string;
  count?: number;
  min?: string;
  max?: string;
}

type Field = { name: string; type: string; values: unknown[] };
type Result = { frames?: unknown[]; error?: string };

const frame = (fields: Field[]) => ({ schema: { fields: fields.map(({ name, type }) => ({ name, type })) }, data: { values: fields.map((f) => f.values) } });
const isError = (v: unknown): v is { error: string } => typeof v === 'object' && v !== null && !Array.isArray(v) && 'error' in v;
/** createFrameValue: a number when the text parses as one, as the plugin does. */
const valueFrame = (value: unknown) => {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : typeof value === 'number' ? value : Number.NaN;
  return Number.isFinite(n) ? frame([{ name: 'Value', type: 'number', values: [n] }]) : frame([{ name: 'Value', type: 'string', values: [String(value ?? '')] }]);
};

/**
 * Grafana's Redis data source plugin in front of the fake Redis. `redis-smoke` answers the CLI as the plugin
 * does: the line split like a shell, the reply as redis-cli text in one `Value` field, a Redis error as the
 * query's error. `redis-down` cannot reach its Redis, so Grafana answers 500 "Query data error".
 * `redis-ro` has the CLI turned off and answers the plugin's fixed commands only.
 */
export function fakeRedisDatasources(redisPort: number, seen: { redis: string[] }) {
  const call = (argv: string[]) => redisCall(redisPort, argv);

  const fixedCommand = async (q: RedisQuery): Promise<Result> => {
    seen.redis.push(`command:${q.command}`);
    const key = q.keyName ?? '';
    switch (q.command) {
      case 'type':
      case 'ttl':
      case 'get':
      case 'llen':
      case 'hlen':
      case 'scard':
      case 'xlen': {
        const v = await call([q.command.toUpperCase(), key]);
        return isError(v) ? { error: v.error } : { frames: [valueFrame(v)] };
      }
      case 'hgetall': {
        const v = await call(['HGETALL', key]);
        if (!Array.isArray(v)) return { error: isError(v) ? v.error : 'bad reply' };
        const fields: Field[] = [];
        for (let i = 0; i + 1 < v.length; i += 2) fields.push({ name: String(v[i]), type: 'string', values: [String(v[i + 1])] });
        return { frames: [frame(fields)] };
      }
      case 'smembers': {
        const v = await call(['SMEMBERS', key]);
        return Array.isArray(v) ? { frames: [frame([{ name: 'Value', type: 'string', values: v.map(String) }])] } : { error: 'bad reply' };
      }
      case 'zrange': {
        const v = await call(['ZRANGE', key, q.min ?? '0', q.max ?? '-1', 'WITHSCORES']);
        if (!Array.isArray(v)) return { error: 'bad reply' };
        const fields: Field[] = [];
        for (let i = 0; i + 1 < v.length; i += 2) fields.push({ name: String(v[i]), type: 'number', values: [Number(v[i + 1])] });
        return { frames: [frame(fields)] };
      }
      case 'info': {
        const v = await call(['INFO', q.section ?? '']);
        if (isError(v)) return { error: v.error };
        const fields = String(v)
          .split(/\r?\n/)
          .map((l) => l.split(':'))
          .filter((p) => p.length >= 2)
          .map(([name, value]): Field => (value !== '' && Number.isFinite(Number(value)) ? { name: name!, type: 'number', values: [Number(value)] } : { name: name!, type: 'string', values: [value] }));
        return { frames: [frame(fields)] };
      }
      case 'tmscan': {
        // The plugin answers 500 for an empty cursor.
        if (!q.cursor) throw new Error('tmscan without a cursor');
        const v = await call(['SCAN', q.cursor, 'MATCH', q.match || '*', 'COUNT', String(q.count ?? 10)]);
        if (!Array.isArray(v)) return { error: 'bad reply' };
        const keys = ((v[1] as string[]) ?? []).map(String);
        const types = await Promise.all(keys.map(async (k) => String(await call(['TYPE', k]))));
        return {
          frames: [
            frame([
              { name: 'key', type: 'string', values: keys },
              { name: 'type', type: 'string', values: types },
              { name: 'memory', type: 'number', values: keys.map(() => 64) },
            ]),
            frame([
              { name: 'cursor', type: 'string', values: [String(v[0])] },
              { name: 'count', type: 'number', values: [keys.length] },
            ]),
          ],
        };
      }
      default:
        return { frames: [] };
    }
  };

  /** The plugin's query(): a non-empty `query` is a custom command, otherwise `command` picks a fixed one. */
  const runQuery = async (q: RedisQuery, cliDisabled: boolean): Promise<Result> => {
    if (!q.query) return fixedCommand(q);
    // The real plugin only hides the CLI in its editor; this fake refuses it, so a check notices Quiver sending one anyway.
    if (cliDisabled) {
      seen.redis.push('CLI sent to a data source with the CLI turned off');
      return { error: 'CLI sent to a data source with the CLI turned off' };
    }
    seen.redis.push(q.query);
    const argv = splitRedisCliLine(q.query);
    if (!argv) return { error: 'query is not valid' };
    const reply = await call(argv);
    if (isError(reply)) return { error: reply.error };
    return { frames: [frame([{ name: 'Value', type: 'string', values: [q.cli ? formatRedisCliReply(reply) : String(reply)] }])] };
  };

  return {
    /** The entries `/api/frontend/settings` lists, keyed by name as Grafana keys them. */
    datasources: {
      'Redis-Smoke': { uid: 'redis-smoke', type: REDIS_TYPE, name: 'Redis-Smoke', jsonData: { client: 'standalone' } },
      'Redis-Unreachable': { uid: 'redis-down', type: REDIS_TYPE, name: 'Redis-Unreachable', jsonData: {} },
      'Redis-ReadOnly': { uid: 'redis-ro', type: REDIS_TYPE, name: 'Redis-ReadOnly', jsonData: { cliDisabled: true } },
    },
    owns: (uid: string | undefined) => Boolean(uid?.startsWith('redis-')),
    /** `/api/ds/query` for these data sources: the queries in order, 400 when one failed, as Grafana answers. */
    async query(body: { queries: RedisQuery[] }): Promise<{ status: number; body: unknown }> {
      const uid = body.queries[0]?.datasource.uid;
      if (uid === 'redis-down') return { status: 500, body: { message: 'Query data error', traceID: '' } };
      const results: Record<string, Result & { status: number }> = {};
      let failed = false;
      for (const q of body.queries) {
        let r: Result;
        try {
          r = await runQuery(q, uid === 'redis-ro');
        } catch {
          return { status: 500, body: { message: 'Query data error', traceID: '' } };
        }
        if (r.error) failed = true;
        results[q.refId] = r.error ? { error: r.error, status: 500, frames: [] } : { frames: r.frames, status: 200 };
      }
      return { status: failed ? 400 : 200, body: { results } };
    },
  };
}
