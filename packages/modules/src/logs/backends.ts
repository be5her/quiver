import {
  QuiverError,
  cleanGrafanaError,
  logsFieldName,
  normalizeVictoriaLogsUrl,
  parseHitsFrames,
  parseLogFrames,
  parseVictoriaLogsHits,
  parseVictoriaLogsLines,
  parseVictoriaLogsValues,
  victoriaLogsHeaders,
  type GrafanaFrame,
  type HostApi,
  type LogEntry,
  type LogsConnection,
  type LogsConnectionTest,
  type LogsFieldCount,
} from '@quiver/core';
import { fetch as undiciFetch } from 'undici';
import { grafanaSessions as sessions } from '../grafana/sessions';

export interface LogsRange {
  fromMs: number;
  toMs: number;
}

/**
 * Where a connection's queries go. Each method takes LogsQL with the filters already folded in (the
 * commands do that, so both kinds send the same query) and gives back the shapes the view reads, so the
 * view cannot tell the kinds apart.
 */
export interface LogsBackend {
  /** Entries newest first, at most `limit`. */
  query(expr: string, r: LogsRange, limit: number): Promise<LogEntry[]>;
  /** Entries per bucket of `stepMs`. `expr` has no pipes. */
  hits(expr: string, r: LogsRange, stepMs: number): Promise<{ buckets: { time: number; count: number }[]; total: number }>;
  /** Field names with how many entries have each. `expr` has no pipes. */
  fieldNames(expr: string, r: LogsRange): Promise<LogsFieldCount[]>;
  /** The values of one field with their counts, at most `limit`. `expr` has no pipes. */
  fieldValues(expr: string, field: string, r: LogsRange, limit: number): Promise<LogsFieldCount[]>;
  /** Whether the server answers with these credentials, without throwing. */
  check(options?: { version?: boolean }): Promise<LogsConnectionTest>;
}

// ---------- through Grafana ----------

interface DsQueryBody {
  results?: Record<string, { error?: string; status?: number; frames?: GrafanaFrame[] }>;
  message?: string;
}

/** A VictoriaLogs data source queried through Grafana's `/api/ds/query`, the way Explore runs it, so the data source's tenant and auth apply. */
export class GrafanaLogsBackend implements LogsBackend {
  constructor(
    private readonly host: HostApi,
    private readonly conn: LogsConnection,
  ) {}

  async query(expr: string, r: LogsRange, limit: number): Promise<LogEntry[]> {
    return parseLogFrames(await this.dsQuery(expr, r, { queryType: 'instant', maxLines: limit })).slice(0, limit);
  }

  async hits(expr: string, r: LogsRange, stepMs: number) {
    return parseHitsFrames(await this.dsQuery(expr, r, { queryType: 'hits', step: `${stepMs / 1000}s`, intervalMs: stepMs }));
  }

  async fieldNames(expr: string, r: LogsRange): Promise<LogsFieldCount[]> {
    const rows = parseLogFrames(await this.dsQuery(`${expr} | field_names`, r, { queryType: 'instant', maxLines: 1000 }));
    return rows.map((row) => ({ name: row.fields['name'] ?? '', hits: Number(row.fields['hits'] ?? 0) }));
  }

  async fieldValues(expr: string, field: string, r: LogsRange, limit: number): Promise<LogsFieldCount[]> {
    const name = logsFieldName(field);
    const rows = parseLogFrames(await this.dsQuery(`${expr} | stats by (${name}) count() hits | sort by (hits desc) | limit ${limit}`, r, { queryType: 'instant', maxLines: limit }));
    return rows.map((row) => ({ name: row.fields[field] ?? '', hits: Number(row.fields['hits'] ?? 0) }));
  }

