import { sign } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { maskArguments, type LogsConnectionSummary, type LogsConnectionTest, type LogsDatasource, type LogsFieldCount, type LogsHistoryEntry, type LogsHits, type LogsQueryResult, type LogsSession } from '@quiver/core';
import { FAKE_VICTORIALOGS_VERSION, startFakeVictoriaLogs, type FakeVictoriaLogs } from '../fake-victorialogs';
import { definePart, freePort, until, type SmokeContext, type UiContext } from '../part';

export default definePart({
  name: 'logs',
  summary: 'Logs: the fake Grafana sign-in, VictoriaLogs queries, fields, hits, history, the logs tab',
  async run(t) {
    const { host, check, run, ws, folder, toolNames: names } = t;
    const { fakeGrafana } = t.fixtures;

    // Logs: a VictoriaLogs data source through a fake Grafana that signs in without hands and asks for token renewals.
    {
      const fail = async (id: string, input: unknown, caller: 'ui' | 'mcp' = 'ui') => {
        const out = await host.invoke(id, input, { caller, workspaceId: ws.id });
        return out.ok ? 'ok' : `${out.error.code}: ${out.error.message}`;
      };
      // Other parts (db, Redis through Grafana) may have signed in to the same fake Grafana before.
      const logins0 = fakeGrafana.seen.logins;
      const logouts0 = fakeGrafana.seen.logouts;
      const created = await run<LogsConnectionSummary>('logs.connection.save', { connection: { name: '', grafanaUrl: `${fakeGrafana.url}/?orgId=1` } }, ws.id);
      const onDisk = JSON.parse(await fs.readFile(path.join(folder, '.quiver', 'logs-connections', `${created.id}.json`), 'utf8')) as { grafanaUrl: string };
      check(
        'logs: a new connection is committed under .quiver/logs-connections with the address normalised',
        created.grafanaUrl === fakeGrafana.url && onDisk.grafanaUrl === fakeGrafana.url && created.name === 'Logs' && ['unknown', 'signed-out'].includes(created.session.state),
        { grafanaUrl: created.grafanaUrl, name: created.name, session: created.session.state },
      );
      const badUrl = await fail('logs.connection.save', { connection: { id: created.id, grafanaUrl: 'ftp://nowhere' } });
      const noSource = await fail('logs.query', { id: created.id });
      check('logs: a bad address is refused and a connection without a data source cannot query', badUrl.startsWith('INVALID_INPUT') && noSource.startsWith('INVALID_INPUT') && noSource.includes('no data source'), { badUrl, noSource });

      const signedOut = await run<LogsSession>('logs.session', { id: created.id }, ws.id);
      const sourcesSignedOut = await fail('logs.datasources', { id: created.id });
      check('logs: before signing in the session is signed-out and Grafana calls ask for a sign-in', signedOut.state === 'signed-out' && sourcesSignedOut.startsWith('SIGN_IN_REQUIRED'), { signedOut, sourcesSignedOut });

      const signedIn = await run<LogsSession>('logs.signin', { id: created.id }, ws.id);
      check(
        'logs: sign-in opens the login page, follows the identity provider back and knows the user',
        signedIn.state === 'signed-in' && signedIn.user?.email === 'smoke@example.com' && fakeGrafana.seen.logins === logins0 + 1,
        { signedIn, logins: fakeGrafana.seen.logins },
      );
      const again = await run<LogsSession>('logs.signin', { id: created.id }, ws.id);
      check('logs: signing in again with a live session opens no window', again.state === 'signed-in' && fakeGrafana.seen.logins === logins0 + 1, { again: again.state, logins: fakeGrafana.seen.logins });

      const sources = await run<LogsDatasource[]>('logs.datasources', { id: created.id }, ws.id);
      check('logs: only VictoriaLogs data sources are listed', sources.length === 1 && sources[0]?.uid === 'vl-smoke' && sources[0]?.type === 'victoriametrics-logs-datasource', sources);
      await run('logs.connection.save', { connection: { id: created.id, datasourceUid: 'vl-smoke', datasourceName: 'VictoriaLogs-Smoke', name: 'VictoriaLogs-Smoke' } }, ws.id);

      fakeGrafana.expireTokens();
      const api = await run<LogsQueryResult>('logs.query', { id: created.id, filters: [{ field: 'app', value: 'api' }], from: 'now-15m', limit: 100 }, ws.id);
      check(
        'logs: a query renews a token that is due, folds the filters in and returns the entries newest first',
        fakeGrafana.seen.rotations >= 1 &&
          api.query === 'app:="api"' &&
          JSON.stringify(api.entries.map((e) => e.msg)) === JSON.stringify(['cache miss', 'payment failed: card declined', 'GET /health 200']) &&
          api.entries[1]?.level === 'Error' &&
          api.entries[1]?.fields['error.code'] === 'E42' &&
          !('_stream_id' in (api.entries[0]?.fields ?? {})) &&
          api.limited === false,
        { rotations: fakeGrafana.seen.rotations, query: api.query, entries: api.entries.map((e) => [e.msg, e.level]) },
      );
      const narrowed = await run<LogsQueryResult>('logs.query', { id: created.id, query: 'payment', filters: [{ field: 'level', value: 'Debug', exclude: true }], limit: 1 }, ws.id);
      check(
        'logs: a free-text query with an excluding filter, and the limit is reported',
        narrowed.query === '!level:="Debug" (payment)' && narrowed.entries.length === 1 && narrowed.entries[0]?.msg === 'payment failed: card declined' && narrowed.limited === true && fakeGrafana.seen.exprs.at(-1)?.maxLines === 1,
        { query: narrowed.query, entries: narrowed.entries.map((e) => e.msg), limited: narrowed.limited },
      );
      const logsFields = await run<LogsFieldCount[]>('logs.fields', { id: created.id }, ws.id);
      const levels = await run<LogsFieldCount[]>('logs.values', { id: created.id, field: 'level' }, ws.id);
      const apps = await run<LogsFieldCount[]>('logs.values', { id: created.id, field: 'app', filters: [{ field: 'level', value: 'Information' }] }, ws.id);
      check(
        'logs: field names leave out the internal ones, and values come with counts, most common first',
        logsFields.map((f) => f.name).join() === 'app,level,error.code' &&
          levels[0]?.name === 'Information' &&
          levels[0]?.hits === 2 &&
          levels.length === 4 &&
          JSON.stringify(apps) === JSON.stringify([{ name: 'api', hits: 1 }, { name: 'worker', hits: 1 }]) &&
          fakeGrafana.seen.exprs.some((e) => e.expr === 'level:="Information" | stats by (app) count() hits | sort by (hits desc) | limit 50'),
        { fields: logsFields, levels, apps },
      );
      const logsHits = await run<LogsHits>('logs.hits', { id: created.id, query: 'x | stats count()', from: 'now-15m' }, ws.id);
      check(
        'logs: hits count the filter part in about 60 buckets over the range',
        logsHits.total === 0 && logsHits.stepMs === 30_000 && fakeGrafana.seen.exprs.at(-1)?.expr === 'x' && fakeGrafana.seen.exprs.at(-1)?.queryType === 'hits',
        { total: logsHits.total, stepMs: logsHits.stepMs, sent: fakeGrafana.seen.exprs.at(-1) },
      );
      const allHits = await run<LogsHits>('logs.hits', { id: created.id }, ws.id);
      check('logs: hits add up to every entry in range', allHits.total === 5 && allHits.buckets.length >= 1, allHits);
      const broken = await fail('logs.query', { id: created.id, query: 'app:(((' });
      check("logs: a LogsQL error comes back without Grafana's prefix or the echoed query", broken.startsWith("REQUEST_FAILED: cannot parse `query` arg: missing ')'") && !broken.includes('query='), broken);
      const badRange = await fail('logs.query', { id: created.id, from: 'now', to: 'now-1h' });
      check('logs: a range that ends before it starts is refused', badRange.startsWith('INVALID_INPUT'), badRange);

      const logsHistory = await run<LogsHistoryEntry[]>('logs.history.list', { id: created.id }, ws.id);
      check(
        'logs: the history keeps each query newest first, with its count or its error',
        logsHistory.length === 3 && logsHistory[0]?.query === 'app:(((' && logsHistory[0]?.error?.startsWith('cannot parse') === true && logsHistory[1]?.count === 1 && logsHistory[2]?.count === 3,
        logsHistory.map((h) => [h.query, h.count, h.error]),
      );

      const agentQuery = await fail('logs.query', { id: created.id, limit: 2 }, 'mcp');
      const agentSignOut = await fail('logs.signout', { id: created.id }, 'mcp');
      const agentDelete = await fail('logs.connection.delete', { id: created.id }, 'mcp');
      const agentClear = await fail('logs.history.clear', {}, 'mcp');
      const signInMeta = host.registry.list().find((c) => c.id === 'logs.signin');
      check(
        'logs: agents may query but not sign out, delete or clear, and sign-in is not offered to them',
        agentQuery === 'ok' && agentSignOut.startsWith('MUTATION_BLOCKED') && agentDelete.startsWith('MUTATION_BLOCKED') && agentClear.startsWith('MUTATION_BLOCKED') && signInMeta?.hidden === true,
        { agentQuery, agentSignOut, agentDelete, agentClear, signInHidden: signInMeta?.hidden },
      );

      const signedOff = await run<LogsSession>('logs.signout', { id: created.id }, ws.id);
      const afterSignOut = await fail('logs.query', { id: created.id });
      const listedOut = (await run<LogsConnectionSummary[]>('logs.connection.list', {}, ws.id)).find((c) => c.id === created.id);
      check(
        'logs: signing out ends the session on Grafana and on this machine',
        signedOff.state === 'signed-out' && fakeGrafana.seen.logouts === logouts0 + 1 && afterSignOut.startsWith('SIGN_IN_REQUIRED') && listedOut?.session.state === 'signed-out',
        { signedOff: signedOff.state, logouts: fakeGrafana.seen.logouts, afterSignOut, listed: listedOut?.session.state },
      );
      const back = await run<LogsSession>('logs.signin', { id: created.id }, ws.id);
      check('logs: signing in after signing out goes through the login page again', back.state === 'signed-in' && fakeGrafana.seen.logins === logins0 + 2, { back: back.state, logins: fakeGrafana.seen.logins });
    }

    // VictoriaLogs directly: a fake VictoriaLogs serving the fake Grafana's entries, behind a bearer token and a tenant.
    const fakeVl = await startFakeVictoriaLogs(fakeGrafana.logs);
    const direct = await directChecks(t, fakeVl);

    return {
      after: () => fakeVl.close(),
      ui: async (u) => {
        const { js, wait, shot } = u;
        // Logs: the connection signed in above, its entries with level chips and histogram, filters from an entry and from the picker, the setup.
        await js(`document.querySelector('[data-testid=activity-item][data-drag-id=logs]').click()`);
        await wait(600);
        const logsRows = (await js(`[...document.querySelectorAll('[data-testid=logs-connection][data-kind=grafana]')].map((r) => [r.textContent.trim(), r.getAttribute('data-session')])`)) as string[][];
        check('ui: logs: the sidebar lists the connection, signed in', logsRows.length === 1 && logsRows[0]![0]!.includes('VictoriaLogs-Smoke') && logsRows[0]![1] === 'signed-in', logsRows);
        const logsEntries = () => js(`[...document.querySelectorAll('[data-testid=logs-entry]')].map((r) => r.getAttribute('data-level') + ':' + r.textContent.trim())`) as Promise<string[]>;
        await js(`document.querySelector('[data-testid=logs-connection][data-kind=grafana]').click()`);
        await until(async () => (await logsEntries()).length === 5, 6000);
        const firstEntries = await logsEntries();
        check(
          'ui: logs: the tab runs its query on open and lists the entries newest first with their level',
          firstEntries.length === 5 && firstEntries[0]!.startsWith('Debug:') && firstEntries[0]!.includes('cache miss') && firstEntries[4]!.includes('GET /health 200'),
          firstEntries,
        );
        await until(async () => (await js(`document.querySelectorAll('[data-testid=logs-level-chip]').length`)) === 4, 4000);
        await until(async () => String(await js(`document.querySelector('[data-testid=logs-hits-total]')?.textContent ?? ''`)).trim().startsWith('5'), 4000);
        const levelChips = (await js(`[...document.querySelectorAll('[data-testid=logs-level-chip]')].map((c) => c.textContent.trim())`)) as string[];
        const histogramTotal = String(await js(`document.querySelector('[data-testid=logs-hits-total]')?.textContent ?? ''`)).trim();
        check('ui: logs: level chips count each level and the histogram counts every match', levelChips.length === 4 && levelChips[0]!.startsWith('Information') && histogramTotal.startsWith('5'), { levelChips, histogramTotal });
        await shot('28a-logs-light');
        await js(`document.documentElement.classList.add('dark')`);
        await wait(300);
        await shot('28b-logs-dark');
        await js(`document.documentElement.classList.remove('dark')`);
        await wait(200);

        await js(`document.querySelector('[data-testid=logs-level-chip][data-level=Error]').click()`);
        await until(async () => (await logsEntries()).length === 1, 4000);
        const errorsOnly = await logsEntries();
        check('ui: logs: a level chip keeps only that level', errorsOnly.length === 1 && errorsOnly[0]!.startsWith('Error:'), errorsOnly);
        await js(`document.querySelector('[data-testid=logs-entry]').click()`);
        await wait(400);
        const detailFields = await js(`[...document.querySelectorAll('[data-testid=logs-entry-field]')].map((r) => r.getAttribute('data-field'))`);
        check('ui: logs: clicking an entry shows its fields', JSON.stringify(detailFields) === JSON.stringify(['app', 'error.code', 'level']), detailFields);
        await shot('28c-logs-entry-light');
        await js(`document.querySelector('[data-testid=logs-entry-field][data-field=app] [data-testid=logs-filter-out]').click()`);
        await until(async () => Boolean(await js(`document.querySelector('[data-testid=logs-empty]')`)), 4000);
        const logsComposed = String(await js(`document.querySelector('[data-testid=logs-composed]')?.textContent ?? ''`)).trim();
        const logsChipCount = await js(`document.querySelectorAll('[data-testid=logs-filter-chip]').length`);
        check('ui: logs: leaving out a value from an entry adds a chip and runs again', logsComposed === 'level:="Error" !app:="api"' && logsChipCount === 2, { logsComposed, logsChipCount });

        for (let i = 0; i < 2; i++) {
          await js(`document.querySelector('[data-testid=logs-filter-chip] button[aria-label="Remove filter"]').click()`);
          await wait(300);
        }
        await until(async () => (await logsEntries()).length === 5, 4000);

        // Follow mode: an entry arrives stamped two minutes ahead of this clock, as a server whose clock runs ahead would stamp it. The first poll must fetch it, and the next poll must not fail on it.
        fakeGrafana.add({ at: Date.now() + 120_000, msg: 'heartbeat from a server whose clock runs ahead', fields: { _stream_id: 's-api', app: 'api', level: 'Information' } });
        await js(`document.querySelector('[data-testid=logs-follow]').click()`);
        await until(async () => (await logsEntries()).length === 6, 6000);
        const followed = await logsEntries();
        await wait(5600);
        const stillFollowing = await js(
          `({ label: document.querySelector('[data-testid=logs-follow]')?.textContent.trim(), error: Boolean(document.querySelector('[data-testid=logs-error]')), count: document.querySelectorAll('[data-testid=logs-entry]').length })`,
        );
        check(
          'ui: logs: follow mode picks up an entry stamped ahead of this clock and keeps following past it',
          followed[0]!.includes('clock runs ahead') && JSON.stringify(stillFollowing) === JSON.stringify({ label: 'Following', error: false, count: 6 }),
          { followed, stillFollowing },
        );
        await js(`document.querySelector('[data-testid=logs-follow]').click()`);
        await wait(200);
        await js(`document.querySelector('[data-testid=logs-add-filter]').click()`);
        await until(async () => (await js(`document.querySelectorAll('[data-testid=logs-filter-field]').length`)) === 3, 4000);
        const pickerFields = await js(`[...document.querySelectorAll('[data-testid=logs-filter-field]')].map((r) => r.getAttribute('data-field'))`);
        await js(`document.querySelector('[data-testid=logs-filter-field][data-field=app]').click()`);
        await until(async () => (await js(`document.querySelectorAll('[data-testid=logs-filter-value]').length`)) === 2, 4000);
        const pickerValues = await js(`[...document.querySelectorAll('[data-testid=logs-filter-value]')].map((r) => r.textContent.replace(/\\s+/g, ' ').trim())`);
        await shot('28d-logs-filter-picker-light');
        await js(`document.querySelector('[data-testid=logs-filter-value][data-value=worker] button').click()`);
        await until(async () => (await logsEntries()).length === 2, 4000);
        const workerEntries = await logsEntries();
        check(
          'ui: logs: the filter picker lists fields, then values with counts, and keeps the one picked',
          JSON.stringify(pickerFields) === JSON.stringify(['app', 'level', 'error.code']) &&
            Array.isArray(pickerValues) &&
            String(pickerValues[0]).startsWith('api3') &&
            workerEntries.length === 2 &&
            workerEntries.every((e) => e.includes('retrying publish') || e.includes('order.created')),
          { pickerFields, pickerValues, workerEntries },
        );
        const logsTabState = (await js(`[...document.querySelectorAll('[data-testid=logs-filter-chip]')].map((c) => c.textContent.replace(/\\s+/g, '').trim())`));
        check('ui: logs: the chip reads field = value', JSON.stringify(logsTabState) === JSON.stringify(['app=worker']), logsTabState);

        await js(`document.querySelector('[data-testid=logs-settings]').click()`);
        await until(async () => Boolean(await js(`document.querySelector('[data-testid=logs-setup]')`)), 3000);
        await until(async () => (await js(`document.querySelector('[data-testid=logs-datasource]')?.value`)) === 'vl-smoke', 4000);
        const setupState = await js(
          `({ session: document.querySelector('[data-testid=logs-session]')?.textContent.trim(), source: document.querySelector('[data-testid=logs-datasource]')?.value, url: document.querySelector('[data-testid=logs-grafana-url]')?.value })`,
        );
        check(
          'ui: logs: the settings show the address, who is signed in and the data source',
          JSON.stringify(setupState) === JSON.stringify({ session: 'Signed in as smoke@example.com', source: 'vl-smoke', url: fakeGrafana.url }),
          setupState,
        );
        await shot('28e-logs-setup-light');
        await js(`document.querySelector('[data-testid=logs-setup-done]').click()`);
        await wait(400);
        await direct.ui(u);
        await js(`document.querySelector('[data-testid=activity-item][data-drag-id=api]').click()`);
        await wait(200);
      },
    };
  },
});

