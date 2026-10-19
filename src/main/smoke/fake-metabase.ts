import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';

export interface FakeMetabase {
  url: string;
  /** The API key the fake accepts in `x-api-key`. */
  apiKey: string;
  /** What the module did: sign-ins completed, sessions ended, native SQL run, requests made with the key, export formats asked for. */
  seen: { logins: number; logouts: number; sql: string[]; apiKeyCalls: number; exports: string[] };
  close(): Promise<void>;
}

const API_KEY = 'mb-smoke-key';
const COOKIE = 'metabase.SESSION';

const ORDER_COLS = [
  { name: 'id', display_name: 'ID', base_type: 'type/Integer' },
  { name: 'customer', display_name: 'Customer', base_type: 'type/Text' },
  { name: 'total', display_name: 'Total', base_type: 'type/Float' },
];
const ORDER_ROWS: unknown[][] = [
  [1, 'Ada', 12.5],
  [2, 'Linus', 30],
  [3, 'Grace', 7.25],
];

const CUSTOMER_PARAMETER = { id: 'p1', name: 'Customer', slug: 'customer', type: 'string/=', target: ['variable', ['template-tag', 'customer']] };

const CARDS: Record<number, Record<string, unknown>> = {
  1: {
    id: 1,
    name: 'All orders',
    description: 'Every order',
    database_id: 1,
    display: 'table',
    collection_id: null,
    parameters: [],
    dataset_query: { type: 'native', database: 1, native: { query: 'SELECT * FROM orders', 'template-tags': {} } },
  },
  2: {
    id: 2,
    name: 'Orders by customer',
    description: null,
    database_id: 1,
    display: 'table',
    collection_id: 5,
    parameters: [CUSTOMER_PARAMETER],
    dataset_query: {
      type: 'native',
      database: 1,
      native: {
        query: 'SELECT * FROM orders WHERE customer = {{customer}}',
        'template-tags': { customer: { id: 't1', name: 'customer', 'display-name': 'Customer', type: 'text' } },
      },
    },
  },
};

/** Items as `/api/collection/:id/items` and `/api/search` list them. */
const ITEMS = [
  { id: 1, model: 'card', name: 'All orders', description: 'Every order', collection_id: null },
  { id: 1, model: 'dashboard', name: 'Overview', description: 'The sales overview', collection_id: null },
  // Metabase lists sub-collections among a collection's items too, under `collection`.
  { id: 5, model: 'collection', name: 'Sales', description: null, collection_id: null },
  { id: 2, model: 'card', name: 'Orders by customer', description: null, collection_id: 5 },
];

const METADATA = {
  id: 1,
  name: 'Smoke DB',
  engine: 'postgres',
  tables: [
    {
      id: 11,
      name: 'orders',
      display_name: 'Orders',
      schema: 'public',
      fields: [
        { id: 101, name: 'id', display_name: 'ID', base_type: 'type/Integer', database_type: 'int4' },
        { id: 102, name: 'customer', display_name: 'Customer', base_type: 'type/Text', database_type: 'text' },
        { id: 103, name: 'total', display_name: 'Total', base_type: 'type/Float', database_type: 'numeric' },
      ],
    },
    {
      id: 12,
      name: 'customers',
      display_name: 'Customers',
      schema: 'public',
      fields: [
        { id: 104, name: 'id', display_name: 'ID', base_type: 'type/Integer', database_type: 'int4' },
        { id: 105, name: 'name', display_name: 'Name', base_type: 'type/Text', database_type: 'text' },
      ],
    },
  ],
};

/**
 * Enough Metabase for the smoke test of the metabase module: a login page that signs in without hands through a popup
 * (the identity provider's window posts back to its opener and closes, as Google sign-in does) and sets `metabase.SESSION`, or an API key
 * in `x-api-key`; one database with two tables, a collection tree with two questions and a dashboard, search, native
 * queries (`boom` fails the way Metabase reports a SQL error, `big` comes back cut at 2000 rows) and the export
 * endpoints, which take form-encoded bodies as Metabase's own download buttons send them.
 */
