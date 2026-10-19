import { z } from 'zod';
import { QuiverError } from '../errors';
import { newId, nowIso } from '../ids';

/** Grafana data source types that are VictoriaLogs. */
export const VICTORIA_LOGS_TYPES: readonly string[] = ['victoriametrics-logs-datasource'];

/** A VictoriaLogs data source reached through Grafana, saved with the project. Signing in is per machine. */
export const LogsConnectionSchema = z.object({
  id: z.string(),
  name: z.string().default('Logs'),
  /** Grafana's address, e.g. `https://grafana.example.com`; a sub-path is kept. */
  grafanaUrl: z.string().default(''),
  /** The data source queried through that Grafana. */
  datasourceUid: z.string().default(''),
  datasourceName: z.string().default(''),
  datasourceType: z.string().default(VICTORIA_LOGS_TYPES[0]!),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type LogsConnection = z.infer<typeof LogsConnectionSchema>;

/** Every field optional and without defaults, so a partial update only touches what it names. */
export const LogsConnectionDraftSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  grafanaUrl: z.string().optional(),
  datasourceUid: z.string().optional(),
  datasourceName: z.string().optional(),
  datasourceType: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});
export type LogsConnectionDraft = z.infer<typeof LogsConnectionDraftSchema>;

/** Keep only the entries whose field has this value, or drop them with `exclude`. */
export const LogsFilterSchema = z.object({
  field: z.string().min(1),
  value: z.string(),
  exclude: z.boolean().default(false),
});
export type LogsFilter = z.infer<typeof LogsFilterSchema>;

/** Whether this machine holds a Grafana session for the connection's address. */
export type LogsSignInState = 'unknown' | 'signed-out' | 'signing-in' | 'signed-in';

export interface LogsUser {
  login: string;
  email: string;
  name: string;
}

export interface LogsSession {
  state: LogsSignInState;
  user: LogsUser | null;
  error: string | null;
  checkedAt: string | null;
}

export interface LogsConnectionSummary extends LogsConnection {
  session: LogsSession;
}

export interface LogsDatasource {
  uid: string;
  name: string;
  type: string;
}

export interface LogEntry {
  /** Stable across queries, so a followed view can merge new results. */
  id: string;
  /** ISO time, to the millisecond. */
  time: string;
  /** Nanoseconds since the epoch, as decimal digits. */
  ns: string;
  msg: string;
  /** The `level` (or `severity`, `log.level`, `lvl`) field, when the entry has one. */
  level: string | null;
  /** Every other field of the entry, `_stream_id` aside. */
  fields: Record<string, string>;
}

export interface LogsQueryResult {
  entries: LogEntry[];
  /** The LogsQL sent, with the filters folded in. */
  query: string;
  from: string;
  to: string;
  /** True when the limit cut the result short. */
  limited: boolean;
  tookMs: number;
}

export interface LogsHits {
  /** Bucket start in epoch ms and the entries in it. */
  buckets: { time: number; count: number }[];
  total: number;
  stepMs: number;
  from: string;
  to: string;
}

export interface LogsFieldCount {
  name: string;
  hits: number;
}

export interface LogsHistoryEntry {
  id: string;
  connectionId: string;
  /** What was typed, before the filters. */
  query: string;
  filters: LogsFilter[];
  range: string;
  at: string;
  count: number | null;
  error: string | null;
}

export function newLogsConnection(partial: Partial<LogsConnection> = {}): LogsConnection {
  const ts = nowIso();
  return LogsConnectionSchema.parse({ id: newId(), createdAt: ts, updatedAt: ts, ...partial });
}

// ---------- Grafana address and session ----------

/** `grafana.example.com/` becomes `https://grafana.example.com`; a sub-path stays, query and hash go. Empty when it is no http(s) address. */
export function normalizeGrafanaUrl(raw: string): string {
  return normalizeServiceUrl(raw);
}

/** The address of a web service signed in to from Quiver, as Grafana and Metabase take it: scheme added, sub-path kept, query and hash dropped. */
export function normalizeServiceUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return '';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/** The browser session a Grafana address signs in to: one per origin, shared by every connection and workspace on this machine. */
export function grafanaPartition(grafanaUrl: string): string {
  const origin = new URL(normalizeGrafanaUrl(grafanaUrl)).origin.toLowerCase();
  return `persist:quiver-grafana-${origin.replace(/[^a-z0-9]+/g, '-')}`;
}