/**
 * A connection of kind victorialogs against the fake VictoriaLogs: the secret kept out of the project, test,
 * queries, hits, fields and values with the tenant and token sent, sign-in refused, the history, what an agent
 * sees, an unreachable server and a file written before connections had a kind. Its UI checks run after the
 * Grafana ones, from the logs part's `ui` hook.
 */
async function directChecks(t: SmokeContext, vl: FakeVictoriaLogs): Promise<{ ui: (u: UiContext) => Promise<void> }> {
  const { host, check, run, ws, folder, rpc, toolNames: names } = t;
  const fail = async (id: string, input: unknown, caller: 'ui' | 'mcp' = 'ui') => {
    const out = await host.invoke(id, input, { caller, workspaceId: ws.id });
    return out.ok ? 'ok' : `${out.error.code}: ${out.error.message}`;
  };
  const TOKEN = 'vl-smoke-token-3141';
  vl.requireAuth({ kind: 'bearer', token: TOKEN });
  vl.setTenant({ accountId: 3, projectId: 7 });
  const sent = () => vl.seen.filter((s) => s.path.startsWith('/select/'));

  const saved = await run<LogsConnectionSummary>(
    'logs.connection.save',
    { connection: { name: 'VL-Direct', kind: 'victorialogs', url: `${vl.url}/?from=smoke`, tenant: { accountId: 3, projectId: 7 }, auth: 'bearer' }, secret: TOKEN },
    ws.id,
  );
  const fileText = await fs.readFile(path.join(folder, '.quiver', 'logs-connections', `${saved.id}.json`), 'utf8');
  const onDisk = JSON.parse(fileText) as Record<string, unknown>;
  const localText = await fs.readFile(path.join(folder, '.quiver', 'local', 'logs-secrets.json'), 'utf8').catch(() => '');
  const got = await run<LogsConnectionSummary>('logs.connection.get', { id: saved.id }, ws.id);
  check(
    'logs: a direct VictoriaLogs connection is committed with its address, tenant and auth kind, and its token only on this machine, encrypted',
    onDisk['kind'] === 'victorialogs' &&
      onDisk['url'] === vl.url &&
      JSON.stringify(onDisk['tenant']) === JSON.stringify({ accountId: 3, projectId: 7 }) &&
      onDisk['auth'] === 'bearer' &&
      !fileText.includes(TOKEN) &&
      !('secret' in onDisk) &&
      localText.includes(`logs-connection:${saved.id}`) &&
      !localText.includes(TOKEN) &&
      got.hasSecret === true &&
      !JSON.stringify(got).includes(TOKEN) &&
      got.session.state === 'unknown',
    { onDisk, hasSecret: got.hasSecret, session: got.session.state },
  );
  const badTenant = await fail('logs.connection.save', { connection: { id: saved.id, tenant: { accountId: -1, projectId: 0 } } });
  const badUrl = await fail('logs.connection.save', { connection: { id: saved.id, url: 'ftp://nowhere' } });
  check('logs: a negative tenant id and a non-http address are refused', badTenant.startsWith('INVALID_INPUT') && badUrl.startsWith('INVALID_INPUT'), { badTenant, badUrl });

  const tested = await run<LogsConnectionTest>('logs.connection.test', { id: saved.id }, ws.id);
  const lastTest = sent().at(-1);
  const afterTest = await run<LogsConnectionSummary>('logs.connection.get', { id: saved.id }, ws.id);
  check(
    'logs: Test reaches the server with the token and the tenant headers, and reads its version',
    tested.ok === true && tested.version === FAKE_VICTORIALOGS_VERSION && lastTest?.path === '/select/logsql/field_names' && lastTest.tenant === '3:7' && lastTest.authorization === `Bearer ${TOKEN}` && afterTest.session.state === 'signed-in' && afterTest.session.user === null,
    { tested, lastTest, session: afterTest.session },
  );
  await run('logs.connection.save', { connection: { id: saved.id }, secret: 'wrong-token' }, ws.id);
  const refused = await run<LogsConnectionTest>('logs.connection.test', { id: saved.id }, ws.id);
  const refusedQuery = await fail('logs.query', { id: saved.id });
  const listedRefused = (await run<LogsConnectionSummary[]>('logs.connection.list', {}, ws.id)).find((c) => c.id === saved.id);
  check(
    'logs: a wrong token fails Test with LOGS_AUTH_FAILED and the server message, and the connection shows it',
    refused.ok === false &&
      refused.code === 'LOGS_AUTH_FAILED' &&
      refused.error?.includes('missing or wrong credentials') === true &&
      refusedQuery.startsWith('LOGS_AUTH_FAILED') &&
      listedRefused?.session.state === 'signed-out' &&
      listedRefused.session.error?.includes('refused the credentials') === true,
    { refused, refusedQuery, session: listedRefused?.session },
  );
  await run('logs.connection.save', { connection: { id: saved.id }, secret: TOKEN }, ws.id);

  const api = await run<LogsQueryResult>('logs.query', { id: saved.id, filters: [{ field: 'app', value: 'api' }], from: 'now-15m', limit: 100 }, ws.id);
  const apiSent = sent().at(-1);
  check(
    'logs: a direct query folds the filters in and returns the same entries as through Grafana, newest first',
    api.query === 'app:="api"' &&
      apiSent?.path === '/select/logsql/query' &&
      apiSent.args['query'] === 'app:="api"' &&
      apiSent.args['limit'] === '100' &&
      apiSent.tenant === '3:7' &&
      JSON.stringify(api.entries.map((e) => e.msg)) === JSON.stringify(['cache miss', 'payment failed: card declined', 'GET /health 200']) &&
      api.entries[1]?.level === 'Error' &&
      api.entries[1]?.fields['error.code'] === 'E42' &&
      !('_stream_id' in (api.entries[0]?.fields ?? {})) &&
      !('_time' in (api.entries[0]?.fields ?? {})) &&
      api.limited === false,
    { query: api.query, sent: apiSent, entries: api.entries.map((e) => [e.msg, e.level]) },
  );
  const narrowed = await run<LogsQueryResult>('logs.query', { id: saved.id, query: 'payment', filters: [{ field: 'level', value: 'Debug', exclude: true }], limit: 1 }, ws.id);
  check(
    'logs: a direct free-text query with an excluding filter, and the limit sent and reported',
    narrowed.query === '!level:="Debug" (payment)' && narrowed.entries.length === 1 && narrowed.entries[0]?.msg === 'payment failed: card declined' && narrowed.limited === true && sent().at(-1)?.args['limit'] === '1',
    { query: narrowed.query, entries: narrowed.entries.map((e) => e.msg), limited: narrowed.limited },
  );
  const dHits = await run<LogsHits>('logs.hits', { id: saved.id, query: '* | stats count()', from: 'now-15m' }, ws.id);
  const hitsSent = sent().at(-1);
  const dFields = await run<LogsFieldCount[]>('logs.fields', { id: saved.id }, ws.id);
  const dLevels = await run<LogsFieldCount[]>('logs.values', { id: saved.id, field: 'level' }, ws.id);
  const valuesSent = sent().at(-1);
  check(
    'logs: direct hits count the filter part in about 60 buckets, and field names and values come from their endpoints',
    dHits.total === 5 &&
      dHits.stepMs === 30_000 &&
      hitsSent?.path === '/select/logsql/hits' &&
      hitsSent.args['query'] === '*' &&
      hitsSent.args['step'] === '30s' &&
      dFields.map((f) => f.name).join() === 'app,level,error.code' &&
      dLevels[0]?.name === 'Information' &&
      dLevels[0]?.hits === 2 &&
      dLevels.length === 4 &&
      valuesSent?.path === '/select/logsql/field_values' &&
      valuesSent.args['field'] === 'level' &&
      valuesSent.args['limit'] === '50',
    { hits: dHits.total, stepMs: dHits.stepMs, hitsSent: hitsSent?.args, fields: dFields, levels: dLevels },
  );
  const dBroken = await fail('logs.query', { id: saved.id, query: 'app:(((' });
  check("logs: a direct LogsQL error comes back with the server's message", dBroken.startsWith('REQUEST_FAILED: cannot parse query') && dBroken.includes("missing ')'"), dBroken);
  const otherTenant = await run<LogsQueryResult>('logs.query', { id: saved.id, query: '*', limit: 10 }, ws.id).then(async (all) => {
    await run('logs.connection.save', { connection: { id: saved.id, tenant: null } }, ws.id);
    const none = await run<LogsQueryResult>('logs.query', { id: saved.id, query: '*', limit: 10 }, ws.id);
    const noHeaders = sent().at(-1)?.tenant ?? null;
    await run('logs.connection.save', { connection: { id: saved.id, tenant: { accountId: 3, projectId: 7 } } }, ws.id);
    return { all: all.entries.length, none: none.entries.length, noHeaders };
  });
  check('logs: the tenant decides what a direct query sees; without one no tenant headers are sent', otherTenant.all === 5 && otherTenant.none === 0 && otherTenant.noHeaders === null, otherTenant);

  const dSession = await run<LogsSession>('logs.session', { id: saved.id }, ws.id);
  const dSignIn = await fail('logs.signin', { id: saved.id });
  const dSignOut = await fail('logs.signout', { id: saved.id });
  const dSources = await fail('logs.datasources', { id: saved.id });
  check(
    'logs: a direct connection is "signed in" with no user when the server answers, and sign-in, sign-out and data sources are refused',
    dSession.state === 'signed-in' && dSession.user === null && dSignIn.startsWith('NOT_SUPPORTED') && dSignIn.includes('needs no sign-in') && dSignOut.startsWith('NOT_SUPPORTED') && dSources.startsWith('NOT_SUPPORTED'),
    { dSession, dSignIn, dSignOut, dSources },
  );
  const dHistory = await run<LogsHistoryEntry[]>('logs.history.list', { id: saved.id }, ws.id);
  check(
    'logs: direct queries are recorded in the history with their count or error',
    dHistory.length === 6 && dHistory.some((h) => h.query === 'app:(((' && h.error?.startsWith('cannot parse query') === true) && dHistory.some((h) => h.error?.includes('refused the credentials') === true) && dHistory.some((h) => h.count === 3),
    dHistory.map((h) => [h.query, h.count, h.error]),
  );

  // An agent: saving with a secret works, the secret never comes back and is masked where calls are shown; Test is allowed.
  const AGENT_SECRET = 'agent-secret-2718';
  const agentSave = await rpc('tools/call', { name: 'logs_connection_save', arguments: { connection: { name: 'Agent VL', kind: 'victorialogs', url: vl.url, auth: 'basic', authUsername: 'agent' }, secret: AGENT_SECRET } });
  const agentText = agentSave.result?.content?.[0]?.text ?? JSON.stringify(agentSave.error ?? null);
  const agentConn = agentSave.result?.isError ? null : (JSON.parse(agentText) as LogsConnectionSummary);
  const masked = JSON.stringify(maskArguments({ connection: { name: 'Agent VL' }, secret: AGENT_SECRET }));
  const agentTest = agentConn ? await fail('logs.connection.test', { id: saved.id }, 'mcp') : 'not saved';
  check(
    'logs: an agent saves a direct connection with a secret, never sees it back, has it masked in the approval and activity views, and may test',
    agentConn?.hasSecret === true &&
      !agentText.includes(AGENT_SECRET) &&
      !masked.includes(AGENT_SECRET) &&
      agentTest === 'ok' &&
      names.includes('logs_connection_test') &&
      !names.includes('logs_signin'),
    { agentText: agentText.slice(0, 300), masked, agentTest },
  );
  // The stored token stays where it was given: an agent cannot point the connection elsewhere without mutations, nor read the token from a list.
  const agentMove = await fail('logs.connection.save', { connection: { id: saved.id, url: 'http://127.0.0.1:9' } }, 'mcp');
  const agentRename = await fail('logs.connection.save', { connection: { id: saved.id, name: 'VL-Direct' } }, 'mcp');
  const agentList = await rpc('tools/call', { name: 'logs_connection_list', arguments: {} });
  const agentListText = agentList.result?.content?.[0]?.text ?? '';
  const afterMove = await run<LogsConnectionSummary>('logs.connection.get', { id: saved.id }, ws.id);
  const NEWLINE_SECRET = 'line-break-secret\nX-Other: 1';
  const badSecret = await fail('logs.connection.save', { connection: { id: saved.id }, secret: NEWLINE_SECRET });
  check(
    'logs: an agent may not move a connection with a stored token to another address, never gets the token from a list, and a token with a line break is refused without being quoted',
    agentMove.startsWith('MUTATION_BLOCKED') &&
      agentRename === 'ok' &&
      afterMove.url === vl.url &&
      agentListText.includes('VL-Direct') &&
      !agentListText.includes(TOKEN) &&
      badSecret.startsWith('INVALID_INPUT') &&
      !badSecret.includes('line-break-secret'),
    { agentMove, agentRename, url: afterMove.url, badSecret },
  );
  if (agentConn) await run('logs.connection.delete', { id: agentConn.id }, ws.id);
  const agentLocal = await fs.readFile(path.join(folder, '.quiver', 'local', 'logs-secrets.json'), 'utf8').catch(() => '');
  check('logs: deleting a direct connection forgets its secret on this machine', Boolean(agentConn) && !agentLocal.includes(`logs-connection:${agentConn?.id}`), { agentLocal });

  // An unreachable server: a port nothing listens on.
  const deadPort = await freePort();
  const dead = await run<LogsConnectionSummary>('logs.connection.save', { connection: { name: 'VL-Down', kind: 'victorialogs', url: `127.0.0.1:${deadPort}` } }, ws.id);
  const deadTest = await run<LogsConnectionTest>('logs.connection.test', { id: dead.id }, ws.id);
  const deadQuery = await fail('logs.query', { id: dead.id });
  check(
    'logs: an unreachable VictoriaLogs fails with LOGS_UNREACHABLE, and an address without a scheme is http',
    dead.url === `http://127.0.0.1:${deadPort}` && deadTest.ok === false && deadTest.code === 'LOGS_UNREACHABLE' && deadQuery.startsWith('LOGS_UNREACHABLE'),
    { url: dead.url, deadTest, deadQuery },
  );
  await run('logs.connection.delete', { id: dead.id }, ws.id);

  // A connection file from before connections had a kind is still a Grafana connection.
  const oldId = 'logs-old-format-smoke';
  await fs.writeFile(
    path.join(folder, '.quiver', 'logs-connections', `${oldId}.json`),
    JSON.stringify({ id: oldId, name: 'Old format', grafanaUrl: 'https://grafana.example.com', datasourceUid: 'vl', datasourceName: 'VL', datasourceType: 'victoriametrics-logs-datasource', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }, null, 2),
  );
  await until(async () => (await host.invoke('logs.connection.get', { id: oldId }, { caller: 'ui', workspaceId: ws.id })).ok, 5000);
  const old = await run<LogsConnectionSummary>('logs.connection.get', { id: oldId }, ws.id);
  const oldSignIn = await run<LogsConnectionSummary>('logs.connection.save', { connection: { id: oldId, name: 'Old format, renamed' } }, ws.id);
  check('logs: a connection file without a kind is read as a Grafana connection, and saving it keeps it one', old.kind === 'grafana' && old.grafanaUrl === 'https://grafana.example.com' && old.hasSecret === false && oldSignIn.kind === 'grafana', { kind: old.kind, saved: oldSignIn.kind });
  await run('logs.connection.delete', { id: oldId }, ws.id);

  return {
    ui: async ({ js, wait, shot }) => {
      const tab = '[data-testid=logs-connection-tab][data-kind=victorialogs]';
      const row = (await js(`(() => { const r = document.querySelector('[data-testid=logs-connection][data-kind=victorialogs]'); return r && { text: r.textContent.trim(), session: r.getAttribute('data-session'), title: r.getAttribute('title') }; })()`)) as { text: string; session: string; title: string } | null;
      check('ui: logs: the sidebar shows the direct connection as direct, with its check instead of a signed-in user', Boolean(row?.text.includes('VL-Direct') && row.text.includes('direct') && row.title.includes('VictoriaLogs') && row.title.includes('Direct · Reachable')), row);
      await js(`document.querySelector('[data-testid=logs-connection][data-kind=victorialogs]').click()`);
      const directEntries = () => js(`[...document.querySelectorAll('${tab} [data-testid=logs-entry]')].map((r) => r.getAttribute('data-level') + ':' + r.textContent.trim())`) as Promise<string[]>;
      await until(async () => (await directEntries()).length >= 5, 6000);
      await until(async () => (await js(`document.querySelectorAll('${tab} [data-testid=logs-level-chip]').length`)) === 4, 4000);
      const entries = await directEntries();
      const header = await js(`({ session: document.querySelector('${tab} [data-testid=logs-tab-session]')?.textContent.trim(), signIn: [...document.querySelectorAll('${tab} button')].some((b) => b.textContent.trim() === 'Sign in') })`);
      check(
        'ui: logs: the direct connection tab runs its query and lists the entries newest first, reachable and without a Sign in button',
        entries.length >= 5 && entries.some((e) => e.startsWith('Error:') && e.includes('payment failed')) && entries.at(-1)!.includes('GET /health 200') && JSON.stringify(header) === JSON.stringify({ session: 'Reachable', signIn: false }),
        { entries, header },
      );
      await shot('28f-logs-direct-light');
      await js(`document.documentElement.classList.add('dark')`);
      await wait(300);
      await shot('28g-logs-direct-dark');
      await js(`document.documentElement.classList.remove('dark')`);
      await wait(200);

      await js(`document.querySelector('${tab} [data-testid=logs-settings]').click()`);
      await until(async () => Boolean(await js(`document.querySelector('${tab} [data-testid=logs-setup][data-kind=victorialogs]')`)), 3000);
      await js(`document.querySelector('${tab} [data-testid=logs-test]').click()`);
      await until(async () => Boolean(await js(`document.querySelector('${tab} [data-testid=logs-test-result]')`)), 4000);
      const setup = await js(
        `({ url: document.querySelector('${tab} [data-testid=logs-vl-url]')?.value, account: document.querySelector('${tab} [data-testid=logs-vl-account]')?.value, project: document.querySelector('${tab} [data-testid=logs-vl-project]')?.value, secret: document.querySelector('${tab} [data-testid=logs-vl-secret-state]')?.textContent.trim(), secretShown: Boolean(document.querySelector('${tab} [data-testid=logs-vl-secret]')), kind: document.querySelector('${tab} [data-testid=logs-kind-victorialogs]')?.getAttribute('aria-selected'), test: document.querySelector('${tab} [data-testid=logs-test-result]')?.getAttribute('data-ok'), testText: document.querySelector('${tab} [data-testid=logs-test-result]')?.textContent.trim() })`,
      );
      const s = setup as Record<string, string | boolean | undefined>;
      check(
        'ui: logs: the direct setup shows the address, tenant and a stored token it does not show, and Test succeeds',
        s['url'] === vl.url && s['account'] === '3' && s['project'] === '7' && s['secret'] === 'Stored on this machine' && s['secretShown'] === false && s['kind'] === 'true' && s['test'] === 'true' && String(s['testText']).includes('v1.30.0'),
        setup,
      );
      await shot('28h-logs-direct-setup-light');
      await js(`document.documentElement.classList.add('dark')`);
      await wait(300);
      await shot('28i-logs-direct-setup-dark');
      await js(`document.documentElement.classList.remove('dark')`);
      await wait(200);
      await js(`document.querySelector('${tab} [data-testid=logs-setup-done]').click()`);
      await wait(300);

      // The kind switch: a Grafana connection without an address yet, switched to VictoriaLogs in its setup.
      const fresh = await run<LogsConnectionSummary>('logs.connection.save', { connection: { name: 'Switch me' } }, ws.id);
      await until(async () => Boolean(await js(`document.querySelector('[data-testid=logs-connection][data-kind=grafana][title^="No Grafana address"]')`)), 3000);
      await js(`[...document.querySelectorAll('[data-testid=logs-connection]')].find((r) => r.textContent.includes('Switch me'))?.click()`);
      const freshTab = `[data-testid=logs-connection-tab]:not([data-kind=victorialogs]) [data-testid=logs-setup][data-kind=grafana]`;
      await until(async () => Boolean(await js(`[...document.querySelectorAll('${freshTab}')].find((el) => el.offsetParent !== null)`)), 3000);
      await js(`[...document.querySelectorAll('[data-testid=logs-kind-victorialogs]')].find((el) => el.offsetParent !== null)?.click()`);
      const switched = await until(async () => (await run<LogsConnectionSummary>('logs.connection.get', { id: fresh.id }, ws.id)).kind === 'victorialogs', 3000);
      await until(async () => Boolean(await js(`[...document.querySelectorAll('[data-testid=logs-vl-url]')].find((el) => el.offsetParent !== null)`)), 3000);
      const urlField = await js(`Boolean([...document.querySelectorAll('[data-testid=logs-vl-url]')].find((el) => el.offsetParent !== null))`);
      check('ui: logs: the kind switch turns a connection into a direct one and shows the VictoriaLogs form', switched && urlField === true, { switched, urlField });
      await shot('28j-logs-kind-switch-light');
      // Deleted from its setup, which asks first and closes the tab.
      await js(`[...document.querySelectorAll('[data-testid=logs-delete]')].find((el) => el.offsetParent !== null)?.click()`);
      const confirmButton = `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Delete')`;
      await until(() => js(`Boolean(${confirmButton})`).then(Boolean), 3000);
      await js(`${confirmButton}?.click()`);
      const gone = await until(async () => !(await host.invoke('logs.connection.get', { id: fresh.id }, { caller: 'ui', workspaceId: ws.id })).ok, 3000);
      const tabsOpen = () => js(`document.querySelectorAll('[data-testid=logs-connection-tab]').length`);
      await until(async () => (await tabsOpen()) === 2, 3000);
      const tabsLeft = await tabsOpen();
      check('ui: logs: deleting a connection from its setup removes it and closes its tab', gone && tabsLeft === 2, { gone, tabsLeft });
    },
  };
}
