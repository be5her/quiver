import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';

interface Entry {
  at: number;
  msg: string;
  fields: Record<string, string>;
}

export interface FakeGrafana {
  url: string;
  /** What the module did: LogsQL sent, sign-ins completed, token renewals and logouts. */
  seen: { exprs: { expr: string; queryType: string; maxLines?: number }[]; logins: number; rotations: number; logouts: number };
  /** Make every live token due for renewal, as Grafana does every few minutes. */
  expireTokens(): void;
  close(): Promise<void>;
}

const LOGS_TYPE = 'victoriametrics-logs-datasource';

/**
 * Enough Grafana for the smoke test of the logs module: a login page that signs in without hands
 * (the meta refresh stands in for the click, the redirect for the identity provider), session cookies
 * that must be renewed, `/api/user`, the data sources in `/api/frontend/settings`, and `/api/ds/query`
 * answering a handful of entries the way VictoriaLogs does, with exact-match filters, a free-text
 * word, `field_names`, `stats by (...) count() hits` and `hits` buckets.
 */
export async function startFakeGrafana(): Promise<FakeGrafana> {
  const tokens = new Map<string, { renewBy: number }>();
  const seen: FakeGrafana['seen'] = { exprs: [], logins: 0, rotations: 0, logouts: 0 };
  const start = Date.now();
  const entries: Entry[] = [
    { at: start - 60_000, msg: 'GET /health 200', fields: { _stream_id: 's-api', app: 'api', level: 'Information' } },
    { at: start - 50_000, msg: 'payment failed: card declined', fields: { _stream_id: 's-api', app: 'api', level: 'Error', 'error.code': 'E42' } },
    { at: start - 40_000, msg: '{"event":"order.created","id":7,"items":[1,2]}', fields: { _stream_id: 's-worker', app: 'worker', level: 'Information' } },
    { at: start - 30_000, msg: 'retrying publish', fields: { _stream_id: 's-worker', app: 'worker', level: 'Warning' } },
    { at: start - 20_000, msg: 'cache miss', fields: { _stream_id: 's-api', app: 'api', level: 'Debug' } },
  ];

  const nowS = () => Math.floor(Date.now() / 1000);
  const cookieOf = (req: IncomingMessage, name: string) =>
    (req.headers.cookie ?? '')
      .split(';')
      .map((c) => c.trim().split('='))
      .find(([k]) => k === name)?.[1];
  const issue = (res: ServerResponse) => {
    const token = randomUUID();
    tokens.set(token, { renewBy: nowS() + 600 });
    res.setHeader('Set-Cookie', [`grafana_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`, `grafana_session_expiry=${nowS() + 600}; Path=/; SameSite=Lax; Max-Age=2592000`]);
  };
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  /** The token of a request, or why it is refused. */
  const auth = (req: IncomingMessage): { token: string } | { refused: string } => {
    const token = cookieOf(req, 'grafana_session');
    const state = token ? tokens.get(token) : undefined;
    if (!token || !state) return { refused: 'Unauthorized' };
    if (state.renewBy < nowS()) return { refused: 'session.token.rotate' };
    return { token };
  };

  const matches = (expr: string) => {
    const filterPart = expr.split('|')[0] ?? '';
    const exact = [...filterPart.matchAll(/(!?)("(?:[^"\\]|\\.)*"|[\w.]+):="((?:[^"\\]|\\.)*)"/g)].map((m) => ({
      exclude: m[1] === '!',
      field: m[2]!.startsWith('"') ? (JSON.parse(m[2]!) as string) : m[2]!,
      value: JSON.parse(`"${m[3]}"`) as string,
    }));
    const words = filterPart
      .replace(/(!?)("(?:[^"\\]|\\.)*"|[\w.]+):="((?:[^"\\]|\\.)*)"/g, ' ')
      .replace(/[()*]/g, ' ')
      .split(/\s+/)
      .filter(Boolean);
    return (e: Entry) => exact.every((f) => ((e.fields[f.field] ?? '') === f.value) !== f.exclude) && words.every((w) => e.msg.toLowerCase().includes(w.toLowerCase()));
  };

  const logsFrame = (rows: { at: number; line: string; labels: Record<string, string> }[]) => ({
    schema: { refId: 'A', fields: [{ name: 'Time', type: 'time' }, { name: 'Line', type: 'string' }, { name: 'labels', type: 'other' }] },
    data: { values: [rows.map((r) => r.at), rows.map((r) => r.line), rows.map((r) => r.labels)], nanos: [rows.map((_r, i) => i * 7), null, null] },
  });

  const dsQuery = (body: { from: string; to: string; queries: { expr: string; queryType: string; maxLines?: number; step?: string; datasource: { uid: string } }[] }) => {
    const q = body.queries[0]!;
    seen.exprs.push({ expr: q.expr, queryType: q.queryType, maxLines: q.maxLines });
    if (q.datasource.uid !== 'vl-smoke') return { status: 400, body: { results: { A: { error: `data source ${q.datasource.uid} not found`, frames: [] } } } };
    if (q.expr.includes('(((')) {
      return { status: 400, body: { results: { A: { error: `error from datasource: cannot parse \`query\` arg: missing ')'; context: [${q.expr}]; query=${q.expr}\n`, status: 500, frames: [] } } } };
    }
    const from = Number(body.from);
    const to = Number(body.to);
    const hit = entries.filter((e) => e.at >= from && e.at <= to).filter(matches(q.expr));
    if (q.queryType === 'hits') {
      const step = Number.parseInt(q.step ?? '60', 10) * 1000;
      const buckets = new Map<number, number>();
      for (const e of hit) buckets.set(Math.floor(e.at / step) * step, (buckets.get(Math.floor(e.at / step) * step) ?? 0) + 1);
      const times = [...buckets.keys()].sort((a, b) => a - b);
      return { status: 200, body: { results: { A: { frames: [{ schema: { fields: [{ name: 'Time', type: 'time' }, { name: 'Value', type: 'number' }] }, data: { values: [times, times.map((t) => buckets.get(t))] } }] } } } };
    }
    if (q.expr.includes('| field_names')) {
      const counts = new Map<string, number>();
      for (const e of hit) for (const k of ['_msg', '_time', '_stream_id', ...Object.keys(e.fields)]) counts.set(k, (counts.get(k) ?? 0) + 1);
      const rows = [...counts].map(([name, hits]) => ({ at: to, line: JSON.stringify({ name, hits: String(hits) }), labels: { name, hits: String(hits) } }));
      return { status: 200, body: { results: { A: { frames: [logsFrame(rows)] } } } };
    }
    const stats = /\| stats by \(("[^"]+"|[\w.]+)\) count\(\) hits/.exec(q.expr);
    if (stats) {
      const field = stats[1]!.startsWith('"') ? (JSON.parse(stats[1]!) as string) : stats[1]!;
      const counts = new Map<string, number>();
      for (const e of hit) counts.set(e.fields[field] ?? '', (counts.get(e.fields[field] ?? '') ?? 0) + 1);
      const rows = [...counts].map(([value, hits]) => ({ at: to, line: JSON.stringify({ [field]: value, hits: String(hits) }), labels: { [field]: value, hits: String(hits) } }));
      return { status: 200, body: { results: { A: { frames: [logsFrame(rows)] } } } };
    }
    // Unsorted, oldest first, the way a raw query can come back.
    const rows = hit.slice(0, q.maxLines ?? 1000).map((e) => ({ at: e.at, line: e.msg, labels: e.fields }));
    return { status: 200, body: { results: { A: { frames: [logsFrame(rows)] } } } };
  };

  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x');
      const path = url.pathname;
      if (path === '/login' && req.method === 'GET') {
        const a = auth(req);
        if ('token' in a) {
          res.writeHead(302, { location: '/' });
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<!doctype html><title>Grafana</title><meta http-equiv="refresh" content="0;url=/login/sso"><p>Sign in with SSO</p>');
        return;
      }
      if (path === '/login/sso') {
        res.writeHead(302, { location: '/login/sso/callback?code=smoke' });
        res.end();
        return;
      }
      if (path === '/login/sso/callback') {
        seen.logins++;
        issue(res);
        res.writeHead(302, { location: '/' });
        res.end();
        return;
      }
      if (path === '/logout') {
        const token = cookieOf(req, 'grafana_session');
        if (token) tokens.delete(token);
        seen.logouts++;
        res.writeHead(302, { location: '/login', 'Set-Cookie': ['grafana_session=; Path=/; Max-Age=0', 'grafana_session_expiry=; Path=/; Max-Age=0'] });
        res.end();
        return;
      }
      if (path === '/') {
        const a = auth(req);
        if (!('token' in a)) {
          res.writeHead(302, { location: '/login' });
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<!doctype html><title>Home - Grafana</title><p>Welcome</p>');
        return;
      }
      if (path === '/api/user/auth-tokens/rotate' && req.method === 'POST') {
        const token = cookieOf(req, 'grafana_session');
        if (!token || !tokens.has(token)) return json(res, 401, { message: 'Unauthorized' });
        tokens.delete(token);
        seen.rotations++;
        issue(res);
        return json(res, 200, {});
      }
      if (path.startsWith('/api/')) {
        const a = auth(req);
        if (!('token' in a)) return json(res, 401, { message: 'Unauthorized', messageId: a.refused === 'session.token.rotate' ? a.refused : 'auth.unauthorized' });
        if (path === '/api/user') return json(res, 200, { id: 1, login: 'smoke', email: 'smoke@example.com', name: 'Smoke Test', orgId: 1 });
        if (path === '/api/frontend/settings') {
          return json(res, 200, {
            datasources: {
              'VictoriaLogs-Smoke': { uid: 'vl-smoke', type: LOGS_TYPE, name: 'VictoriaLogs-Smoke' },
              Prometheus: { uid: 'prom', type: 'prometheus', name: 'Prometheus' },
            },
          });
        }
        if (path === '/api/ds/query' && req.method === 'POST') {
          const out = dsQuery(JSON.parse(raw || '{}'));
          return json(res, out.status, out.body);
        }
      }
      json(res, 404, { message: 'Not found' });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    expireTokens: () => {
      for (const state of tokens.values()) state.renewBy = nowS() - 1;
    },
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