/** Host and data source, for lists. */
export function describeLogsConnection(conn: Pick<LogsConnection, 'grafanaUrl' | 'datasourceName'>): string {
  const host = conn.grafanaUrl.replace(/^[a-z]+:\/\//i, '').split(/[/?#]/)[0] ?? '';
  return [host, conn.datasourceName].filter(Boolean).join(' · ');
}

// ---------- LogsQL ----------

const LOGSQL_KEYWORDS = new Set(['and', 'or', 'not']);

/** A field name as LogsQL reads it: bare when it is a plain word, quoted otherwise. */
export function logsFieldName(name: string): string {
  return /^[\p{L}_][\p{L}\p{N}_.]*$/u.test(name) && !LOGSQL_KEYWORDS.has(name.toLowerCase()) ? name : JSON.stringify(name);
}

/** One filter as an exact match: `app:="api"`, or `!app:="api"` to exclude. */
export function logsFilterExpr(filter: Pick<LogsFilter, 'field' | 'value' | 'exclude'>): string {
  return `${filter.exclude ? '!' : ''}${logsFieldName(filter.field)}:=${JSON.stringify(filter.value)}`;
}

/** Split a query at its first pipe: the filters before it and the pipes from it on. Pipes inside quotes or parentheses (subqueries) stay. */
export function splitLogsQuery(query: string): { filters: string; pipes: string } {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < query.length; i++) {
    const ch = query[i]!;
    if (quote) {
      if (ch === '\\' && quote !== '`') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === '|' && depth === 0) return { filters: query.slice(0, i).trim(), pipes: query.slice(i).trim() };
  }
  return { filters: query.trim(), pipes: '' };
}

/**
 * The query with the filters ANDed in front of its filter part, which is parenthesised so an `or` in it
 * cannot swallow them. Pipes stay at the end unless `pipes` is false. An empty query is `*`.
 */
export function composeLogsQuery(query: string, filters: readonly Pick<LogsFilter, 'field' | 'value' | 'exclude'>[] = [], options: { pipes?: boolean } = {}): string {
  const split = splitLogsQuery(query);
  const base = split.filters === '*' ? '' : split.filters;
  const parts = filters.map(logsFilterExpr);
  if (base) parts.push(parts.length ? `(${base})` : base);
  const head = parts.length ? parts.join(' ') : '*';
  return options.pipes === false || !split.pipes ? head : `${head} ${split.pipes}`;
}

// ---------- time ----------

const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/** The ranges the view offers, as `now-<span>` to `now`. */
export const LOGS_RANGES = [
  { id: '5m', label: 'Last 5 minutes' },
  { id: '15m', label: 'Last 15 minutes' },
  { id: '1h', label: 'Last hour' },
  { id: '3h', label: 'Last 3 hours' },
  { id: '12h', label: 'Last 12 hours' },
  { id: '24h', label: 'Last 24 hours' },
  { id: '2d', label: 'Last 2 days' },
  { id: '7d', label: 'Last 7 days' },
] as const;

/**
 * A point in time as epoch ms: `now`, `now-15m`, a bare span (`15m`, meaning that long ago), epoch
 * seconds or milliseconds, or an ISO date. Spans take s, m, h, d and w.
 */
export function resolveLogsTime(raw: string, now: number = Date.now()): number {
  const value = raw.trim();
  if (value === '' || value === 'now') return now;
  const span = /^(?:now-)?(\d+)([smhdw])$/.exec(value);
  if (span) return now - Number(span[1]) * UNIT_MS[span[2]!]!;
  if (/^\d+$/.test(value)) return value.length <= 11 ? Number(value) * 1000 : Number(value);
  const parsed = Date.parse(value);
  if (!Number.isNaN(parsed)) return parsed;
  throw new QuiverError('INVALID_INPUT', `Cannot read "${raw}" as a time. Use now, now-15m, 15m, epoch milliseconds or an ISO date.`);
}

/** A whole step for about `buckets` histogram bars over the range. */
export function logsHitsStep(fromMs: number, toMs: number, buckets = 60): number {
  const steps = [1, 5, 10, 30, 60, 300, 600, 1800, 3600, 10_800, 21_600, 43_200, 86_400].map((s) => s * 1000);
  const want = Math.max(1, toMs - fromMs) / buckets;
  return steps.find((s) => s >= want) ?? steps[steps.length - 1]!;
}

/** How far ahead of this machine's clock a log writer's clock may run before a followed view misses its entries. */
export const LOGS_CLOCK_SKEW_MS = 5 * 60_000;

/**
 * The range a followed view polls: from the newest entry on screen (or `from` before there is one)
 * to a little past now and past that entry. A writer whose clock runs ahead of this machine's stamps
 * entries later than now; the look-ahead still fetches them, and the end stays after the start,
 * which the host would otherwise refuse.
 */
export function logsFollowRange(newestNs: string | null, from: string, now: number = Date.now()): { from: string; to: string } {
  const start = newestNs ? (BigInt(newestNs) / 1_000_000n).toString() : from;
  const startMs = Number(start);
  return { from: start, to: String((Number.isFinite(startMs) ? Math.max(now, startMs) : now) + LOGS_CLOCK_SKEW_MS) };
}

// ---------- Grafana data frames ----------