export async function startFakeMetabase(): Promise<FakeMetabase> {
  const sessions = new Set<string>();
  const seen: FakeMetabase['seen'] = { logins: 0, logouts: 0, sql: [], apiKeyCalls: 0, exports: [] };

  const cookieOf = (req: IncomingMessage, name: string) =>
    (req.headers.cookie ?? '')
      .split(';')
      .map((c) => c.trim().split('='))
      .find(([k]) => k === name)?.[1];
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const signedIn = (req: IncomingMessage) => {
    const token = cookieOf(req, COOKIE);
    return Boolean(token && sessions.has(token));
  };
  /** Whether a request to `/api` may pass: a live session cookie or the key. */
  const authorised = (req: IncomingMessage) => {
    const key = req.headers['x-api-key'];
    if (key !== undefined) {
      if (key !== API_KEY) return false;
      seen.apiKeyCalls++;
      return true;
    }
    return signedIn(req);
  };

  /** The rows a native query answers, or Metabase's failure. */
  const nativeRows = (sql: string): { rows: unknown[][]; truncated?: number } | { error: string } => {
    if (sql.includes('boom')) return { error: 'ERROR: relation "boom" does not exist' };
    if (sql.includes('big')) return { rows: Array.from({ length: 2000 }, (_, i) => [i + 1, `customer ${i + 1}`, i]), truncated: 2000 };
    return { rows: ORDER_ROWS };
  };
  /** A card's rows; card 2 keeps the orders of the customer its parameter names. */
  const cardRows = (id: number, parameters: { id?: string; value?: unknown }[]) => {
    if (id !== 2) return ORDER_ROWS;
    const given = parameters.find((p) => p.id === CUSTOMER_PARAMETER.id)?.value;
    const value = Array.isArray(given) ? given[0] : given;
    if (value === undefined || value === null || value === '') return ORDER_ROWS;
    const matching = ORDER_ROWS.filter((r) => r[1] === value);
    return matching.length ? matching : [[0, String(value), 0]];
  };
  const dataset = (rows: unknown[][], truncated?: number) => ({
    status: 'completed',
    row_count: rows.length,
    running_time: 12,
    data: { cols: ORDER_COLS, rows, ...(truncated ? { rows_truncated: truncated } : {}) },
  });
  const failed = (error: string) => ({ status: 'failed', error, error_type: 'invalid-query', row_count: 0, running_time: 3, data: { rows: [], cols: [] } });

  /** The bytes of an export, in the content type Metabase answers with. */
  const exported = (format: string, rows: unknown[][]): { type: string; body: Buffer } => {
    const names = ORDER_COLS.map((c) => c.display_name);
    if (format === 'csv') return { type: 'text/csv', body: Buffer.from([names.join(','), ...rows.map((r) => r.join(','))].join('\n') + '\n') };
    if (format === 'json') return { type: 'application/json', body: Buffer.from(JSON.stringify(rows.map((r) => Object.fromEntries(names.map((n, i) => [n, r[i]]))))) };
    // Not a real workbook, but shaped like one: a zip signature and a few hundred bytes.
    const head = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
    return { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body: Buffer.concat([head, Buffer.alloc(296, 0x20)]) };
  };
  const formOf = (req: IncomingMessage, raw: string) => {
    const type = String(req.headers['content-type'] ?? '');
    return type.startsWith('application/x-www-form-urlencoded') ? new URLSearchParams(raw) : null;
  };

  const api = (req: IncomingMessage, res: ServerResponse, path: string, url: URL, raw: string) => {
    const method = req.method ?? 'GET';
    if (path === '/api/session/properties') return json(res, 200, { version: { tag: 'v0.52.0' }, 'site-name': 'Smoke Metabase' });
    if (!authorised(req)) return json(res, 401, { message: 'Unauthenticated' });

    if (path === '/api/session' && method === 'DELETE') {
      const token = cookieOf(req, COOKIE);
      if (token) sessions.delete(token);
      seen.logouts++;
      res.writeHead(204, { 'Set-Cookie': `${COOKIE}=; Path=/; Max-Age=0` });
      res.end();
      return;
    }
    if (path === '/api/user/current') return json(res, 200, { id: 1, email: 'smoke@example.com', common_name: 'Smoke User', first_name: 'Smoke', last_name: 'User' });
    if (path === '/api/database') return json(res, 200, { data: [{ id: 1, name: 'Smoke DB', engine: 'postgres' }], total: 1 });
    if (path === '/api/database/1/metadata') return json(res, 200, METADATA);
    if (path === '/api/collection/tree') return json(res, 200, [{ id: 5, name: 'Sales', location: '/', children: [] }]);
    const items = /^\/api\/collection\/(root|\d+)\/items$/.exec(path);
    if (items) {
      const collectionId = items[1] === 'root' ? null : Number(items[1]);
      if (collectionId !== null && collectionId !== 5) return json(res, 404, { message: 'Not found.' });
      const models = url.searchParams.getAll('models');
      const data = ITEMS.filter((i) => i.collection_id === collectionId && (models.length === 0 || models.includes(i.model)));
      return json(res, 200, { data, total: data.length, models: [...new Set(data.map((i) => i.model))], limit: null, offset: null });
    }
    if (path === '/api/search') {
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      const models = url.searchParams.getAll('models');
      const data = ITEMS.filter((i) => i.name.toLowerCase().includes(q) && (models.length === 0 || models.includes(i.model)));
      return json(res, 200, { data, total: data.length });
    }
    if (path === '/api/dashboard/1') {
      return json(res, 200, {
        id: 1,
        name: 'Overview',
        description: 'The sales overview',
        dashcards: [
          { id: 11, card_id: 1, card: { id: 1, name: 'All orders' } },
          { id: 12, card_id: 2, card: { id: 2, name: 'Orders by customer' } },
          // A text box: a virtual card with no question behind it.
          { id: 13, card_id: null, card: { name: null, display: 'text' }, visualization_settings: { text: 'Notes', virtual_card: { display: 'text' } } },
        ],
      });
    }

    const card = /^\/api\/card\/(\d+)$/.exec(path);
    if (card && method === 'GET') {
      const found = CARDS[Number(card[1])];
      return found ? json(res, 200, found) : json(res, 404, { message: 'Not found.' });
    }
    const cardQuery = /^\/api\/card\/(\d+)\/query$/.exec(path);
    if (cardQuery && method === 'POST') {
      const id = Number(cardQuery[1]);
      if (!CARDS[id]) return json(res, 404, { message: 'Not found.' });
      const body = JSON.parse(raw || '{}') as { parameters?: { id?: string; value?: unknown }[] };
      return json(res, 202, dataset(cardRows(id, body.parameters ?? [])));
    }
    const cardExport = /^\/api\/card\/(\d+)\/query\/(csv|json|xlsx)$/.exec(path);
    if (cardExport && method === 'POST') {
      const id = Number(cardExport[1]);
      if (!CARDS[id]) return json(res, 404, { message: 'Not found.' });
      const form = formOf(req, raw);
      if (!form) return json(res, 400, { message: 'Expected a form-encoded body' });
      const parameters = JSON.parse(form.get('parameters') || '[]') as { id?: string; value?: unknown }[];
      seen.exports.push(cardExport[2]!);
      const out = exported(cardExport[2]!, cardRows(id, parameters));
      res.writeHead(200, { 'content-type': out.type, 'content-disposition': `attachment; filename="query_result.${cardExport[2]}"` });
      res.end(out.body);
      return;
    }
    if (path === '/api/dataset' && method === 'POST') {
      const body = JSON.parse(raw || '{}') as { database?: number; type?: string; native?: { query?: string } };
      const sql = body.native?.query ?? '';
      seen.sql.push(sql);
      if (body.database !== 1) return json(res, 202, failed(`Database ${String(body.database)} does not exist.`));
      const out = nativeRows(sql);
      return json(res, 202, 'error' in out ? failed(out.error) : dataset(out.rows, out.truncated));
    }
    const datasetExport = /^\/api\/dataset\/(csv|json|xlsx)$/.exec(path);
    if (datasetExport && method === 'POST') {
      const form = formOf(req, raw);
      const query = form?.get('query');
      if (!form || !query) return json(res, 400, { message: 'Expected a form-encoded body with a query' });
      const parsed = JSON.parse(query) as { database?: number; native?: { query?: string } };
      const sql = parsed.native?.query;
      if (parsed.database !== 1 || typeof sql !== 'string') return json(res, 400, { message: 'The query has no native SQL for database 1' });
      const out = nativeRows(sql);
      if ('error' in out) return json(res, 400, { message: out.error });
      seen.exports.push(datasetExport[1]!);
      const file = exported(datasetExport[1]!, out.rows);
      res.writeHead(200, { 'content-type': file.type, 'content-disposition': `attachment; filename="query_result.${datasetExport[1]}"` });
      res.end(file.body);
      return;
    }
    json(res, 404, { message: 'API endpoint does not exist.' });
  };

  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x');
      const path = url.pathname;
      try {
        if (path.startsWith('/api/')) return api(req, res, path, url, raw);
        if (path === '/auth/login') {
          if (signedIn(req)) {
            res.writeHead(302, { location: '/' });
            res.end();
            return;
          }
          res.writeHead(200, { 'content-type': 'text/html' });
          res.end(
            "<!doctype html><title>Metabase</title><p>Sign in with Google</p><script>const w = window.open('/auth/sso/popup', 'mb-sso'); window.addEventListener('message', (e) => { if (e.data === 'metabase-signed-in') location.href = '/'; });</script>",
          );
          return;
        }
        if (path === '/auth/sso/popup') {
          // The identity provider's popup: it signs in, tells its opener and closes, the way Google Identity Services does.
          const token = randomUUID();
          sessions.add(token);
          seen.logins++;
          res.writeHead(200, { 'content-type': 'text/html', 'Set-Cookie': `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=1209600` });
          res.end("<!doctype html><title>Sign in</title><script>window.opener.postMessage('metabase-signed-in', '*'); window.close();</script>");
          return;
        }
        if (path === '/') {
          res.writeHead(200, { 'content-type': 'text/html' });
          res.end('<!doctype html><title>Metabase</title><p>Home</p>');
          return;
        }
        json(res, 404, { message: 'Not found' });
      } catch (err) {
        json(res, 400, { message: `Bad request: ${(err as Error).message}` });
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    apiKey: API_KEY,
    seen,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