  async check(): Promise<LogsConnectionTest> {
    const started = Date.now();
    const session = await sessions.check(this.host, this.conn.grafanaUrl);
    if (session.state === 'signed-in') return { ok: true, tookMs: Date.now() - started };
    return { ok: false, code: 'SIGN_IN_REQUIRED', error: session.error ?? 'Not signed in to Grafana on this machine', tookMs: Date.now() - started };
  }

  private async dsQuery(expr: string, r: LogsRange, extra: Record<string, unknown>): Promise<GrafanaFrame[]> {
    const conn = this.conn;
    const { status, body } = await sessions.request<DsQueryBody>(this.host, conn.grafanaUrl, '/api/ds/query', {
      method: 'POST',
      body: {
        from: String(r.fromMs),
        to: String(r.toMs),
        queries: [{ refId: 'A', datasource: { uid: conn.datasourceUid, type: conn.datasourceType }, expr, ...extra }],
      },
    });
    const result = typeof body === 'object' && body ? body.results?.['A'] : undefined;
    if (result?.error) throw new QuiverError('REQUEST_FAILED', cleanGrafanaError(result.error), { query: expr });
    if (status < 200 || status >= 300) {
      const message = typeof body === 'object' && body?.message ? body.message : String(body).slice(0, 300);
      throw new QuiverError('REQUEST_FAILED', `Grafana answered ${status}: ${message}`, { query: expr });
    }
    return result?.frames ?? [];
  }
}

// ---------- VictoriaLogs directly ----------

const TIMEOUT_MS = 30_000;

/** The most a select endpoint's answer is read: 5000 entries of a few KB each fit, a runaway pipe result does not. */
export const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

/** The `vm_app_version{version="victoria-logs-…"}` line VictoriaLogs exposes in `/metrics`. */
const VERSION_RE = /vm_app_version\{[^}]*\bversion="([^"]+)"/;

/** A VictoriaLogs server queried over its HTTP API (`/select/logsql/*`), with the connection's tenant and basic or bearer auth. */
export class VictoriaLogsBackend implements LogsBackend {
  private readonly base: string;

  constructor(
    private readonly conn: LogsConnection,
    private readonly secret: string,
  ) {
    this.base = normalizeVictoriaLogsUrl(conn.url);
    if (!this.base) throw new QuiverError('INVALID_INPUT', `"${conn.name}" has no VictoriaLogs address yet`);
  }

  async query(expr: string, r: LogsRange, limit: number): Promise<LogEntry[]> {
    const text = await this.select('/select/logsql/query', { query: expr, ...this.span(r), limit: String(limit) });
    return parseVictoriaLogsLines(text).slice(0, limit);
  }

  async hits(expr: string, r: LogsRange, stepMs: number) {
    return parseVictoriaLogsHits(this.json(await this.select('/select/logsql/hits', { query: expr, ...this.span(r), step: `${stepMs / 1000}s` }), expr));
  }

  async fieldNames(expr: string, r: LogsRange): Promise<LogsFieldCount[]> {
    return parseVictoriaLogsValues(this.json(await this.select('/select/logsql/field_names', { query: expr, ...this.span(r) }), expr));
  }

  async fieldValues(expr: string, field: string, r: LogsRange, limit: number): Promise<LogsFieldCount[]> {
    return parseVictoriaLogsValues(this.json(await this.select('/select/logsql/field_values', { query: expr, field, ...this.span(r), limit: String(limit) }), expr));
  }

  /** The field names of the last minute: cheap, and it goes through the same auth and tenant as a query. */
  async check(options: { version?: boolean } = {}): Promise<LogsConnectionTest> {
    const started = Date.now();
    const now = Date.now();
    try {
      await this.fieldNames('*', { fromMs: now - 60_000, toMs: now });
    } catch (err) {
      const code = err instanceof QuiverError ? err.code : 'INTERNAL';
      return { ok: false, code, error: (err as Error).message, tookMs: Date.now() - started };
    }
    const version = options.version ? await this.version() : undefined;
    return { ok: true, ...(version ? { version } : {}), tookMs: Date.now() - started };
  }

