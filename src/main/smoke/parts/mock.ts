import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { MockCapturedRequest, MockReplayResult, MockRoute, MockServerSummary, WorkspaceInfo } from '@quiver/core';
import { definePart, until } from '../part';

export default definePart({
  name: 'mock',
  summary: 'Mock servers: routes, templates, capture, forward, replay, the webhook receiver, agents over MCP, the UI',
  async run(t) {
    const { host, check, run, ws, folder, hooksFolder, rpc, toolNames: names } = t;
    const { echoPort } = t.fixtures;

    // ---------- mock servers: routes with templates, fallback, capture, wait, hot reload, forward, replay, webhook receiver ----------
    interface WaitOut {
      request: MockCapturedRequest | null;
      timedOut: boolean;
    }
    const mock = await run<MockServerSummary>(
      'mock.server.save',
      {
        server: {
          name: 'smoke mock',
          routes: [
            { id: 'r-user', method: 'GET', path: '/users/:id', status: 200, headers: [{ id: 'h1', key: 'X-Route', value: '{{params.id}}', enabled: true }], body: '{"id":"{{params.id}}","q":"{{query.q}}","rid":"{{$uuid}}"}' },
            { id: 'r-echo', method: 'POST', path: '/echo', status: 201, body: 'hello {{body.name}} via {{headers.x-caller}}' },
            { id: 'r-slow', method: 'ANY', path: '/slow/*', status: 503, delayMs: 300 },
            { id: 'r-off', method: 'GET', path: '/off', enabled: false },
          ],
        },
      },
      ws.id,
    );
    check('mock: server saved with a random five-digit port and route defaults', mock.port >= 10000 && mock.port <= 32767 && !mock.running && mock.routes.length === 4 && mock.routes[2].enabled && mock.routes[1].headers.length === 0, { port: mock.port });
    check('mock: definition committed to the project', (await fs.stat(path.join(folder, '.quiver', 'mock-servers', `${mock.id}.json`))).isFile());
    const mockStarted = await run<MockServerSummary>('mock.server.start', { id: mock.id }, ws.id);
    check('mock: server starts', mockStarted.running && mockStarted.url === `http://127.0.0.1:${mock.port}`, mockStarted.url);
    const base = mockStarted.url!;
    const r1 = await fetch(`${base}/users/42?q=abc`);
    const j1 = (await r1.json()) as { id: string; q: string; rid: string };
    check(
      'mock: route with params, query and dynamic values',
      r1.status === 200 && r1.headers.get('x-route') === '42' && (r1.headers.get('content-type') ?? '').includes('application/json') && j1.id === '42' && j1.q === 'abc' && /^[0-9a-f-]{36}$/.test(j1.rid),
      j1,
    );
    check('mock: cors header on every answer', r1.headers.get('access-control-allow-origin') === '*');
    const r2 = await fetch(`${base}/echo`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-caller': 'smoke' }, body: '{"name":"Ada"}' });
    const t2 = await r2.text();
    check('mock: body and header templates', r2.status === 201 && t2 === 'hello Ada via smoke', t2);
    const slowStart = Date.now();
    const r3 = await fetch(`${base}/slow/a/b`, { method: 'DELETE' });
    check('mock: wildcard route with delay', r3.status === 503 && Date.now() - slowStart >= 280, Date.now() - slowStart);
    const r4 = await fetch(`${base}/off`);
    check('mock: disabled route falls through to the 404 fallback', r4.status === 404);
    const headRes = await fetch(`${base}/users/1`, { method: 'HEAD' });
    check('mock: HEAD matches a GET route without a body', headRes.status === 200 && (await headRes.text()) === '');
    const preflight = await fetch(`${base}/anything`, { method: 'OPTIONS', headers: { origin: 'http://app.local', 'access-control-request-method': 'PUT' } });
    check('mock: preflight answered with the requesting origin', preflight.status === 204 && preflight.headers.get('access-control-allow-origin') === 'http://app.local' && preflight.headers.get('access-control-allow-methods') === 'PUT');
    const mockLog = await run<MockCapturedRequest[]>('mock.request.list', { serverId: mock.id }, ws.id);
    check(
      'mock: every request captured newest first with what was answered',
      mockLog.length === 6 && mockLog[0].outcome === 'preflight' && mockLog[5].routeId === 'r-user' && mockLog[5].query.q === 'abc' && mockLog[4].body === '{"name":"Ada"}' && mockLog[4].response.body === 'hello Ada via smoke' && mockLog[2].outcome === 'fallback',
      mockLog.map((r) => [r.method, r.url, r.outcome, r.response.status]),
    );
    const mockFiltered = await run<MockCapturedRequest[]>('mock.request.list', { serverId: mock.id, method: 'post', path: '/echo' }, ws.id);
    check('mock: list filters by method and path pattern', mockFiltered.length === 1 && mockFiltered[0].routeId === 'r-echo');
    const mockList = await run<MockServerSummary[]>('mock.server.list', {}, ws.id);
    check('mock: list carries running state and request count', mockList.find((s) => s.id === mock.id)?.requestCount === 6 && mockList.find((s) => s.id === mock.id)?.running === true);
    const waiting = run<WaitOut>('mock.request.wait', { serverId: mock.id, timeoutMs: 5000, method: 'PUT', path: '/hooks/:kind' }, ws.id);
    setTimeout(() => void fetch(`${base}/hooks/github?x=1`, { method: 'PUT', body: 'payload' }).catch(() => undefined), 150);
    const waited = await waiting;
    check('mock: wait resolves with the matching request', !waited.timedOut && waited.request?.method === 'PUT' && waited.request.path === '/hooks/github' && waited.request.body === 'payload', waited.request?.url);
    const waitedOut = await run<WaitOut>('mock.request.wait', { serverId: mock.id, timeoutMs: 200, path: '/never' }, ws.id);
    check('mock: wait times out cleanly', waitedOut.timedOut && waitedOut.request === null);
    const routeSaved = await run<{ route: MockRoute; server: MockServerSummary }>('mock.route.save', { serverId: mock.id, route: { id: 'r-user', body: '{"changed":true}' } }, ws.id);
    const r5 = await fetch(`${base}/users/7`);
    check('mock: route update keeps other fields and applies to the running server', routeSaved.route.path === '/users/:id' && routeSaved.route.headers.length === 1 && routeSaved.server.running && ((await r5.json()) as { changed: boolean }).changed === true);
    const renamed = await run<MockServerSummary>('mock.server.save', { server: { id: mock.id, name: 'smoke mock renamed' } }, ws.id);
    check('mock: partial server update keeps routes and port', renamed.name === 'smoke mock renamed' && renamed.routes.length === 4 && renamed.port === mock.port && renamed.running);
    await run('mock.server.save', { server: { id: mock.id, name: 'smoke mock', fallback: { type: 'forward', url: `http://127.0.0.1:${echoPort}/upstream` } } }, ws.id);
    const r6 = await fetch(`${base}/not/mocked?y=2`, { method: 'POST', headers: { 'content-type': 'text/plain', 'x-fwd': '1' }, body: 'fwd-body' });
    const j6 = (await r6.json()) as { url: string; method: string; headers: Record<string, string>; body: string };
    check(
      'mock: unmatched requests forward to the upstream with path, headers and body',
      r6.status === 200 && r6.headers.get('x-echo') === 'yes' && j6.url === '/upstream/not/mocked?y=2' && j6.method === 'POST' && j6.headers['x-fwd'] === '1' && j6.body === 'fwd-body',
      j6,
    );
    const fwdLog = await run<MockCapturedRequest[]>('mock.request.list', { serverId: mock.id, limit: 1 }, ws.id);
    check('mock: forwarded exchange recorded', fwdLog[0].outcome === 'forwarded' && fwdLog[0].response.status === 200 && fwdLog[0].response.body.includes('fwd-body'), fwdLog[0].outcome);
    const r7 = await fetch(`${base}/users/9`);
    check('mock: routes still win over forwarding', r7.status === 200 && r7.headers.get('x-route') === '9');
    await run('mock.server.save', { server: { id: mock.id, fallback: { type: 'forward', url: 'http://127.0.0.1:1' } } }, ws.id);
    const r8 = await fetch(`${base}/down`);
    const j8 = (await r8.json()) as { message?: string };
    check('mock: unreachable upstream yields 502 with the reason', r8.status === 502 && (j8.message ?? '').length > 0, j8);
    const hook = (await run<MockCapturedRequest[]>('mock.request.list', { serverId: mock.id, method: 'PUT' }, ws.id))[0];
    const replayed = await run<MockReplayResult>('mock.request.replay', { serverId: mock.id, requestId: hook.id, url: `http://127.0.0.1:${echoPort}` }, ws.id);
    const jr = JSON.parse(replayed.body) as { method: string; url: string; body: string; headers: Record<string, string> };
    check('mock: replay sends method, path, query and body to another server', replayed.status === 200 && jr.method === 'PUT' && jr.url === '/hooks/github?x=1' && jr.body === 'payload' && !('content-length' in jr.headers && jr.headers['content-length'] !== '7'), jr);
    const gotOne = await run<MockCapturedRequest>('mock.request.get', { serverId: mock.id, id: hook.id }, ws.id);
    check('mock: request.get', gotOne.id === hook.id && gotOne.remoteAddress.length > 0);
    // Webhook receiver in a second workspace: no routes, templated 200 fallback, autostart, log persisted across close and reopen.
    const ws2 = await run<WorkspaceInfo>('workspace.open', { path: hooksFolder }, null);
    const hooks = await run<MockServerSummary>(
      'mock.server.save',
      { server: { name: 'hooks', autoStart: true, fallback: { type: 'respond', status: 200, headers: [], body: '{"ok":true,"got":"{{body.event}}"}' } } },
      ws2.id,
    );
    await run('mock.server.start', { id: hooks.id }, ws2.id);
    const portRecords = host.config.get().mock.ports;
    check(
      'mock: ports of every project are recorded in the global config',
      hooks.port !== mock.port &&
        portRecords.some((r) => r.port === mock.port && r.serverId === mock.id && r.workspace === ws.path) &&
        portRecords.some((r) => r.port === hooks.port && r.serverId === hooks.id && r.workspace === ws2.path && r.name === 'hooks'),
      portRecords,
    );
    const rh = await fetch(`http://127.0.0.1:${hooks.port}/webhooks/stripe`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"event":"invoice.paid"}' });
    check('mock: webhook receiver answers the templated fallback', rh.status === 200 && ((await rh.json()) as { got: string }).got === 'invoice.paid');
    await run('workspace.close', { id: ws2.id }, null);
    const closedFetch = await fetch(`http://127.0.0.1:${hooks.port}/`).catch(() => null);
    check('mock: closing the workspace stops its servers', closedFetch === null);
    const ws2b = await run<WorkspaceInfo>('workspace.open', { path: hooksFolder }, null);
    const hooksAfter = await run<MockServerSummary>('mock.server.get', { id: hooks.id }, ws2b.id);
    check('mock: autostart on workspace open with the persisted request count', hooksAfter.running && hooksAfter.requestCount === 1, { running: hooksAfter.running, count: hooksAfter.requestCount, error: hooksAfter.error });
    const persisted = await run<MockCapturedRequest[]>('mock.request.list', { serverId: hooks.id }, ws2b.id);
    check('mock: persisted request keeps its body', persisted[0]?.body === '{"event":"invoice.paid"}' && persisted[0].outcome === 'fallback');
    const clash = await host.invoke('mock.server.save', { server: { name: 'clash', port: mock.port } }, { caller: 'ui', workspaceId: ws.id });
    check('mock: duplicate port within a workspace is refused', !clash.ok && clash.error.code === 'INVALID_INPUT', clash.ok ? 'ok?' : clash.error.message);
    const busy = await run<MockServerSummary>('mock.server.save', { server: { name: 'busy', port: hooks.port } }, ws.id);
    const busyStart = await host.invoke('mock.server.start', { id: busy.id }, { caller: 'ui', workspaceId: ws.id });
    const busySummary = await run<MockServerSummary>('mock.server.get', { id: busy.id }, ws.id);
    check('mock: starting on a taken port names the other project\'s server and keeps the error on the summary', !busyStart.ok && /already in use by mock server "hooks" in /.test(busyStart.error.message) && /in use/.test(busySummary.error ?? ''), busyStart.ok ? 'ok?' : busyStart.error.message);
    await run('mock.server.delete', { id: busy.id }, ws.id);
    check('mock: deleting a server forgets its port record', !host.config.get().mock.ports.some((r) => r.serverId === busy.id) && host.config.get().mock.ports.some((r) => r.serverId === hooks.id));
    const cleared = await run<{ cleared: number }>('mock.request.clear', { serverId: mock.id }, ws.id);
    check('mock: clear drops the log', cleared.cleared === 11 && (await run<MockCapturedRequest[]>('mock.request.list', { serverId: mock.id }, ws.id)).length === 0, cleared);
    const mockStopped = await run<MockServerSummary>('mock.server.stop', { id: mock.id }, ws.id);
    const stoppedFetch = await fetch(`${base}/users/1`).catch(() => null);
    check('mock: stop releases the port', !mockStopped.running && mockStopped.url === null && stoppedFetch === null);
    // Leave it running with three captured requests for the MCP and UI checks below.
    await run('mock.server.save', { server: { id: mock.id, fallback: { type: 'respond', status: 404, headers: [], body: '{"error":"no mock route matched"}' } } }, ws.id);
    await run('mock.server.start', { id: mock.id }, ws.id);
    await fetch(`${base}/users/1?q=ui`);
    await fetch(`${base}/echo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"Ada"}' });
    await fetch(`${base}/missing`);

    check('mcp lists mock tools', ['mock_server_list', 'mock_server_save', 'mock_route_save', 'mock_request_list', 'mock_request_wait', 'mock_request_replay'].every((n) => names.includes(n)), names.filter((n) => n.startsWith('mock')));
    const mcpMockRequests = await rpc('tools/call', { name: 'mock_request_list', arguments: { serverId: mock.id, limit: 5 } });
    check('mcp reads captured requests', mcpMockRequests.result?.isError !== true && (JSON.parse(mcpMockRequests.result?.content?.[0]?.text ?? '[]') as unknown[]).length === 3, mcpMockRequests.result?.content?.[0]?.text?.slice(0, 120));
    for (const [tool, args] of [
      ['mock_server_delete', { id: mock.id }],
      ['mock_server_stop', { id: mock.id }],
      ['mock_request_clear', { serverId: mock.id }],
    ] as const) {
      const blockedMock = await rpc('tools/call', { name: tool, arguments: args });
      check(`mcp blocks ${tool} by default`, blockedMock.result?.isError === true && (blockedMock.result.content?.[0]?.text ?? '').includes('MUTATION_BLOCKED'));
    }
    const mcpMockRoute = await rpc('tools/call', { name: 'mock_route_save', arguments: { serverId: mock.id, route: { method: 'GET', path: '/from-agent', body: '{"agent":true}' } } });
    const agentRoute = await fetch(`${base}/from-agent`);
    check('mcp can add a mock route that serves immediately', mcpMockRoute.result?.isError !== true && agentRoute.status === 200 && ((await agentRoute.json()) as { agent: boolean }).agent === true, mcpMockRoute.result?.content?.[0]?.text?.slice(0, 120));
    await fetch(`${base}/from-agent`, { method: 'DELETE' });

    return {
      ui: async (u) => {
        const { js, wait, shot } = u;
        // Mock servers module: server rows, route editor, live request list with detail.
        const clickedMock = await js(
          `(() => { const btn = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || b.title || '') === 'Mock servers'); if (btn) btn.click(); return Boolean(btn); })()`,
        );
        check('ui: mock servers module button', clickedMock === true);
        await wait(800);
        const mockRows = await js(`[...document.querySelectorAll('[data-testid=mock-server]')].map((r) => [r.textContent, r.getAttribute('data-running')])`);
        check(
          'ui: server row shows name, port and running state',
          Array.isArray(mockRows) && mockRows.length === 1 && mockRows[0][0].includes('smoke mock') && mockRows[0][0].includes(`:${mock.port}`) && mockRows[0][1] === 'true',
          mockRows,
        );
        const clickedServer = await js(`(() => { const row = document.querySelector('[data-testid=mock-server]'); if (row) row.click(); return Boolean(row); })()`);
        check('ui: server row opens its tab', clickedServer === true);
        await wait(1000);
        const routeItems = await js(`document.querySelectorAll('[data-testid=mock-route-item]').length`);
        check('ui: routes listed in the tab', routeItems === 5, routeItems);
        const clickedRoute = await js(
          `(() => { const el = [...document.querySelectorAll('[data-testid=mock-route-item]')].find((r) => r.textContent.includes('/users/:id')); if (el) el.click(); return Boolean(el); })()`,
        );
        check('ui: route item clickable', clickedRoute === true);
        await wait(500);
        const routePath = await js(`document.querySelector('[data-testid=mock-route-path]')?.value ?? null`);
        check('ui: route editor shows the selected route', routePath === '/users/:id', routePath);
        const shownUrl = await js(`document.querySelector('[data-testid=mock-server-url]')?.textContent ?? ''`);
        check('ui: tab header shows the listening url', shownUrl === base, shownUrl);
        await shot('12-mock-routes-light');
        const clickedRequestsTab = await js(
          `(() => { const btn = [...document.querySelectorAll('[role=tab]')].find((b) => b.textContent.startsWith('Requests')); if (btn) btn.click(); return Boolean(btn); })()`,
        );
        check('ui: requests view tab', clickedRequestsTab === true);
        await wait(1000);
        const requestRows = await js(`[...document.querySelectorAll('[data-testid=mock-request]')].map((r) => r.textContent)`);
        check(
          'ui: captured requests listed newest first',
          Array.isArray(requestRows) && requestRows.length === 5 && requestRows[0].includes('/from-agent') && requestRows[2].includes('/missing') && requestRows[2].includes('404') && requestRows[4].includes('/users/1?q=ui'),
          requestRows,
        );
        await fetch(`${base}/live`, { method: 'PATCH' });
        await wait(900);
        const liveRows = await js(`document.querySelectorAll('[data-testid=mock-request]').length`);
        check('ui: request list updates live', liveRows === 6, liveRows);
        const clickedRequest = await js(
          `(() => { const el = [...document.querySelectorAll('[data-testid=mock-request]')].find((r) => r.textContent.includes('/echo')); if (el) el.click(); return Boolean(el); })()`,
        );
        check('ui: request row clickable', clickedRequest === true);
        await wait(700);
        const detailText = await js(`document.querySelector('[data-testid=mock-request-detail]')?.textContent ?? ''`);
        check('ui: request detail shows method, url, outcome and body', typeof detailText === 'string' && detailText.includes('POST') && detailText.includes('/echo') && detailText.includes('route') && detailText.includes('Ada'), String(detailText).slice(0, 200));
        await shot('13-mock-requests-light');
        await js(`document.documentElement.classList.add('dark')`);
        await wait(300);
        await shot('14-mock-requests-dark');
        await js(`document.documentElement.classList.remove('dark')`);
        await wait(200);

        // A captured request becomes an unsaved route; deleting it again leaves nothing to save. Same for a settings toggle.
        const mockSaveLabel = () => js(`document.querySelector('[data-testid=mock-server-tab] button[title="Ctrl+S"]')?.textContent.trim() ?? ''`);
        const clickMockTab = (label: string) =>
          js(`(() => { const btn = [...document.querySelectorAll('[data-testid=mock-server-tab] [role=tab]')].find((b) => b.textContent.startsWith(${JSON.stringify(label)})); if (btn) btn.click(); return Boolean(btn); })()`);
        await js(`[...document.querySelectorAll('[data-testid=mock-request-detail] button')].find((b) => b.textContent.trim() === 'Route')?.click()`);
        await wait(500);
        const fromRequest = {
          view: await js(`document.querySelector('[data-testid=mock-server-tab] [role=tab][aria-selected=true]')?.textContent ?? ''`),
          path: await js(`document.querySelector('[data-testid=mock-route-path]')?.value ?? null`),
          save: await mockSaveLabel(),
        };
        check('ui: a captured request turns into a selected, unsaved route', fromRequest.view === 'Routes (6)' && fromRequest.path === '/echo' && fromRequest.save === 'Save*', fromRequest);
        await js(`document.querySelector('[data-testid=mock-route-editor] [aria-label="Delete route"]')?.click()`);
        await wait(300);
        const afterDelete = { routes: await js(`document.querySelectorAll('[data-testid=mock-route-item]').length`), save: await mockSaveLabel() };
        check('ui: deleting the new route leaves the server unchanged', afterDelete.routes === 5 && afterDelete.save === 'Save', afterDelete);
        await clickMockTab('Settings');
        await wait(400);
        const toggleCors = () => js(`[...document.querySelectorAll('[data-testid=mock-server-tab] label')].find((l) => l.textContent.includes('Allow browser calls'))?.querySelector('input')?.click()`);
        const settingsPort = await js(`document.querySelector('[data-testid=mock-port]')?.value ?? null`);
        await toggleCors();
        await wait(200);
        const corsToggled = await mockSaveLabel();
        await toggleCors();
        await wait(200);
        const corsRestored = await mockSaveLabel();
        check('ui: settings show the port and a toggle marks the server unsaved until undone', settingsPort === String(mock.port) && corsToggled === 'Save*' && corsRestored === 'Save', { settingsPort, corsToggled, corsRestored });
        await shot('14b-mock-settings-light');
        await clickMockTab('Routes');
        await wait(200);
      },
    };
  },
});
