import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  DbQueryResult,
  MetabaseCard,
  MetabaseCollection,
  MetabaseConnectionSummary,
  MetabaseDashboard,
  MetabaseDatabase,
  MetabaseExportResult,
  MetabaseHistoryEntry,
  MetabaseItem,
  MetabaseSession,
  MetabaseTable,
  MetabaseTestResult,
} from '@quiver/core';
import { definePart, until } from '../part';

/** Every file under a folder but the `skip` folders, as text, for checks that a secret is nowhere in it. */
async function readAll(dir: string, skip: string[] = []): Promise<string> {
  const entries = (await fs.readdir(dir, { withFileTypes: true }).catch(() => [])).filter((e) => !skip.includes(e.name));
  const parts = await Promise.all(entries.map((e) => (e.isDirectory() ? readAll(path.join(dir, e.name), skip) : fs.readFile(path.join(dir, e.name), 'utf8').catch(() => ''))));
  return parts.join('\n');
}

export default definePart({
  name: 'metabase',
  summary: 'Metabase: the fake sign-in and API keys, databases, collections, questions, dashboards, native SQL, the query-builder table browser (filters, order, pages), exports, history, agent gating, the tabs',
  async run(t) {
    const { host, check, run, ws, folder, hooksFolder, rpc, toolNames: names } = t;
    const { fakeMetabase } = t.fixtures;
    const fail = async (id: string, input: unknown, caller: 'ui' | 'mcp' = 'ui') => {
      const out = await host.invoke(id, input, { caller, workspaceId: ws.id });
      return out.ok ? 'ok' : `${out.error.code}: ${out.error.message}`;
    };
    /** An MCP tool call as an agent makes it: its text and whether it failed. */
    const tool = async (name: string, args: unknown) => {
      const out = await rpc('tools/call', { name, arguments: args });
      return { error: out.result?.isError === true, text: out.result?.content?.[0]?.text ?? JSON.stringify(out.error ?? null) };
    };
    const logins0 = fakeMetabase.seen.logins;
    const logouts0 = fakeMetabase.seen.logouts;

    // A browser connection: the address normalised, signed out until the fake identity provider signs it in.
    const browser = await run<MetabaseConnectionSummary>('metabase.connection.save', { connection: { name: '', url: `${fakeMetabase.url}/?from=smoke#home` } }, ws.id);
    const onDisk = JSON.parse(await fs.readFile(path.join(folder, '.quiver', 'metabase-connections', `${browser.id}.json`), 'utf8')) as { url: string; auth: string };
    check(
      'metabase: a new connection is committed under .quiver/metabase-connections with the address normalised',
      browser.url === fakeMetabase.url && onDisk.url === fakeMetabase.url && onDisk.auth === 'browser' && browser.auth === 'browser' && browser.hasApiKey === false && ['unknown', 'signed-out'].includes(browser.session.state),
      { url: browser.url, onDisk, name: browser.name, session: browser.session.state },
    );
    await run('metabase.connection.save', { connection: { id: browser.id, name: 'Smoke Metabase' } }, ws.id);
    const badUrl = await fail('metabase.connection.save', { connection: { id: browser.id, url: 'ftp://nowhere' } });
    const kept = await run<MetabaseConnectionSummary>('metabase.connection.get', { id: browser.id }, ws.id);
    check('metabase: a bad address is refused and the connection keeps its own', badUrl.startsWith('INVALID_INPUT') && kept.url === fakeMetabase.url && kept.name === 'Smoke Metabase', { badUrl, url: kept.url, name: kept.name });

    const signedOut = await run<MetabaseSession>('metabase.session', { connectionId: browser.id }, ws.id);
    const dbsOut = await host.invoke('metabase.databases', { connectionId: browser.id }, { caller: 'ui', workspaceId: ws.id });
    const dbsOutError = dbsOut.ok ? null : dbsOut.error;
    check(
      'metabase: before signing in the session is signed-out and Metabase calls ask for a sign-in at the address',
      signedOut.state === 'signed-out' &&
        dbsOutError?.code === 'SIGN_IN_REQUIRED' &&
        (dbsOutError.details as { metabaseUrl?: string; connectionId?: string } | undefined)?.metabaseUrl === fakeMetabase.url &&
        (dbsOutError.details as { connectionId?: string } | undefined)?.connectionId === browser.id,
      { signedOut, error: dbsOutError },
    );

    const signedIn = await run<MetabaseSession>('metabase.signin', { connectionId: browser.id }, ws.id);
    check(
      'metabase: sign-in opens the login page, follows the identity provider back and knows the user',
      signedIn.state === 'signed-in' && signedIn.user?.email === 'smoke@example.com' && signedIn.user.id === 1 && fakeMetabase.seen.logins === logins0 + 1,
      { signedIn, logins: fakeMetabase.seen.logins },
    );
    const again = await run<MetabaseSession>('metabase.signin', { connectionId: browser.id }, ws.id);
    check('metabase: signing in again with a live session opens no window', again.state === 'signed-in' && fakeMetabase.seen.logins === logins0 + 1, { again: again.state, logins: fakeMetabase.seen.logins });
    const tested = await run<MetabaseTestResult>('metabase.connection.test', { connectionId: browser.id }, ws.id);
    check('metabase: the connection test says who is signed in and the version', tested.user.email === 'smoke@example.com' && tested.version === 'v0.52.0', tested);

    // Browsing: databases, tables with their fields, the collection tree, its items and search.
    const dbs = await run<MetabaseDatabase[]>('metabase.databases', { connectionId: browser.id }, ws.id);
    check('metabase: databases are listed with their engine', JSON.stringify(dbs) === JSON.stringify([{ id: 1, name: 'Smoke DB', engine: 'postgres' }]), dbs);
    const tables = await run<MetabaseTable[]>('metabase.tables', { connectionId: browser.id, databaseId: 1 }, ws.id);
    const orders = tables.find((x) => x.name === 'orders');
    check(
      'metabase: tables come sorted with their fields and types',
      tables.map((x) => `${x.schema}.${x.name}`).join() === 'public.customers,public.events,public.orders' &&
        orders?.displayName === 'Orders' &&
        orders.fields.map((f) => `${f.name}:${f.baseType}:${f.databaseType}`).join() === 'id:type/Integer:int4,customer:type/Text:text,total:type/Float:numeric' &&
        orders.fields[1]?.displayName === 'Customer',
      tables.map((x) => [x.schema, x.name, x.fields.map((f) => f.name)]),
    );
    const tree = await run<MetabaseCollection>('metabase.collections', { connectionId: browser.id }, ws.id);
    check(
      'metabase: the collection tree starts at Our analytics',
      tree.id === 'root' && tree.name === 'Our analytics' && tree.children.length === 1 && tree.children[0]?.id === '5' && tree.children[0]?.name === 'Sales',
      tree,
    );
    const rootItems = await run<MetabaseItem[]>('metabase.collection.items', { connectionId: browser.id, collectionId: 'root' }, ws.id);
    const salesItems = await run<MetabaseItem[]>('metabase.collection.items', { connectionId: browser.id, collectionId: '5' }, ws.id);
    check(
      'metabase: collection items list the sub-collections, questions and dashboards in each',
      rootItems.map((i) => `${i.model}:${i.id}:${i.name}`).sort().join() === 'card:1:All orders,collection:5:Sales,dashboard:1:Overview' &&
        salesItems.length === 1 &&
        salesItems[0]?.model === 'card' &&
        salesItems[0]?.id === 2 &&
        salesItems[0]?.collectionId === '5' &&
        rootItems.find((i) => i.model === 'card')?.description === 'Every order',
      { rootItems, salesItems },
    );
    const found = await run<MetabaseItem[]>('metabase.search', { connectionId: browser.id, q: 'orders' }, ws.id);
    const foundDash = await run<MetabaseItem[]>('metabase.search', { connectionId: browser.id, q: 'OVER' }, ws.id);
    check(
      'metabase: search finds questions and dashboards by name, whatever the case',
      found.map((i) => `${i.model}:${i.id}`).sort().join() === 'card:1,card:2' && foundDash.map((i) => `${i.model}:${i.id}`).join() === 'dashboard:1',
      { found, foundDash },
    );

    // Saved questions and dashboards.
    const card = await run<MetabaseCard>('metabase.card.get', { connectionId: browser.id, cardId: 2 }, ws.id);
    check(
      'metabase: a question comes with its database, SQL, collection and parameters',
      card.name === 'Orders by customer' &&
        card.databaseId === 1 &&
        card.queryType === 'native' &&
        card.sql === 'SELECT * FROM orders WHERE customer = {{customer}}' &&
        card.collectionId === '5' &&
        card.display === 'table' &&
        card.parameters.length === 1 &&
        card.parameters[0]?.id === 'p1' &&
        card.parameters[0]?.slug === 'customer' &&
        card.parameters[0]?.type === 'string/=',
      card,
    );
    const missingCard = await fail('metabase.card.get', { connectionId: browser.id, cardId: 99 });
    check('metabase: a question that does not exist is not found', missingCard.startsWith('NOT_FOUND') || missingCard.startsWith('REQUEST_FAILED'), missingCard);
    const all = await run<DbQueryResult>('metabase.card.run', { connectionId: browser.id, cardId: 1 }, ws.id);
    check(
      'metabase: running a question answers rows with the columns as Metabase names them',
      all.kind === 'rows' &&
        all.columns.map((c) => `${c.name}:${c.type}`).join() === 'ID:type/Integer,Customer:type/Text,Total:type/Float' &&
        JSON.stringify(all.rows) === JSON.stringify([[1, 'Ada', 12.5], [2, 'Linus', 30], [3, 'Grace', 7.25]]) &&
        all.rowCount === 3 &&
        all.truncated === false,
      { columns: all.columns, rows: all.rows, rowCount: all.rowCount, truncated: all.truncated },
    );
    const byCustomer = await run<DbQueryResult>('metabase.card.run', { connectionId: browser.id, cardId: 2, parameters: [{ id: 'p1', value: 'Linus' }] }, ws.id);
    check('metabase: a question runs with a parameter value', byCustomer.rows.length === 1 && byCustomer.rows[0]?.[1] === 'Linus', byCustomer.rows);
    const dashboard = await run<MetabaseDashboard>('metabase.dashboard.get', { connectionId: browser.id, dashboardId: 1 }, ws.id);
    check(
      'metabase: a dashboard lists its questions in order and skips its text boxes',
      dashboard.name === 'Overview' && JSON.stringify(dashboard.cards) === JSON.stringify([{ id: 1, name: 'All orders' }, { id: 2, name: 'Orders by customer' }]),
      dashboard,
    );

    // Native SQL: rows, Metabase's own error, the 2000-row cap.
    const sql = await run<DbQueryResult>('metabase.query.run', { connectionId: browser.id, databaseId: 1, sql: 'SELECT * FROM orders' }, ws.id);
    check(
      'metabase: a native query runs on the database and answers rows',
      fakeMetabase.seen.sql.at(-1) === 'SELECT * FROM orders' && sql.rows.length === 3 && sql.columns[1]?.name === 'Customer' && sql.statement === 'SELECT * FROM orders',
      { sent: fakeMetabase.seen.sql.at(-1), rows: sql.rows.length, columns: sql.columns, statement: sql.statement },
    );
    const boom = await fail('metabase.query.run', { connectionId: browser.id, databaseId: 1, sql: 'SELECT * FROM boom' });
    check("metabase: a failed query comes back with Metabase's message", boom.startsWith('REQUEST_FAILED') && boom.includes('relation "boom" does not exist'), boom);
    const big = await run<DbQueryResult>('metabase.query.run', { connectionId: browser.id, databaseId: 1, sql: 'SELECT * FROM big' }, ws.id);
    check('metabase: a result Metabase cut at 2000 rows says so', big.rows.length === 2000 && big.truncated === true, { rows: big.rows.length, truncated: big.truncated });

    // Exports: text for CSV and JSON, a file for Excel, form-encoded the way Metabase takes them.
    const exports0 = fakeMetabase.seen.exports.length;
    const csv = await run<MetabaseExportResult>('metabase.export', { connectionId: browser.id, format: 'csv', databaseId: 1, sql: 'SELECT * FROM orders' }, ws.id);
    const json = await run<MetabaseExportResult>('metabase.export', { connectionId: browser.id, format: 'json', cardId: 2, parameters: [{ id: 'p1', value: 'Ada' }] }, ws.id);
    const xlsxPath = path.join(hooksFolder, 'metabase-orders.xlsx');
    const xlsx = await run<MetabaseExportResult>('metabase.export', { connectionId: browser.id, format: 'xlsx', cardId: 1, path: xlsxPath }, ws.id);
    const xlsxBytes = await fs.readFile(xlsxPath).catch(() => Buffer.alloc(0));
    const jsonRows = (() => {
      try {
        return JSON.parse(json.text ?? '') as Record<string, unknown>[];
      } catch {
        return null;
      }
    })();
    check(
      'metabase: exports answer CSV as text, a question with its parameter as JSON, and write Excel to a file',
      csv.format === 'csv' &&
        csv.path === null &&
        (csv.text ?? '').startsWith('ID,Customer,Total\n1,Ada,12.5') &&
        csv.bytes > 0 &&
        jsonRows?.length === 1 &&
        jsonRows[0]?.Customer === 'Ada' &&
        xlsx.path === xlsxPath &&
        xlsx.text === null &&
        xlsx.bytes === xlsxBytes.length &&
        xlsxBytes.length > 100 &&
        xlsxBytes.subarray(0, 2).toString() === 'PK' &&
        fakeMetabase.seen.exports.slice(exports0).join() === 'csv,json,xlsx',
      { csv: { ...csv, text: csv.text?.slice(0, 40) }, json: json.text?.slice(0, 80), xlsx, fileBytes: xlsxBytes.length, formats: fakeMetabase.seen.exports.slice(exports0) },
    );
    const xlsxNoPath = await fail('metabase.export', { connectionId: browser.id, format: 'xlsx', cardId: 1 });
    const both = await fail('metabase.export', { connectionId: browser.id, format: 'csv', cardId: 1, databaseId: 1, sql: 'SELECT 1' });
    const neither = await fail('metabase.export', { connectionId: browser.id, format: 'csv' });
    check('metabase: an export needs one source, and Excel needs a file', xlsxNoPath.startsWith('INVALID_INPUT') && both.startsWith('INVALID_INPUT') && neither.startsWith('INVALID_INPUT'), { xlsxNoPath, both, neither });

    // Tables through the query builder (MBQL): pages, order and filters, for users without native SQL. Orders has 7 rows here.
    {
      const rowsOf = (input: Record<string, unknown>) => run<DbQueryResult>('metabase.table.rows', { connectionId: browser.id, databaseId: 1, tableId: 11, ...input }, ws.id);
      const ids = (r: DbQueryResult) => r.rows.map((x) => x[0]).join();
      const lastQuery = () => fakeMetabase.seen.mbql.at(-1)?.query;
      const sql0 = fakeMetabase.seen.sql.length;
      const first = await rowsOf({});
      const firstQuery = lastQuery();
      check(
        'metabase: a table page runs through the query builder with the default limit and answers its rows',
        first.kind === 'rows' &&
          ids(first) === '1,2,3,4,5,6,7' &&
          JSON.stringify(first.rows[0]) === JSON.stringify([1, 'Ada', 12.5]) &&
          first.columns.map((c) => c.name).join() === 'ID,Customer,Total' &&
          /page 1$/.test(first.statement ?? '') &&
          fakeMetabase.seen.mbql.at(-1)?.type === 'query' &&
          fakeMetabase.seen.mbql.at(-1)?.database === 1 &&
          firstQuery?.['source-table'] === 11 &&
          firstQuery.limit === 100 &&
          firstQuery.page === undefined &&
          firstQuery.filter === undefined &&
          fakeMetabase.seen.sql.length === sql0,
        { ids: ids(first), columns: first.columns.map((c) => c.name), statement: first.statement, sent: fakeMetabase.seen.mbql.at(-1), nativeSent: fakeMetabase.seen.sql.slice(sql0) },
      );
      const customers = await rowsOf({ tableId: 12 });
      check('metabase: another table answers its own columns and rows', customers.columns.map((c) => c.name).join() === 'ID,Name' && JSON.stringify(customers.rows) === JSON.stringify([[1, 'Ada'], [2, 'Linus']]), { columns: customers.columns, rows: customers.rows });
      const page2 = await rowsOf({ limit: 2, page: 2 });
      const page2Query = lastQuery();
      check(
        'metabase: limit 2, page 2 gives rows 3 and 4, sent as page.items',
        ids(page2) === '3,4' && /page 2$/.test(page2.statement ?? '') && JSON.stringify(page2Query?.page) === JSON.stringify({ page: 2, items: 2 }) && page2Query?.limit === 2,
        { ids: ids(page2), statement: page2.statement, sent: page2Query },
      );
      const desc = await rowsOf({ orderBy: { fieldId: 103, direction: 'desc' } });
      check(
        'metabase: a table sorts descending on a field, sent as order-by',
        ids(desc) === '5,2,7,1,6,3,4' && JSON.stringify(lastQuery()?.['order-by']) === JSON.stringify([['desc', ['field', 103, null]]]),
        { ids: ids(desc), sent: lastQuery()?.['order-by'] },
      );
      const equal = await rowsOf({ filters: [{ fieldId: 102, op: '=', value: 'Linus' }] });
      const equalFilter = lastQuery()?.filter;
      const contains = await rowsOf({ filters: [{ fieldId: 102, op: 'contains', value: 'A' }] });
      const greater = await rowsOf({ filters: [{ fieldId: 103, op: '>', value: 20 }] });
      const greaterFilter = lastQuery()?.filter;
      const isNull = await rowsOf({ filters: [{ fieldId: 102, op: 'is-null' }] });
      const isNullFilter = lastQuery()?.filter;
      const both = await rowsOf({ filters: [{ fieldId: 102, op: 'contains', value: 'a' }, { fieldId: 103, op: '>', value: 20 }] });
      const bothFilter = lastQuery()?.filter;
      check(
        'metabase: table filters =, contains, > and is-null narrow the rows, and two filters are ANDed',
        ids(equal) === '2' &&
          JSON.stringify(equalFilter) === JSON.stringify(['=', ['field', 102, null], 'Linus']) &&
          ids(contains) === '1,3,4,5,7' &&
          ids(greater) === '2,5,7' &&
          JSON.stringify(greaterFilter) === JSON.stringify(['>', ['field', 103, null], 20]) &&
          isNull.rows.length === 0 &&
          JSON.stringify(isNullFilter) === JSON.stringify(['is-null', ['field', 102, null]]) &&
          ids(both) === '5,7' &&
          Array.isArray(bothFilter) &&
          bothFilter[0] === 'and' &&
          bothFilter.length === 3,
        { equal: ids(equal), equalFilter, contains: ids(contains), greater: ids(greater), greaterFilter, isNull: isNull.rows.length, isNullFilter, both: ids(both), bothFilter },
      );
      const missing = await fail('metabase.table.rows', { connectionId: browser.id, databaseId: 1, tableId: 99 });
      check("metabase: a table that does not exist comes back with Metabase's message", missing.startsWith('REQUEST_FAILED') && missing.includes('Table 99 does not exist'), missing);
      const tableExports0 = fakeMetabase.seen.exports.length;
      const tableCsv = await run<MetabaseExportResult>('metabase.export', { connectionId: browser.id, format: 'csv', databaseId: 1, tableId: 11, filters: [{ fieldId: 103, op: '>', value: 20 }] }, ws.id);
      const exportQuery = lastQuery();
      check(
        'metabase: a table exports every row through its filters as CSV text',
        tableCsv.format === 'csv' &&
          tableCsv.path === null &&
          tableCsv.text === 'ID,Customer,Total\n2,Linus,30\n5,Alan,50\n7,Barbara,22\n' &&
          fakeMetabase.seen.exports.slice(tableExports0).join() === 'csv' &&
          exportQuery?.['source-table'] === 11 &&
          (exportQuery.limit ?? 0) >= 1_000_000 &&
          exportQuery.page === undefined &&
          JSON.stringify(exportQuery.filter) === JSON.stringify(['>', ['field', 103, null], 20]),
        { text: tableCsv.text, formats: fakeMetabase.seen.exports.slice(tableExports0), sent: exportQuery },
      );
      const agentRows = await tool('metabase_table_rows', { connectionId: browser.id, databaseId: 1, tableId: 11, filters: [{ fieldId: 102, op: '=', value: 'Barbara' }] });
      check(
        'metabase: agents see metabase_table_rows and may read a table with it',
        names.includes('metabase_table_rows') && !agentRows.error && agentRows.text.includes('Barbara') && !agentRows.text.includes('Linus'),
        { listed: names.includes('metabase_table_rows'), agentRows: agentRows.text.slice(0, 200) },
      );
    }

    const history = await run<MetabaseHistoryEntry[]>('metabase.history.list', { connectionId: browser.id }, ws.id);
    check(
      'metabase: the history keeps each native query newest first, with its rows or its error',
      history.length === 3 &&
        history[0]?.sql === 'SELECT * FROM big' &&
        history[0]?.rowCount === 2000 &&
        history[1]?.sql === 'SELECT * FROM boom' &&
        (history[1]?.error ?? '').includes('relation "boom" does not exist') &&
        history[2]?.sql === 'SELECT * FROM orders' &&
        history[2]?.rowCount === 3 &&
        history.every((h) => h.connectionId === browser.id && h.databaseId === 1),
      history.map((h) => [h.sql, h.rowCount, h.error]),
    );

    // An API-key connection: nothing works before a key, a refused key says so, the key is never handed back.
    const keyed = await run<MetabaseConnectionSummary>('metabase.connection.save', { connection: { name: 'Smoke key', url: fakeMetabase.url, auth: 'apikey' } }, ws.id);
    const noKey = await fail('metabase.databases', { connectionId: keyed.id });
    const noKeySession = await run<MetabaseSession>('metabase.session', { connectionId: keyed.id }, ws.id);
    const keySignIn = await fail('metabase.signin', { connectionId: keyed.id });
    check(
      'metabase: an API-key connection without a key asks for one and cannot sign in in a window',
      noKey.startsWith('AUTH_REQUIRED') && noKeySession.state === 'signed-out' && keyed.hasApiKey === false && keySignIn.startsWith('INVALID_INPUT'),
      { noKey, session: noKeySession, hasApiKey: keyed.hasApiKey, keySignIn },
    );
    await run('metabase.apikey.set', { connectionId: keyed.id, apiKey: 'mb-wrong-key' }, ws.id);
    const refused = await fail('metabase.connection.test', { connectionId: keyed.id });
    const refusedSession = await run<MetabaseSession>('metabase.session', { connectionId: keyed.id }, ws.id);
    check('metabase: a key Metabase refuses fails the test and leaves the session signed out', refused.startsWith('AUTH_FAILED') && refusedSession.state === 'signed-out' && Boolean(refusedSession.error), { refused, refusedSession });
    const keyCalls0 = fakeMetabase.seen.apiKeyCalls;
    const withKey = await run<MetabaseConnectionSummary>('metabase.apikey.set', { connectionId: keyed.id, apiKey: fakeMetabase.apiKey }, ws.id);
    const keyTest = await run<MetabaseTestResult>('metabase.connection.test', { connectionId: keyed.id }, ws.id);
    const keySession = await run<MetabaseSession>('metabase.session', { connectionId: keyed.id }, ws.id);
    const keyDbs = await run<MetabaseDatabase[]>('metabase.databases', { connectionId: keyed.id }, ws.id);
    const listed = await run<MetabaseConnectionSummary[]>('metabase.connection.list', {}, ws.id);
    // The committed files only: on a machine without a keychain the per-machine store keeps secrets readable.
    const quiverFiles = await readAll(path.join(folder, '.quiver'), ['local']);
    check(
      'metabase: with the key stored the connection works, and the key is in no answer and in no committed file',
      withKey.hasApiKey === true &&
        keyTest.user.email === 'smoke@example.com' &&
        keyTest.version === 'v0.52.0' &&
        keySession.state === 'signed-in' &&
        keyDbs.length === 1 &&
        fakeMetabase.seen.apiKeyCalls > keyCalls0 &&
        !JSON.stringify(withKey).includes(fakeMetabase.apiKey) &&
        !JSON.stringify(listed).includes(fakeMetabase.apiKey) &&
        !quiverFiles.includes(fakeMetabase.apiKey) &&
        listed.map((c) => c.name).join() === 'Smoke key,Smoke Metabase',
      { hasApiKey: withKey.hasApiKey, keyTest, keySession: keySession.state, apiKeyCalls: fakeMetabase.seen.apiKeyCalls - keyCalls0, listed: listed.map((c) => c.name) },
    );
    const cleared = await run<MetabaseConnectionSummary>('metabase.apikey.clear', { connectionId: keyed.id }, ws.id);
    const afterClear = await fail('metabase.databases', { connectionId: keyed.id });
    check('metabase: clearing the key forgets it on this machine', cleared.hasApiKey === false && afterClear.startsWith('AUTH_REQUIRED'), { hasApiKey: cleared.hasApiKey, afterClear });
    // Kept with a key for the connection tab's screenshot in API-key mode.
    await run('metabase.apikey.set', { connectionId: keyed.id, apiKey: fakeMetabase.apiKey }, ws.id);

    // Agents over MCP: reads and read-only SQL pass, writes and anything that changes state are refused.
    {
      const scratch = await run<MetabaseConnectionSummary>('metabase.connection.save', { connection: { name: 'Scratch', url: fakeMetabase.url, auth: 'apikey' } }, ws.id);
      await run('metabase.apikey.set', { connectionId: scratch.id, apiKey: fakeMetabase.apiKey }, ws.id);
      const sql0 = fakeMetabase.seen.sql.length;
      const read = await tool('metabase_query_run', { connectionId: browser.id, databaseId: 1, sql: 'SELECT * FROM orders' });
      const write = await tool('metabase_query_run', { connectionId: browser.id, databaseId: 1, sql: "INSERT INTO orders VALUES (4, 'Eve', 1)" });
      const runCard = await tool('metabase_card_run', { connectionId: browser.id, cardId: 1 });
      const exportText = await tool('metabase_export', { connectionId: browser.id, format: 'csv', cardId: 1 });
      const exportFile = await tool('metabase_export', { connectionId: browser.id, format: 'csv', cardId: 1, path: path.join(hooksFolder, 'agent.csv') });
      const setKey = await tool('metabase_apikey_set', { connectionId: scratch.id, apiKey: 'mb-agent-key' });
      const clearKey = await tool('metabase_apikey_clear', { connectionId: scratch.id });
      const signOut = await tool('metabase_signout', { connectionId: browser.id });
      const del = await tool('metabase_connection_delete', { id: scratch.id });
      const clearHistory = await tool('metabase_history_clear', {});
      const getKeyed = await tool('metabase_connection_get', { id: scratch.id });
      const blocked = (r: { error: boolean; text: string }) => r.error && r.text.includes('MUTATION_BLOCKED');
      check(
        'metabase: agents see the tools but not sign-in',
        names.includes('metabase_query_run') && names.includes('metabase_card_run') && names.includes('metabase_connection_list') && !names.includes('metabase_signin'),
        names.filter((n) => n.startsWith('metabase_')),
      );
      check(
        'metabase: agents may run read-only SQL, questions and text exports, but an INSERT never reaches Metabase',
        !read.error &&
          read.text.includes('Linus') &&
          blocked(write) &&
          !fakeMetabase.seen.sql.slice(sql0).some((s) => s.startsWith('INSERT')) &&
          !runCard.error &&
          !exportText.error &&
          exportText.text.includes('ID,Customer,Total') &&
          blocked(exportFile),
        { read: read.text.slice(0, 120), write, runCard: runCard.error, exportText: exportText.text.slice(0, 80), exportFile },
      );
      check(
        'metabase: agents may not set or clear keys, sign out, delete or clear the history',
        blocked(setKey) && blocked(clearKey) && blocked(signOut) && blocked(del) && blocked(clearHistory),
        { setKey, clearKey, signOut, del, clearHistory },
      );
      check(
        'metabase: what an agent reads of a connection holds no key',
        !getKeyed.error && (JSON.parse(getKeyed.text) as { hasApiKey?: boolean }).hasApiKey === true && !getKeyed.text.includes(fakeMetabase.apiKey),
        getKeyed.text.slice(0, 300),
      );
      // The stored key stays with its address: moving the connection elsewhere is gated, a rename is not.
      const move = await tool('metabase_connection_save', { connection: { id: scratch.id, url: 'http://127.0.0.1:9' } });
      const rename = await tool('metabase_connection_save', { connection: { id: scratch.id, name: 'Scratch renamed' } });
      const sameUrl = await tool('metabase_connection_save', { connection: { id: scratch.id, url: fakeMetabase.url } });
      const afterMove = await run<MetabaseConnectionSummary>('metabase.connection.get', { id: scratch.id }, ws.id);
      check(
        'metabase: an agent may not move a connection with a stored key to another address, but may rename it',
        blocked(move) && !rename.error && !sameUrl.error && afterMove.url === scratch.url && afterMove.name === 'Scratch renamed',
        { move, rename: rename.error, sameUrl: sameUrl.error, url: afterMove.url },
      );
      const stillSignedIn = await run<MetabaseSession>('metabase.session', { connectionId: browser.id }, ws.id);
      check('metabase: the blocked sign-out left the session alone', stillSignedIn.state === 'signed-in' && fakeMetabase.seen.logouts === logouts0, { state: stillSignedIn.state, logouts: fakeMetabase.seen.logouts });

      // Deleting a connection forgets its key too.
      await run('metabase.connection.delete', { id: scratch.id }, ws.id);
      const gone = await fail('metabase.connection.get', { id: scratch.id });
      const fileGone = await fs
        .access(path.join(folder, '.quiver', 'metabase-connections', `${scratch.id}.json`))
        .then(() => false)
        .catch(() => true);
      const localAfter = await readAll(path.join(folder, '.quiver', 'local'));
      check('metabase: deleting a connection removes its file and its key', gone.startsWith('NOT_FOUND') && fileGone && !localAfter.includes(scratch.id), { gone, fileGone, keyLeft: localAfter.includes(scratch.id) });
    }

    const clearedHistory = await run<{ cleared: number }>('metabase.history.clear', {}, ws.id);
    const emptyHistory = await run<MetabaseHistoryEntry[]>('metabase.history.list', {}, ws.id);
    check('metabase: the history clears', clearedHistory.cleared >= 3 && emptyHistory.length === 0, { clearedHistory, left: emptyHistory.length });

    const signedOff = await run<MetabaseSession>('metabase.signout', { connectionId: browser.id }, ws.id);
    const afterSignOut = await fail('metabase.databases', { connectionId: browser.id });
    const listedOut = (await run<MetabaseConnectionSummary[]>('metabase.connection.list', {}, ws.id)).find((c) => c.id === browser.id);
    check(
      'metabase: signing out ends the session on Metabase and on this machine',
      signedOff.state === 'signed-out' && fakeMetabase.seen.logouts === logouts0 + 1 && afterSignOut.startsWith('SIGN_IN_REQUIRED') && listedOut?.session.state === 'signed-out',
      { signedOff: signedOff.state, logouts: fakeMetabase.seen.logouts, afterSignOut, listed: listedOut?.session.state },
    );
    const back = await run<MetabaseSession>('metabase.signin', { connectionId: browser.id }, ws.id);
    check('metabase: signing in after signing out goes through the login page again', back.state === 'signed-in' && fakeMetabase.seen.logins === logins0 + 2, { back: back.state, logins: fakeMetabase.seen.logins });

    return {
      ui: async (u) => {
        const { js, wait, shot } = u;
        const visible = `(s) => [...document.querySelectorAll(s)].find((e) => e.offsetParent !== null)`;
        const v = (selector: string) => `(${visible})(${JSON.stringify(selector)})`;
        const setValue = (selector: string, value: string) =>
          js(
            `(() => { const el = ${v(selector)}; if (!el) return false; const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`,
          );
        const click = (selector: string) => js(`(() => { const el = ${v(selector)}; if (el) el.click(); return Boolean(el); })()`);
        const text = async (selector: string) => String((await js(`${v(selector)}?.textContent.trim() ?? ''`)) ?? '');
        const treeItem = (name: string) => `[...document.querySelectorAll('[data-testid=mb-tree-item]')].find((e) => e.offsetParent !== null && e.textContent.trim().includes(${JSON.stringify(name)}))`;
        const row = (name: string) => `[...document.querySelectorAll('[data-testid=mb-connection-row]')].find((e) => e.textContent.includes(${JSON.stringify(name)}))`;
        const pane = (type: string) => `[...document.querySelectorAll('[data-tab-type="${type}"]')].find((el) => el.offsetParent !== null && !el.classList.contains('hidden'))`;

        // The host checks end signed in; the sidebar shows both connections and the browser one's tree.
        await js(`document.querySelector('[data-testid=activity-item][data-drag-id=metabase]')?.click()`);
        await until(async () => Boolean(await js(`Boolean(${v('[data-testid=mb-sidebar]')})`)), 4000);
        const rows = (await js(`[...document.querySelectorAll('[data-testid=mb-connection-row]')].map((r) => [r.textContent.trim(), Boolean(r.querySelector('[data-testid=mb-session-dot]'))])`)) as [string, boolean][];
        check(
          'ui: metabase: the sidebar lists the connections with a session dot',
          Array.isArray(rows) && rows.length === 2 && rows.some((r) => r[0].includes('Smoke Metabase')) && rows.some((r) => r[0].includes('Smoke key')) && rows.every((r) => r[1]),
          rows,
        );
        await js(`${row('Smoke Metabase')}?.click()`);
        await until(async () => Boolean(await js(`Boolean(${v('[data-testid=mb-tree-collections]')})`)), 4000);
        // Collections start open and load on their own; Databases start closed.
        if (!(await until(async () => Boolean(await js(`Boolean(${treeItem('All orders')})`)), 4000))) await click('[data-testid=mb-tree-collections]');
        if (!(await js(`Boolean(${v('[data-testid=mb-tree-database]')})`))) await click('[data-testid=mb-tree-databases]');
        await until(async () => Boolean(await js(`Boolean(${treeItem('All orders')}) && Boolean(${v('[data-testid=mb-tree-database]')})`)), 6000);
        const treeNames = (await js(`[...document.querySelectorAll('[data-testid=mb-tree-item], [data-testid=mb-tree-database]')].filter((e) => e.offsetParent !== null).map((e) => e.textContent.trim())`)) as string[];
        check(
          'ui: metabase: the tree shows the collections with their questions and dashboards, and the databases',
          Array.isArray(treeNames) && ['Sales', 'All orders', 'Overview', 'Smoke DB'].every((n) => treeNames.some((x) => x.includes(n))),
          treeNames,
        );
        await shot('29a-metabase-sidebar-light');

        // A question tab runs on open and shows its rows.
        await js(`${treeItem('All orders')}?.click()`);
        await until(async () => /\b3\b/.test(await text('[data-testid=mb-rowcount]')), 6000);
        const questionCells = (await js(`[...(${pane('metabase.question')}?.querySelectorAll('[data-testid=mb-result] [role=gridcell]') ?? [])].map((c) => c.textContent.trim())`)) as string[];
        check(
          'ui: metabase: a question tab runs on open and shows its rows',
          /\b3\b/.test(await text('[data-testid=mb-rowcount]')) && Array.isArray(questionCells) && ['Ada', 'Linus', 'Grace'].every((n) => questionCells.includes(n)),
          { rowcount: await text('[data-testid=mb-rowcount]'), cells: questionCells.slice(0, 12) },
        );
        await shot('29b-metabase-question-light');

        // A question with a parameter: its input, then a run with a value.
        if (!(await js(`Boolean(${treeItem('Orders by customer')})`))) await js(`${treeItem('Sales')}?.click()`);
        await until(async () => Boolean(await js(`Boolean(${treeItem('Orders by customer')})`)), 4000);
        await js(`${treeItem('Orders by customer')}?.click()`);
        await until(async () => Boolean(await js(`Boolean(${v('[data-testid=mb-param-customer]')})`)), 6000);
        await setValue('[data-testid=mb-param-customer]', 'Linus');
        await wait(200);
        await click('[data-testid=mb-run]');
        await until(async () => /^\D*1\b/.test(await text('[data-testid=mb-rowcount]')), 6000);
        const paramCells = (await js(`[...(${pane('metabase.question')}?.querySelectorAll('[data-testid=mb-result] [role=gridcell]') ?? [])].map((c) => c.textContent.trim())`)) as string[];
        check(
          'ui: metabase: a question with a parameter runs with the value typed',
          /^\D*1\b/.test(await text('[data-testid=mb-rowcount]')) && Array.isArray(paramCells) && paramCells.includes('Linus') && !paramCells.includes('Ada'),
          { rowcount: await text('[data-testid=mb-rowcount]'), cells: paramCells },
        );
        await js(`document.documentElement.classList.add('dark')`);
        await wait(300);
        await shot('29c-metabase-question-parameter-dark');
        await js(`document.documentElement.classList.remove('dark')`);

        // The query tab: a database, SQL, a result and the export menu.
        await js(`(() => { const r = ${row('Smoke Metabase')}; const b = r?.querySelector('[data-testid=mb-new-query]') ?? r?.parentElement?.querySelector('[data-testid=mb-new-query]'); if (b) b.click(); return Boolean(b); })()`);
        await until(async () => Boolean(await js(`Boolean(${v('[data-testid=mb-query-editor]')})`)), 6000);
        await until(async () => (await js(`${v('[data-testid=mb-database]')}?.options.length ?? 0`)) as number >= 1, 4000);
        if ((await js(`${v('[data-testid=mb-database]')}?.value`)) !== '1') await setValue('[data-testid=mb-database]', '1');
        const typed = await js(
          `(() => { const c = ${v('[data-testid=mb-query-editor] .cm-content')}; if (!c) return false; c.focus(); document.execCommand('selectAll'); return document.execCommand('insertText', false, 'SELECT * FROM orders'); })()`,
        );
        await wait(200);
        // Close the completion popup the typing opened, so the result shows cleanly.
        await js(`(() => { const c = ${v('[data-testid=mb-query-editor] .cm-content')}; c?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true })); c?.blur(); })()`);
        await wait(100);
        const sql0 = fakeMetabase.seen.sql.length;
        await click('[data-testid=mb-run]');
        await until(async () => /\b3\b/.test(await text('[data-testid=mb-rowcount]')), 6000);
        check(
          'ui: metabase: the query tab runs the SQL typed on the database picked',
          typed === true && fakeMetabase.seen.sql.slice(sql0).includes('SELECT * FROM orders') && /\b3\b/.test(await text('[data-testid=mb-rowcount]')),
          { typed, sent: fakeMetabase.seen.sql.slice(sql0), rowcount: await text('[data-testid=mb-rowcount]') },
        );
        await click('[data-testid=mb-export]');
        await wait(300);
        const exportItems = (await js(`[...document.querySelectorAll('[data-testid^=mb-export-]')].filter((e) => e.offsetParent !== null).map((e) => e.getAttribute('data-testid'))`)) as string[];
        check(
          'ui: metabase: the export menu copies rows and saves all of them',
          Array.isArray(exportItems) && ['mb-export-copy-csv', 'mb-export-copy-json', 'mb-export-save-csv', 'mb-export-save-json', 'mb-export-save-xlsx'].every((id) => exportItems.includes(id)),
          exportItems,
        );
        await shot('29d-metabase-query-export-light');
        await js(`document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
        await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
        await wait(200);

        // Signed out, a run shows the error box with its Sign in button, which signs in again.
        await run('metabase.signout', { connectionId: browser.id }, ws.id);
        await wait(300);
        await click('[data-testid=mb-run]');
        await until(async () => Boolean(await js(`Boolean(${v('[data-testid=mb-error-signin]')})`)), 6000);
        const errorText = await text('[data-testid=mb-error]');
        check('ui: metabase: a run while signed out offers to sign in', Boolean(await js(`Boolean(${v('[data-testid=mb-error-signin]')})`)) && errorText.length > 0, errorText);
        await js(`document.documentElement.classList.add('dark')`);
        await wait(300);
        await shot('29e-metabase-signin-error-dark');
        await js(`document.documentElement.classList.remove('dark')`);
        const logins1 = fakeMetabase.seen.logins;
        await click('[data-testid=mb-error-signin]');
        await until(async () => fakeMetabase.seen.logins > logins1 && !(await js(`Boolean(${v('[data-testid=mb-error]')})`)), 8000);
        check('ui: metabase: the Sign in button signs in again', fakeMetabase.seen.logins > logins1, { logins: fakeMetabase.seen.logins - logins1 });

        // The table tab: a table from the tree opens it through the query builder, with filters, sorting and pages.
        const tableItem = (name: string) =>
          `[...document.querySelectorAll('[data-testid=mb-tree-item][data-model=table]')].find((e) => e.offsetParent !== null && e.textContent.trim().startsWith(${JSON.stringify(name)}))`;
        const inTable = (selector: string) => `${pane('metabase.table')}?.querySelector(${JSON.stringify(selector)})`;
        const tableText = async (selector: string) => String((await js(`${inTable(selector)}?.textContent.trim() ?? ''`)) ?? '');
        /** The rows loaded once the table is not loading, or -1. */
        const loadedRows = async () => Number(await js(`(() => { const r = ${inTable('[data-testid=mb-table-result]')}; return r && !r.hasAttribute('data-loading') ? Number(r.getAttribute('data-rows')) : -1; })()`));
        const tableCells = async () => (await js(`[...(${inTable('[data-testid=mb-table-result]')}?.querySelectorAll('[role=gridcell]') ?? [])].map((c) => c.textContent.trim())`)) as string[];
        const pick = (selector: string, label: string) =>
          js(
            `(() => { const el = ${inTable(selector)}; const o = el && [...el.options].find((x) => x.textContent.trim() === ${JSON.stringify(label)}); if (!o) return false; el.value = o.value; el.dispatchEvent(new Event('change', { bubbles: true })); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`,
          );
        const clickIn = (selector: string) => js(`(() => { const el = ${inTable(selector)}; if (el && !el.disabled) el.click(); return Boolean(el) && !el.disabled; })()`);
        const disabled = async (selector: string) => Boolean(await js(`Boolean(${inTable(selector)}?.disabled)`));
        const openTable = async (name: string) => {
          if (!(await js(`Boolean(${tableItem(name)})`))) await js(`${v('[data-testid=mb-tree-database]')}?.click()`);
          await until(async () => Boolean(await js(`Boolean(${tableItem(name)})`)), 6000);
          await js(`${tableItem(name)}?.click()`);
          await until(async () => (await tableText('[data-testid=mb-table-name]')).includes(name) && (await loadedRows()) >= 0, 6000);
        };
        const mbql0 = fakeMetabase.seen.mbql.length;
        await openTable('orders');
        const openedCells = await tableCells();
        const openedCount = await tableText('[data-testid=mb-rowcount]');
        check(
          'ui: metabase: a table from the tree opens its tab with the rows and the row count, through the query builder',
          (await loadedRows()) === 7 &&
            /rows 1\s*[–-]\s*7\b/.test(openedCount) &&
            ['Ada', 'Barbara'].every((n) => openedCells.includes(n)) &&
            fakeMetabase.seen.mbql.slice(mbql0).some((b) => b.query?.['source-table'] === 11) &&
            (await disabled('[data-testid=mb-page-next]')) &&
            (await disabled('[data-testid=mb-page-prev]')),
          { rows: await loadedRows(), rowcount: openedCount, cells: openedCells.slice(0, 12), sent: fakeMetabase.seen.mbql.slice(mbql0).map((b) => b.query) },
        );

        // A header click sorts through the query builder.
        await js(`[...(${pane('metabase.table')}?.querySelectorAll('[role=columnheader]') ?? [])].find((h) => h.textContent.trim() === 'Total')?.click()`);
        await until(async () => JSON.stringify(fakeMetabase.seen.mbql.at(-1)?.query?.['order-by']) === JSON.stringify([['asc', ['field', 103, null]]]) && (await loadedRows()) === 7, 6000);
        await wait(200);
        const sortedCells = await tableCells();
        check(
          'ui: metabase: a header click sorts the table, sent as order-by',
          JSON.stringify(fakeMetabase.seen.mbql.at(-1)?.query?.['order-by']) === JSON.stringify([['asc', ['field', 103, null]]]) && sortedCells[0] === '4' && sortedCells[1] === 'Marie',
          { sent: fakeMetabase.seen.mbql.at(-1)?.query, cells: sortedCells.slice(0, 6) },
        );

        // A filter from the bar narrows the rows and shows as a chip.
        const pickedField = await pick('[data-testid=mb-filter-field]', 'Customer');
        await wait(100);
        const pickedOp = await pick('[data-testid=mb-filter-op]', 'contains');
        await wait(100);
        const typedValue = await js(
          `(() => { const el = ${inTable('[data-testid=mb-filter-value]')}; if (!el) return false; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, 'ar'); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`,
        );
        await wait(100);
        await clickIn('[data-testid=mb-filter-add]');
        await until(async () => (await loadedRows()) === 2, 6000);
        await wait(200);
        const filteredCells = await tableCells();
        const chips = (await js(`[...(${pane('metabase.table')}?.querySelectorAll('[data-testid=mb-filter-chip]') ?? [])].map((c) => c.textContent.trim())`)) as string[];
        const filterSent = fakeMetabase.seen.mbql.at(-1)?.query;
        check(
          'ui: metabase: a filter from the bar narrows the rows and shows as a chip',
          pickedField === true &&
            pickedOp === true &&
            typedValue === true &&
            (await loadedRows()) === 2 &&
            /rows 1\s*[–-]\s*2\b/.test(await tableText('[data-testid=mb-rowcount]')) &&
            filteredCells.includes('Marie') &&
            filteredCells.includes('Barbara') &&
            !filteredCells.includes('Ada') &&
            chips.length === 1 &&
            /Customer.*contains.*ar/.test(chips[0] ?? '') &&
            JSON.stringify(filterSent?.filter) === JSON.stringify(['contains', ['field', 102, null], 'ar']) &&
            JSON.stringify(filterSent?.['order-by']) === JSON.stringify([['asc', ['field', 103, null]]]),
          { pickedField, pickedOp, typedValue, rows: await loadedRows(), cells: filteredCells, chips, sent: filterSent },
        );
        // The sign-in toast from the earlier check would cover the footer.
        await js(`document.querySelectorAll('button[aria-label=Dismiss]').forEach((b) => b.click())`);
        await wait(200);
        await shot('29h-metabase-table-light');
        await clickIn('[data-testid=mb-filter-chip-remove]');
        await until(async () => (await loadedRows()) === 7, 6000);
        check(
          'ui: metabase: removing the chip brings the rows back',
          (await loadedRows()) === 7 && !(await js(`Boolean(${inTable('[data-testid=mb-filter-chip]')})`)) && fakeMetabase.seen.mbql.at(-1)?.query?.filter === undefined,
          { rows: await loadedRows(), sent: fakeMetabase.seen.mbql.at(-1)?.query },
        );

        // Pages: 120 events at 100 a page, then at 50.
        await openTable('events');
        await until(async () => (await loadedRows()) === 100, 6000);
        const nextEnabled = !(await disabled('[data-testid=mb-page-next]'));
        await clickIn('[data-testid=mb-page-next]');
        await until(async () => (await loadedRows()) === 20, 6000);
        const page2Count = await tableText('[data-testid=mb-rowcount]');
        const page2Sent = fakeMetabase.seen.mbql.at(-1)?.query;
        const page2NextDisabled = await disabled('[data-testid=mb-page-next]');
        await clickIn('[data-testid=mb-page-prev]');
        await until(async () => (await loadedRows()) === 100, 6000);
        const backCount = await tableText('[data-testid=mb-rowcount]');
        await pick('[data-testid=mb-page-size]', '50');
        await until(async () => (await loadedRows()) === 50, 6000);
        const size50Count = await tableText('[data-testid=mb-rowcount]');
        const size50Sent = fakeMetabase.seen.mbql.at(-1)?.query;
        check(
          'ui: metabase: Next and Prev move between pages, the last page disables Next, and the page size changes the limit',
          nextEnabled &&
            /rows 101\s*[–-]\s*120\b/.test(page2Count) &&
            JSON.stringify(page2Sent?.page) === JSON.stringify({ page: 2, items: 100 }) &&
            page2Sent?.['source-table'] === 13 &&
            page2NextDisabled &&
            /rows 1\s*[–-]\s*100\b/.test(backCount) &&
            /rows 1\s*[–-]\s*50\b/.test(size50Count) &&
            size50Sent?.limit === 50 &&
            size50Sent.page === undefined,
          { nextEnabled, page2Count, page2Sent, page2NextDisabled, backCount, size50Count, size50Sent },
        );

        // The connection tab, in both auth modes.
        const openConnection = async (name: string) => {
          await js(`${row(name)}?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 120, clientY: 200 }))`);
          await wait(300);
          await js(`[...document.querySelectorAll('[role^=menuitem]')].find((b) => /^(Edit|Settings|Connection)/.test(b.textContent.trim()))?.click()`);
          await until(async () => Boolean(await js(`Boolean(${v('[data-testid=mb-auth-mode]')})`)), 4000);
          await wait(300);
        };
        await openConnection('Smoke Metabase');
        await until(async () => (await text('[data-testid=mb-session]')).includes('Smoke User'), 4000);
        const browserTab = await js(
          `({ name: ${v('[data-testid=mb-name]')}?.value ?? null, url: ${v('[data-testid=mb-url]')}?.value ?? null, session: ${v('[data-testid=mb-session]')}?.textContent.trim() ?? null, signout: Boolean(${v('[data-testid=mb-signout]')}), apikey: Boolean(${v('[data-testid=mb-apikey]')}) })`,
        );
        await click('[data-testid=mb-test]');
        await until(async () => (await text('[data-testid=mb-test-result]')).includes('v0.52.0'), 4000);
        const browserTest = await text('[data-testid=mb-test-result]');
        check(
          'ui: metabase: the connection tab in browser mode shows the address, who is signed in and the test result',
          JSON.stringify(browserTab) === JSON.stringify({ name: 'Smoke Metabase', url: fakeMetabase.url, session: (browserTab as { session: string }).session, signout: true, apikey: false }) &&
            String((browserTab as { session: string }).session).includes('Smoke User') &&
            browserTest.includes('Smoke User') &&
            browserTest.includes('v0.52.0'),
          { browserTab, browserTest },
        );
        await shot('29f-metabase-connection-browser-light');
        await openConnection('Smoke key');
        await until(async () => (await text('[data-testid=mb-apikey-state]')).length > 0, 4000);
        const keyTab = await js(
          `({ state: ${v('[data-testid=mb-apikey-state]')}?.textContent.trim() ?? null, apikey: Boolean(${v('[data-testid=mb-apikey]')}), value: ${v('[data-testid=mb-apikey]')}?.value ?? null, signin: Boolean(${v('[data-testid=mb-signin]')}) })`,
        );
        check(
          'ui: metabase: the connection tab in API-key mode says a key is stored and never shows it',
          JSON.stringify(keyTab) === JSON.stringify({ state: 'Key stored on this machine', apikey: true, value: '', signin: false }),
          keyTab,
        );
        await js(`document.documentElement.classList.add('dark')`);
        await wait(300);
        await shot('29g-metabase-connection-apikey-dark');
        await js(`document.documentElement.classList.remove('dark')`);
        await wait(200);
        await js(`document.querySelector('[data-testid=activity-item][data-drag-id=api]')?.click()`);
        await wait(200);
      },
    };
  },
});
