/** One log entry of the smoke's fake log store. */
export interface FakeLogEntry {
  at: number;
  /** Nanoseconds past `at`, stable per entry the way VictoriaLogs keeps them, so an entry has one id across queries. */
  nanos: number;
  msg: string;
  fields: Record<string, string>;
}

/**
 * The entries the fake Grafana and the fake VictoriaLogs both serve, and the bit of LogsQL they understand:
 * exact-match filters (`app:="api"`, `!level:="Debug"`) and free-text words in the filter part, field
 * names, value counts and hits buckets. One store, so a query through Grafana and the same query sent
 * directly see the same entries.
 */
export interface FakeLogs {
  readonly entries: FakeLogEntry[];
  /** Add an entry while running, such as one stamped ahead of this machine's clock by a server whose clock runs ahead. */
  add(entry: Omit<FakeLogEntry, 'nanos'>): void;
  /** The entries in the range that match the filter part of the query, oldest first, as a raw query can come back. */
  select(expr: string, fromMs: number, toMs: number): FakeLogEntry[];
  /** Every field name of the entries with how many have it, the internal ones (`_msg`, `_time`, `_stream_id`) included. */
  fieldNames(hit: FakeLogEntry[]): [string, number][];
  /** The values of a field with their counts; an entry without the field counts as ''. */
  fieldValues(hit: FakeLogEntry[], field: string): [string, number][];
  /** Entries per bucket of `stepMs`, buckets in time order. */
  buckets(hit: FakeLogEntry[], stepMs: number): [number, number][];
}

const EXACT = /(!?)("(?:[^"\\]|\\.)*"|[\w.]+):="((?:[^"\\]|\\.)*)"/g;

export function createFakeLogs(start: number = Date.now()): FakeLogs {
  const entries: FakeLogEntry[] = [];
  const add = (entry: Omit<FakeLogEntry, 'nanos'>) => {
    entries.push({ ...entry, nanos: entries.length * 7 });
  };
  add({ at: start - 60_000, msg: 'GET /health 200', fields: { _stream_id: 's-api', app: 'api', level: 'Information' } });
  add({ at: start - 50_000, msg: 'payment failed: card declined', fields: { _stream_id: 's-api', app: 'api', level: 'Error', 'error.code': 'E42' } });
  add({ at: start - 40_000, msg: '{"event":"order.created","id":7,"items":[1,2]}', fields: { _stream_id: 's-worker', app: 'worker', level: 'Information' } });
  add({ at: start - 30_000, msg: 'retrying publish', fields: { _stream_id: 's-worker', app: 'worker', level: 'Warning' } });
  add({ at: start - 20_000, msg: 'cache miss', fields: { _stream_id: 's-api', app: 'api', level: 'Debug' } });

  const matches = (expr: string) => {
    const filterPart = expr.split('|')[0] ?? '';
    const exact = [...filterPart.matchAll(EXACT)].map((m) => ({
      exclude: m[1] === '!',
      field: m[2]!.startsWith('"') ? (JSON.parse(m[2]!) as string) : m[2]!,
      value: JSON.parse(`"${m[3]}"`) as string,
    }));
    const words = filterPart
      .replace(EXACT, ' ')
      .replace(/[()*]/g, ' ')
      .split(/\s+/)
      .filter(Boolean);
    return (e: FakeLogEntry) => exact.every((f) => ((e.fields[f.field] ?? '') === f.value) !== f.exclude) && words.every((w) => e.msg.toLowerCase().includes(w.toLowerCase()));
  };

  const count = <K>(keys: K[]): [K, number][] => {
    const counts = new Map<K, number>();
    for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1);
    return [...counts];
  };

  return {
    entries,
    add,
    select: (expr, fromMs, toMs) => entries.filter((e) => e.at >= fromMs && e.at <= toMs).filter(matches(expr)),
    fieldNames: (hit) => count(hit.flatMap((e) => ['_msg', '_time', '_stream_id', ...Object.keys(e.fields)])),
    fieldValues: (hit, field) => count(hit.map((e) => e.fields[field] ?? '')),
    buckets: (hit, stepMs) => count(hit.map((e) => Math.floor(e.at / stepMs) * stepMs)).sort((a, b) => a[0] - b[0]),
  };
}
