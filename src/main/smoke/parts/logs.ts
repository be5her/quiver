import { sign } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { LogsConnectionSummary, LogsDatasource, LogsFieldCount, LogsHistoryEntry, LogsHits, LogsQueryResult, LogsSession } from '@quiver/core';
import { definePart, until } from '../part';

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

    return {
      ui: async (u) => {
        const { js, wait, shot } = u;
        // Logs: the connection signed in above, its entries with level chips and histogram, filters from an entry and from the picker, the setup.
        await js(`document.querySelector('[data-testid=activity-item][data-drag-id=logs]').click()`);
        await wait(600);
        const logsRows = (await js(`[...document.querySelectorAll('[data-testid=logs-connection]')].map((r) => [r.textContent.trim(), r.getAttribute('data-session')])`)) as string[][];
        check('ui: logs: the sidebar lists the connection, signed in', logsRows.length === 1 && logsRows[0]![0]!.includes('VictoriaLogs-Smoke') && logsRows[0]![1] === 'signed-in', logsRows);
        const logsEntries = () => js(`[...document.querySelectorAll('[data-testid=logs-entry]')].map((r) => r.getAttribute('data-level') + ':' + r.textContent.trim())`) as Promise<string[]>;
        await js(`document.querySelector('[data-testid=logs-connection]').click()`);
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
        await js(`document.querySelector('[data-testid=activity-item][data-drag-id=api]').click()`);
        await wait(200);
      },
    };
  },
});
