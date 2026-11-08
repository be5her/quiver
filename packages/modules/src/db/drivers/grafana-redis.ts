import {
  GRAFANA_REDIS_TYPE,
  QuiverError,
  cleanGrafanaError,
  grafanaFrameColumns,
  grafanaRedisRefusal,
  normalizeGrafanaUrl,
  parseRedisCliReply,
  parseRedisCommands,
  redisCliLine,
  redisCliTextFromFrames,
  redisInfoFromText,
  type DbConnection,
  type DbQueryResult,
  type DbTable,
  type DbTableColumns,
  type DbTableDetail,
  type DbTableRows,
  type GrafanaFrame,
  type GrafanaRedisDatasource,
  type HostApi,
  type RedisCliValue,
  type RedisInfo,
  type RedisKeyDetail,
  type RedisKeyInfo,
  type RedisScanResult,
} from '@quiver/core';
import { grafanaSessions } from '../../grafana/sessions';
import type { RedisDriverApi, RunOptions, TableRowsOptions } from './types';

type GrafanaAccess = Extract<DbConnection['access'], { type: 'grafana' }>;

interface DsResult {
  error?: string;
  status?: number;
  frames?: GrafanaFrame[];
}

interface DsBody {
  results?: Record<string, DsResult>;
  message?: string;
}

/** Queries per `/api/ds/query` request when a view asks for many small things at once (TYPE and TTL of a page of keys). */
const BATCH = 100;

function hostOf(base: string): string {
  try {
    return new URL(base).host;
  } catch {
    return base;
  }
}