/** The parts of a Grafana data frame (`/api/ds/query`) the module reads. */
export interface GrafanaFrame {
  schema?: { fields?: { name: string; type?: string }[] };
  data?: { values?: unknown[][]; nanos?: (number[] | null | undefined)[] };
}

const LEVEL_KEYS = ['level', 'severity', 'log.level', 'lvl', 'levelname', 'loglevel'];

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function asText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value : typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function labelsOf(raw: unknown): Record<string, string> {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return {};
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) out[k] = asText(v);
  return out;
}

/** Newest first. Equal-length digit strings compare as numbers. */
export function compareLogEntries(a: Pick<LogEntry, 'ns'>, b: Pick<LogEntry, 'ns'>): number {
  if (a.ns.length !== b.ns.length) return b.ns.length - a.ns.length;
  return a.ns < b.ns ? 1 : a.ns > b.ns ? -1 : 0;
}

/**
 * Log entries from the frames VictoriaLogs returns through Grafana: `Time` (ms, with the remaining
 * nanoseconds beside it), `Line` (the message) and `labels` (the other fields). Newest first.
 */
export function parseLogFrames(frames: readonly GrafanaFrame[]): LogEntry[] {
  const out: LogEntry[] = [];
  for (const frame of frames) {
    const fields = frame.schema?.fields ?? [];
    const values = frame.data?.values ?? [];
    const timeAt = fields.findIndex((f) => f.type === 'time' || f.name === 'Time');
    const lineAt = fields.findIndex((f) => f.name === 'Line' || f.name === '_msg');
    const labelsAt = fields.findIndex((f) => f.name === 'labels');
    const rows = values[timeAt >= 0 ? timeAt : 0]?.length ?? 0;
    for (let i = 0; i < rows; i++) {
      const ms = Number(values[timeAt]?.[i] ?? 0);
      const extra = Number(frame.data?.nanos?.[timeAt]?.[i] ?? 0);
      const ns = (BigInt(Math.trunc(ms)) * 1_000_000n + BigInt(Math.trunc(extra))).toString();
      const msg = lineAt >= 0 ? asText(values[lineAt]?.[i]) : '';
      const labels = labelsAt >= 0 ? labelsOf(values[labelsAt]?.[i]) : {};
      const stream = labels['_stream_id'] ?? '';
      delete labels['_stream_id'];
      const levelKey = Object.keys(labels).find((k) => LEVEL_KEYS.includes(k.toLowerCase()));
      out.push({
        id: `${ns}-${fnv1a(`${stream}\u0000${msg}`)}`,
        time: new Date(ms).toISOString(),
        ns,
        msg,
        level: levelKey ? labels[levelKey]! : null,
        fields: labels,
      });
    }
  }
  return out.sort(compareLogEntries);
}

/** Histogram buckets from the frames of a `hits` query; several frames (one per stream group) add up. */
export function parseHitsFrames(frames: readonly GrafanaFrame[]): { buckets: { time: number; count: number }[]; total: number } {
  const byTime = new Map<number, number>();
  for (const frame of frames) {
    const fields = frame.schema?.fields ?? [];
    const values = frame.data?.values ?? [];
    const timeAt = fields.findIndex((f) => f.type === 'time');
    const valueAt = fields.findIndex((f, i) => i !== timeAt && f.type === 'number');
    if (timeAt < 0 || valueAt < 0) continue;
    values[timeAt]?.forEach((t, i) => {
      const time = Number(t);
      byTime.set(time, (byTime.get(time) ?? 0) + Number(values[valueAt]?.[i] ?? 0));
    });
  }
  const buckets = [...byTime].map(([time, count]) => ({ time, count })).sort((a, b) => a.time - b.time);
  return { buckets, total: buckets.reduce((n, b) => n + b.count, 0) };
}

export type LogLevelTone = 'error' | 'warn' | 'info' | 'debug' | 'other';

/** What a level value means, however the logger spells it: `Error`, `ERR`, `warning`, `Information`, `trace`… */
export function logLevelTone(level: string | null | undefined): LogLevelTone {
  const l = (level ?? '').trim().toLowerCase();
  if (!l) return 'other';
  if (/^(fatal|crit|critical|panic|emerg|emergency|alert|err|error|e|f)$/.test(l)) return 'error';
  if (/^(warn|warning|w)$/.test(l)) return 'warn';
  if (/^(info|information|informational|notice|i)$/.test(l)) return 'info';
  if (/^(debug|trace|verbose|dbg|d|t|v)$/.test(l)) return 'debug';
  return 'other';
}

/** Grafana's error for a failed query, without its `error from datasource:` prefix and the echoed query. */
export function cleanGrafanaError(message: string): string {
  return message
    .replace(/^error from datasource:\s*/i, '')
    .replace(/;\s*query=[\s\S]*$/, '')
    .trim();
}