  /** From `/metrics`, when the server serves it to these credentials within a few seconds; otherwise none. */
  private async version(): Promise<string | undefined> {
    try {
      const res = await undiciFetch(`${this.base}/metrics`, { headers: this.headers(), signal: AbortSignal.timeout(3000) });
      if (!res.ok) return undefined;
      return VERSION_RE.exec(await res.text())?.[1];
    } catch {
      return undefined;
    }
  }

  private span(r: LogsRange): { start: string; end: string } {
    return { start: new Date(r.fromMs).toISOString(), end: new Date(r.toMs).toISOString() };
  }

  private headers(): Record<string, string> {
    return victoriaLogsHeaders(this.conn, this.secret);
  }

  private where(): string {
    return new URL(this.base).host;
  }

  /** One request to a select endpoint, the arguments as a form. A refused credential and an unreachable server have codes of their own. */
  private async select(path: string, args: Record<string, string>): Promise<string> {
    let res: Awaited<ReturnType<typeof undiciFetch>>;
    try {
      res = await undiciFetch(`${this.base}${path}`, {
        method: 'POST',
        headers: { ...this.headers(), 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams(args).toString(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      const cause = (err as { cause?: { code?: string; message?: string } }).cause;
      const why = cause?.code ?? cause?.message ?? (err as Error).message;
      throw new QuiverError('LOGS_UNREACHABLE', `VictoriaLogs at ${this.where()} did not answer: ${this.scrub(why)}`, { url: this.base });
    }
    const text = await this.readCapped(res, args['query']);
    const message = this.scrub(text.trim().slice(0, 500));
    if (res.status === 401 || res.status === 403) {
      throw new QuiverError('LOGS_AUTH_FAILED', `VictoriaLogs at ${this.where()} refused the credentials (${res.status})${message ? `: ${message}` : ''}`, { url: this.base, status: res.status });
    }
    if (res.status < 200 || res.status >= 300) throw new QuiverError('REQUEST_FAILED', message || `VictoriaLogs answered ${res.status}`, { query: args['query'], status: res.status });
    return text;
  }

  /** The body as text, refused past MAX_RESPONSE_BYTES rather than read into memory whole. */
  private async readCapped(res: Awaited<ReturnType<typeof undiciFetch>>, query: string | undefined): Promise<string> {
    const tooLarge = () => new QuiverError('REQUEST_FAILED', `VictoriaLogs answered more than ${MAX_RESPONSE_BYTES / 1024 / 1024} MB; narrow the query, lower the limit or keep fewer fields with \`| fields …\``, { query });
    if (Number(res.headers.get('content-length') ?? 0) > MAX_RESPONSE_BYTES) {
      await res.body?.cancel().catch(() => {});
      throw tooLarge();
    }
    if (!res.body) return '';
    const decoder = new TextDecoder();
    let text = '';
    let bytes = 0;
    try {
      // Throwing out of the loop cancels the rest of the body.
      for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
        bytes += chunk.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) throw tooLarge();
        text += decoder.decode(chunk, { stream: true });
      }
    } catch (err) {
      if (err instanceof QuiverError) throw err;
      throw new QuiverError('LOGS_UNREACHABLE', `VictoriaLogs at ${this.where()} stopped answering: ${this.scrub((err as Error).message)}`, { url: this.base });
    }
    return text + decoder.decode();
  }

  /** A message with the stored password or token taken out, should a library ever quote a header back. */
  private scrub(message: string): string {
    return this.secret.length >= 4 ? message.split(this.secret).join('•••') : message;
  }

  private json(text: string, expr: string): unknown {
    try {
      return JSON.parse(text);
    } catch {
      throw new QuiverError('REQUEST_FAILED', `VictoriaLogs answered something other than JSON: ${text.slice(0, 200)}`, { query: expr });
    }
  }
}
