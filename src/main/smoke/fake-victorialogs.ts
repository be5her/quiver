import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { FakeLogEntry, FakeLogs } from './fake-logs';

/** What a request must carry; the fake refuses with 401 otherwise. */
export type FakeVictoriaLogsAuth = { kind: 'none' } | { kind: 'basic'; username: string; password: string } | { kind: 'bearer'; token: string };

export interface FakeVictoriaLogs {
  url: string;
  /** Every request: the path, its arguments, the tenant it named (`account:project`, or null) and its Authorization header. */
  seen: { path: string; args: Record<string, string>; tenant: string | null; authorization: string | null; status: number }[];
  /** Require these credentials from now on. */
  requireAuth(auth: FakeVictoriaLogsAuth): void;
  /** The tenant the entries belong to; any other tenant sees none, as VictoriaLogs keeps tenants apart. Null: the default tenant 0:0. */
  setTenant(tenant: { accountId: number; projectId: number } | null): void;
  close(): Promise<void>;
}

export const FAKE_VICTORIALOGS_VERSION = 'victoria-logs-20261001-101010-tags-v1.30.0-0-g0f00ba7';

/**
 * Enough of a VictoriaLogs server for the smoke test of the logs module's direct connections: the four
 * `/select/logsql` endpoints the module calls (`query` as JSON lines, `hits`, `field_names` and
 * `field_values`), `/health` and a `/metrics` with the version line. It answers from the same entries as
 * the fake Grafana (`fake-logs.ts`), checks basic or bearer auth when told to, and keeps tenants apart.
 */
export async function startFakeVictoriaLogs(logs: FakeLogs): Promise<FakeVictoriaLogs> {
  const seen: FakeVictoriaLogs['seen'] = [];
  let auth: FakeVictoriaLogsAuth = { kind: 'none' };
  let tenant = '0:0';

  const authorized = (req: IncomingMessage) => {
    const header = req.headers.authorization ?? '';
    if (auth.kind === 'none') return true;
    if (auth.kind === 'bearer') return header === `Bearer ${auth.token}`;
    return header === `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`;
  };
  const time = (e: FakeLogEntry) => `${new Date(e.at).toISOString().slice(0, -1)}${String(e.nanos).padStart(6, '0')}Z`;
  const reply = (res: ServerResponse, status: number, type: string, body: string) => {
    res.writeHead(status, { 'content-type': type });
    res.end(body);
  };

  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x');
      const args: Record<string, string> = Object.fromEntries(url.searchParams);
      if (req.method === 'POST' && String(req.headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded')) Object.assign(args, Object.fromEntries(new URLSearchParams(raw)));
      const named = req.headers['accountid'] !== undefined || req.headers['projectid'] !== undefined ? `${req.headers['accountid'] ?? 0}:${req.headers['projectid'] ?? 0}` : null;
      const entry = { path: url.pathname, args, tenant: named, authorization: req.headers.authorization ?? null, status: 200 };
      seen.push(entry);
      const send = (status: number, type: string, body: string) => {
        entry.status = status;
        reply(res, status, type, body);
      };

      if (url.pathname === '/health') return send(200, 'text/plain', 'OK');
      if (!authorized(req)) return send(401, 'text/plain', 'Unauthorized: missing or wrong credentials');
      if (url.pathname === '/metrics') return send(200, 'text/plain', `# HELP vm_app_version\nvm_app_version{version="${FAKE_VICTORIALOGS_VERSION}", short_version="v1.30.0"} 1\nvl_rows_ingested_total 5\n`);
      if (!url.pathname.startsWith('/select/logsql/')) return send(404, 'text/plain', 'unsupported path');

      const query = args['query'] ?? '';
      if (query.includes('(((')) return send(400, 'text/plain', `cannot parse query [${query}]: missing ')'`);
      const from = Date.parse(args['start'] ?? '') || 0;
      const to = Date.parse(args['end'] ?? '') || Date.now();
      // Another tenant's entries are not there for this one.
      const hit = (named ?? '0:0') === tenant ? logs.select(query, from, to) : [];

      switch (url.pathname) {
        case '/select/logsql/query': {
          const limit = Number(args['limit'] ?? 0) || hit.length;
          // The newest `limit`, written oldest first, the way a raw query can come back.
          const rows = [...hit].sort((a, b) => a.at - b.at).slice(-limit);
          return send(200, 'application/stream+json', rows.map((e) => `${JSON.stringify({ _time: time(e), _msg: e.msg, _stream: `{app="${e.fields['app'] ?? ''}"}`, ...e.fields })}\n`).join(''));
        }
        case '/select/logsql/hits': {
          const step = (Number.parseInt(args['step'] ?? '60', 10) || 60) * 1000;
          const buckets = logs.buckets(hit, step);
          const body = { hits: buckets.length ? [{ fields: {}, timestamps: buckets.map(([t]) => new Date(t).toISOString()), values: buckets.map(([, n]) => n), total: hit.length }] : [] };
          return send(200, 'application/json', JSON.stringify(body));
        }
        case '/select/logsql/field_names':
          return send(200, 'application/json', JSON.stringify({ values: [...logs.fieldNames(hit), ['_stream', hit.length] as [string, number]].filter(([, n]) => n > 0).map(([value, hits]) => ({ value, hits })) }));
        case '/select/logsql/field_values': {
          const limit = Number(args['limit'] ?? 0) || Infinity;
          const values = logs
            .fieldValues(hit, args['field'] ?? '')
            .sort((a, b) => b[1] - a[1])
            .slice(0, limit);
          return send(200, 'application/json', JSON.stringify({ values: values.map(([value, hits]) => ({ value, hits })) }));
        }
        default:
          return send(404, 'text/plain', 'unsupported path');
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    requireAuth: (next) => {
      auth = next;
    },
    setTenant: (next) => {
      tenant = next ? `${next.accountId}:${next.projectId}` : '0:0';
    },
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