/** The Redis data sources a Grafana lists to the signed-in user. `/api/frontend/settings` answers viewers too, unlike `/api/datasources`. */
export async function grafanaRedisDatasources(host: HostApi, grafanaUrl: string): Promise<GrafanaRedisDatasource[]> {
  const { status, body } = await grafanaSessions.request<{ datasources?: Record<string, { uid: string; name: string; type: string; jsonData?: { cliDisabled?: boolean } }> }>(
    host,
    grafanaUrl,
    '/api/frontend/settings',
    { timeoutMs: 20_000 },
  );
  if (status !== 200 || typeof body !== 'object' || !body) throw new QuiverError('REQUEST_FAILED', `Grafana answered ${status} for its data sources`);
  return Object.values(body.datasources ?? {})
    .filter((d) => d.type === GRAFANA_REDIS_TYPE)
    .map((d) => ({ uid: d.uid, name: d.name, cliDisabled: Boolean(d.jsonData?.cliDisabled) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** One command's outcome in a batch: its reply, or the error the plugin gave. */
type Outcome = { value: RedisCliValue } | { error: string };

/**
 * Redis through a Grafana Redis data source: every command is one CLI query on `/api/ds/query`, sent with
 * the Grafana session of this machine, so it runs with the signed-in user's permissions. Nothing is
 * dialled, nothing to cancel, and "alive" means the session is. When the data source has its CLI turned
 * off, the key browser still reads through the plugin's fixed commands and everything else is refused.
 */
export class GrafanaRedisDriver implements RedisDriverApi {
  readonly kind = 'redis' as const;
  private source: GrafanaRedisDatasource | null = null;
  private alive = false;

  constructor(
    private readonly config: DbConnection,
    private readonly host: HostApi,
  ) {}

  private get access(): GrafanaAccess {
    if (this.config.access.type !== 'grafana') throw new QuiverError('INVALID_INPUT', 'Not a Grafana connection');
    return this.config.access;
  }

  private get base(): string {
    return normalizeGrafanaUrl(this.access.grafanaUrl);
  }

  private get label(): string {
    return this.source?.name || this.access.datasourceName || this.access.datasourceUid;
  }

  async connect(): Promise<void> {
    const access = this.access;
    if (!this.base) throw new QuiverError('INVALID_INPUT', access.grafanaUrl.trim() ? `"${access.grafanaUrl}" is not an http(s) address` : `"${this.config.name}" has no Grafana address yet`);
    if (!access.datasourceUid) throw new QuiverError('INVALID_INPUT', `"${this.config.name}" has no Grafana data source yet; pick one (db.grafana.redis.datasources lists them)`);
    if (this.config.dbIndex !== 0) {
      throw new QuiverError('INVALID_INPUT', 'Through Grafana the data source address picks the Redis database: set the database index to 0 (Quiver cannot SELECT on the connections Grafana shares with dashboards).');
    }
    this.source = await this.findSource();
    await this.ping();
    this.alive = true;
  }

  /** The data source by uid; when only its name is left, say what the new uid is instead of failing obscurely. */
  private async findSource(): Promise<GrafanaRedisDatasource> {
    const { datasourceUid: uid, datasourceName: name } = this.access;
    const all = await grafanaRedisDatasources(this.host, this.base);
    const byUid = all.find((d) => d.uid === uid);
    if (byUid) return byUid;
    const byName = name ? all.find((d) => d.name === name) : undefined;
    if (byName) {
      throw new QuiverError(
        'NOT_FOUND',
        `Grafana at ${hostOf(this.base)} no longer has a Redis data source with uid ${uid}, but "${name}" is there with uid ${byName.uid} (an admin probably provisioned it anew). Update the connection to use it: its access.datasourceUid becomes "${byName.uid}".`,
        { connectionId: this.config.id, datasourceMoved: { uid: byName.uid, name: byName.name } },
      );
    }
    throw new QuiverError(
      'NOT_FOUND',
      `Grafana at ${hostOf(this.base)} has no Redis data source with uid ${uid}${name ? ` or name "${name}"` : ''} that your Grafana user can see. Pick one again (db.grafana.redis.datasources lists them).`,
      { connectionId: this.config.id },
    );
  }

  async close(): Promise<void> {
    this.alive = false;
  }

  isAlive(): boolean {
    return this.alive && grafanaSessions.session(this.base).state !== 'signed-out';
  }

  private get readOnly(): boolean {
    return Boolean(this.source?.cliDisabled);
  }

  private requireCli(): void {
    if (this.readOnly) {
      throw new QuiverError(
        'INVALID_INPUT',
        `The CLI is turned off on Grafana data source ${this.label}, so Quiver can only read through it: the key browser and server info work, commands and edits do not. A Grafana admin can turn the CLI back on in the data source settings.`,
      );
    }
  }

  /** Several queries in one `/api/ds/query` request; the plugin runs them in order. */
  private async dsQuery(queries: Record<string, unknown>[]): Promise<DsResult[]> {
    const now = Date.now();
    const { status, body } = await grafanaSessions.request<DsBody>(this.host, this.base, '/api/ds/query', {
      method: 'POST',
      body: {
        from: String(now - 5 * 60_000),
        to: String(now),
        queries: queries.map((q, i) => ({ refId: `Q${i}`, datasource: { uid: this.access.datasourceUid, type: GRAFANA_REDIS_TYPE }, ...q })),
      },
      timeoutMs: 30_000,
    });
    const results = typeof body === 'object' && body ? body.results : undefined;
    if (!results) {
      const message = typeof body === 'object' && body?.message ? body.message : String(body).slice(0, 300);
      if (status >= 500 && /query data error/i.test(message)) {
        throw new QuiverError('REQUEST_FAILED', `Grafana could not reach Redis through data source ${this.label}; ask the Grafana admin to run Save & test on it.`, { grafanaStatus: status, grafanaMessage: message });
      }
      throw new QuiverError('REQUEST_FAILED', `Grafana answered ${status} for data source ${this.label}: ${message || 'no message'}`, { grafanaStatus: status });
    }
    return queries.map((_, i) => results[`Q${i}`] ?? { error: 'Grafana returned no result for this query' });
  }

  private async cliBatch(commands: string[][]): Promise<Outcome[]> {
    const lines = commands.map((argv) => {
      const refusal = grafanaRedisRefusal(argv);
      if (refusal) throw new QuiverError('INVALID_INPUT', refusal);
      return redisCliLine(argv);
    });
    const out: Outcome[] = [];
    for (let at = 0; at < lines.length; at += BATCH) {
      const results = await this.dsQuery(lines.slice(at, at + BATCH).map((query) => ({ type: 'cli', query, cli: true })));
      for (const r of results) out.push(r.error ? { error: cleanGrafanaError(r.error) } : { value: parseRedisCliReply(redisCliTextFromFrames(r.frames)) });
    }
    return out;
  }

  /** One command; the plugin's own error comes back as the message. */
  private async cli(argv: string[]): Promise<RedisCliValue> {
    const [outcome] = await this.cliBatch([argv]);
    if (!outcome || 'error' in outcome) throw new QuiverError('REQUEST_FAILED', outcome?.error ?? 'No reply', { command: argv[0] });
    return outcome.value;
  }

  /** The plugin's fixed commands (`command: 'get'`, `'tmscan'`, …), the only queries left when its CLI is off. */
  private async fixed(queries: Record<string, unknown>[]): Promise<(GrafanaFrame[] | { error: string })[]> {
    const out: (GrafanaFrame[] | { error: string })[] = [];
    for (let at = 0; at < queries.length; at += BATCH) {
      const results = await this.dsQuery(queries.slice(at, at + BATCH).map((q) => ({ type: 'command', ...q })));
      for (const r of results) out.push(r.error ? { error: cleanGrafanaError(r.error) } : (r.frames ?? []));
    }
    return out;
  }

  private async fixedOne(query: Record<string, unknown>): Promise<GrafanaFrame[]> {
    const [frames] = await this.fixed([query]);
    if (!frames || 'error' in frames) throw new QuiverError('REQUEST_FAILED', frames?.error ?? 'No reply', { command: query['command'] });
    return frames;
  }

  async ping(): Promise<{ serverVersion: string }> {
    let version: string | null;
    if (this.readOnly) {
      version = String(grafanaFrameColumns((await this.fixedOne({ command: 'info', section: 'server' }))[0]).get('redis_version')?.[0] ?? '') || null;
    } else {
      const [pong, info] = await this.cliBatch([['PING'], ['INFO', 'server']]);
      if (!pong || 'error' in pong) throw new QuiverError('REQUEST_FAILED', pong?.error ?? 'No reply to PING');
      version = info && 'value' in info && typeof info.value === 'string' ? (/redis_version:([^\r\n]+)/.exec(info.value)?.[1] ?? null) : null;
    }
    return { serverVersion: `Redis ${version ?? 'unknown'} via Grafana (${this.label})${this.readOnly ? ', read-only: CLI turned off' : ''}` };
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

  async columns(): Promise<DbTableColumns[]> {
    return [];
  }

  async tableRows(_name: string, _options: TableRowsOptions): Promise<DbTableRows> {
    throw new QuiverError('INVALID_INPUT', 'Redis has no tables. Use db.redis.keys and db.redis.key.');
  }

  async run(query: string, _options: RunOptions): Promise<DbQueryResult[]> {
    const commands = parseRedisCommands(query);
    if (!commands.length) throw new QuiverError('INVALID_INPUT', 'Enter a Redis command, e.g. GET mykey');
    return this.exec(commands);
  }

  /** One request per command, in order, stopping at the first error, as on a direct connection. */
  async exec(commands: string[][]): Promise<DbQueryResult[]> {
    this.requireCli();
    // Refuse before anything runs, so a script is not left half done by a command Grafana cannot carry.
    for (const argv of commands) {
      const refusal = grafanaRedisRefusal(argv);
      if (refusal) throw new QuiverError('INVALID_INPUT', refusal);
      redisCliLine(argv);
    }
    const results: DbQueryResult[] = [];
    for (const argv of commands) {
      const started = performance.now();
      const value = await this.cli(argv);
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
    let next: string;
    let keys: string[];
    const infos: RedisKeyInfo[] = [];
    if (this.readOnly) {
      // TMSCAN needs a cursor: an empty one makes the plugin answer 500.
      const frames = await this.fixedOne({ command: 'tmscan', cursor: cursor || '0', match: pattern || '*', count });
      const rows = grafanaFrameColumns(frames[0]);
      next = String(grafanaFrameColumns(frames[1]).get('cursor')?.[0] ?? '0');
      keys = (rows.get('key') ?? []).map(String);
      const types = (rows.get('type') ?? []).map(String);
      const ttls = await this.fixed(keys.map((keyName) => ({ command: 'ttl', keyName })));
      keys.forEach((key, i) => {
        const ttl = ttls[i];
        const value = ttl && !('error' in ttl) ? grafanaFrameColumns(ttl[0]).get('Value')?.[0] : undefined;
        infos.push({ key, type: types[i] || 'unknown', ttl: value === undefined ? -1 : Number(value) });
      });
    } else {
      const reply = await this.cli(['SCAN', cursor || '0', 'MATCH', pattern || '*', 'COUNT', String(count)]);
      if (!Array.isArray(reply) || typeof reply[0] !== 'string' || !Array.isArray(reply[1])) throw new QuiverError('REQUEST_FAILED', 'SCAN through Grafana gave an unexpected reply');
      next = reply[0];
      keys = reply[1].map(String);
      const meta = await this.cliBatch(keys.flatMap((key) => [['TYPE', key], ['TTL', key]]));
      keys.forEach((key, i) => {
        const type = meta[i * 2];
        const ttl = meta[i * 2 + 1];
        infos.push({ key, type: type && 'value' in type ? String(type.value) : 'unknown', ttl: ttl && 'value' in ttl ? Number(ttl.value) : -1 });
      });
    }
    infos.sort((a, b) => a.key.localeCompare(b.key));
    return { cursor: next, done: next === '0', keys: infos };
  }

  async keyDetail(key: string, limit: number): Promise<RedisKeyDetail> {
    return this.readOnly ? this.keyDetailReadOnly(key, limit) : this.keyDetailCli(key, limit);
  }

  private async keyDetailCli(key: string, limit: number): Promise<RedisKeyDetail> {
    const [typeOut, ttlOut, encodingOut, memoryOut] = await this.cliBatch([['TYPE', key], ['TTL', key], ['OBJECT', 'ENCODING', key], ['MEMORY', 'USAGE', key]]);
    const ok = (o: Outcome | undefined) => (o && 'value' in o ? o.value : undefined);
    if (typeOut && 'error' in typeOut) throw new QuiverError('REQUEST_FAILED', typeOut.error);
    const type = String(ok(typeOut));
    if (type === 'none') throw new QuiverError('NOT_FOUND', `Key ${key} does not exist`);
    const ttl = Number(ok(ttlOut) ?? -1);
    const encoding = typeof ok(encodingOut) === 'string' ? String(ok(encodingOut)) : null;
    const memory = typeof ok(memoryOut) === 'number' ? Number(ok(memoryOut)) : null;

    /** Both replies of a pair of reads, or the first error. */
    const two = async (a: string[], b: string[]): Promise<[RedisCliValue, RedisCliValue]> => {
      const [x, y] = await this.cliBatch([a, b]);
      for (const o of [x, y]) if (!o || 'error' in o) throw new QuiverError('REQUEST_FAILED', o?.error ?? 'No reply');
      return [(x as { value: RedisCliValue }).value, (y as { value: RedisCliValue }).value];
    };
    const flat = (v: RedisCliValue): string[] => (Array.isArray(v) ? v.map((x) => String(x)) : []);
    const record = (items: string[], max: number) => {
      const obj: Record<string, string> = {};
      for (let i = 0; i + 1 < items.length && Object.keys(obj).length < max; i += 2) obj[items[i]!] = items[i + 1]!;
      return obj;
    };

    let value: unknown = null;
    let length: number | null = null;
    let truncated = false;
    switch (type) {
      case 'string': {
        const [text, len] = await two(['GET', key], ['STRLEN', key]);
        value = text;
        length = Number(len);
        break;
      }
      case 'hash': {
        length = Number(await this.cli(['HLEN', key]));
        if (length <= limit) {
          value = record(flat(await this.cli(['HGETALL', key])), Number.POSITIVE_INFINITY);
        } else {
          const reply = await this.cli(['HSCAN', key, '0', 'COUNT', String(limit)]);
          value = record(flat(Array.isArray(reply) ? (reply[1] ?? []) : []), limit);
          truncated = true;
        }
        break;
      }
      case 'list': {
        const [len, items] = await two(['LLEN', key], ['LRANGE', key, '0', String(limit - 1)]);
        length = Number(len);
        value = flat(items);
        truncated = length > limit;
        break;
      }
      case 'set': {
        length = Number(await this.cli(['SCARD', key]));
        if (length <= limit) {
          value = flat(await this.cli(['SMEMBERS', key])).sort();
        } else {
          const reply = await this.cli(['SSCAN', key, '0', 'COUNT', String(limit)]);
          value = flat(Array.isArray(reply) ? (reply[1] ?? []) : []).slice(0, limit);
          truncated = true;
        }
        break;
      }
      case 'zset': {
        const [len, items] = await two(['ZCARD', key], ['ZRANGE', key, '0', String(limit - 1), 'WITHSCORES']);
        length = Number(len);
        const f = flat(items);
        const pairs: [string, number][] = [];
        for (let i = 0; i + 1 < f.length; i += 2) pairs.push([f[i]!, Number(f[i + 1])]);
        value = pairs;
        truncated = length > limit;
        break;
      }
      case 'stream': {
        const [len, entries] = await two(['XLEN', key], ['XREVRANGE', key, '+', '-', 'COUNT', String(limit)]);
        length = Number(len);
        value = (Array.isArray(entries) ? entries : []).map((entry) => {
          const [id, fields] = Array.isArray(entry) ? entry : [entry, []];
          return { id: String(id), fields: record(flat(fields ?? []), Number.POSITIVE_INFINITY) };
        });
        truncated = length > limit;
        break;
      }
      default:
        value = null;
    }
    return { key, type, ttl, length, encoding, memory, value, truncated };
  }

  /**
   * The key through the plugin's fixed commands. Values come back as Grafana fields, which turn numbers
   * into floats ("007" reads 7); lists and streams show their length only.
   */
  private async keyDetailReadOnly(key: string, limit: number): Promise<RedisKeyDetail> {
    const single = (frames: GrafanaFrame[]) => grafanaFrameColumns(frames[0]).get('Value')?.[0];
    const [typeFrames, ttlFrames] = await this.fixed([
      { command: 'type', keyName: key },
      { command: 'ttl', keyName: key },
    ]);
    if (!typeFrames || 'error' in typeFrames) throw new QuiverError('REQUEST_FAILED', typeFrames?.error ?? 'No reply');
    const type = String(single(typeFrames) ?? 'none');
    if (type === 'none') throw new QuiverError('NOT_FOUND', `Key ${key} does not exist`);
    const ttl = ttlFrames && !('error' in ttlFrames) ? Number(single(ttlFrames) ?? -1) : -1;
    /** Every field of the first frame as name and first value: how the plugin returns HGETALL and ZRANGE. */
    const byField = (frames: GrafanaFrame[]) => [...grafanaFrameColumns(frames[0])].map(([name, values]) => [name, values[0]] as const);
    let value: unknown = null;
    let length: number | null = null;
    let truncated = false;
    switch (type) {
      case 'string': {
        const text = single(await this.fixedOne({ command: 'get', keyName: key }));
        value = text === undefined || text === null ? null : String(text);
        length = typeof value === 'string' ? Buffer.byteLength(value) : null;
        break;
      }
      case 'hash': {
        const fields = byField(await this.fixedOne({ command: 'hgetall', keyName: key }));
        length = fields.length;
        value = Object.fromEntries(fields.slice(0, limit).map(([k, v]) => [k, String(v)]));
        truncated = fields.length > limit;
        break;
      }
      case 'set': {
        const members = (grafanaFrameColumns((await this.fixedOne({ command: 'smembers', keyName: key }))[0]).get('Value') ?? []).map(String).sort();
        length = members.length;
        value = members.slice(0, limit);
        truncated = members.length > limit;
        break;
      }
      case 'zset': {
        const pairs = byField(await this.fixedOne({ command: 'zrange', keyName: key, min: '0', max: String(limit - 1) })).map(([m, s]) => [m, Number(s)] as [string, number]);
        // The plugin has no ZCARD: a full page means there may be more.
        value = pairs;
        length = null;
        truncated = pairs.length >= limit;
        break;
      }
      case 'list':
        length = Number(single(await this.fixedOne({ command: 'llen', keyName: key })) ?? 0);
        truncated = length > 0;
        break;
      case 'stream':
        length = Number(single(await this.fixedOne({ command: 'xlen', keyName: key })) ?? 0);
        truncated = length > 0;
        break;
      default:
        value = null;
    }
    return { key, type, ttl, length, encoding: null, memory: null, value, truncated };
  }

  async info(): Promise<RedisInfo> {
    if (this.readOnly) {
      const sections = ['server', 'clients', 'memory', 'stats', 'replication', 'keyspace'];
      const frames = await this.fixed(sections.map((section) => ({ command: 'info', section })));
      const lines: string[] = [];
      let keys: number | null = null;
      frames.forEach((f, i) => {
        if ('error' in f) return;
        for (const [name, values] of grafanaFrameColumns(f[0])) {
          if (sections[i] === 'keyspace') {
            const n = /keys=(\d+)/.exec(String(values[0]))?.[1];
            if (n) keys = (keys ?? 0) + Number(n);
          } else {
            lines.push(`${name}:${String(values[0])}`);
          }
        }
      });
      return redisInfoFromText(lines.join('\n'), keys);
    }
    const [info, size] = await this.cliBatch([['INFO'], ['DBSIZE']]);
    if (!info || 'error' in info) throw new QuiverError('REQUEST_FAILED', info?.error ?? 'No reply to INFO');
    return redisInfoFromText(String(info.value), size && 'value' in size ? Number(size.value) : null);
  }
}
