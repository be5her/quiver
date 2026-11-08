import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { RealtimeConnectionSummary, RealtimeMessage } from '@quiver/core';
import { definePart } from '../part';

export default definePart({
  name: 'realtime',
  summary: 'Realtime: WebSocket and SSE connections, reconnects, agents over MCP, the message log and composer',
  async run(t) {
    const { host, check, run, ws, folder, rpc, toolNames: names } = t;
    const { ssePort, sseSeen: allSseSeen, wsPort, wsSockets } = t.fixtures;
    // Other parts (the API client's streamed responses) use the same SSE server; count only the requests made from here.
    const sseFrom = allSseSeen.length;
    const sseSeenNow = () => allSseSeen.slice(sseFrom);

    // ---------- realtime: WebSocket and SSE connections, send, wait, reconnect, errors ----------
    type RtWait = { message: RealtimeMessage | null; timedOut: boolean };
    const untilMessages = async (id: string, pred: (list: RealtimeMessage[]) => boolean, timeout = 3000): Promise<RealtimeMessage[]> => {
      const deadline = Date.now() + timeout;
      for (;;) {
        const list = await run<RealtimeMessage[]>('realtime.message.list', { id, limit: 200 }, ws.id);
        if (pred(list) || Date.now() > deadline) return list;
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    const wsConn = await run<RealtimeConnectionSummary>(
      'realtime.connection.save',
      {
        connection: {
          name: 'smoke ws',
          kind: 'websocket',
          url: `ws://127.0.0.1:${wsPort}/chat?room={{token}}`,
          protocols: ['quiver.v1', 'other'],
          auth: { type: 'bearer', token: '{{token}}' },
          messages: [{ id: 'm1', name: 'ping', body: 'ping {{token}}' }],
        },
      },
      ws.id,
    );
    check('realtime: connection saved with defaults', wsConn.status === 'disconnected' && wsConn.reconnect && wsConn.logLimit === 500 && wsConn.messageCount === 0, { status: wsConn.status });
    check('realtime: definition committed to the project', (await fs.stat(path.join(folder, '.quiver', 'realtime-connections', `${wsConn.id}.json`))).isFile());
    const wsOpen = await run<RealtimeConnectionSummary>('realtime.connect', { id: wsConn.id }, ws.id);
    check('realtime: websocket opens with the negotiated subprotocol', wsOpen.status === 'open' && wsOpen.protocol === 'quiver.v1' && wsOpen.error === null, { status: wsOpen.status, protocol: wsOpen.protocol, error: wsOpen.error });
    const wsLog1 = await untilMessages(wsConn.id, (l) => l.some((m) => m.direction === 'in'));
    const greeting = wsLog1.find((m) => m.direction === 'in');
    const greetingData = greeting ? (JSON.parse(greeting.data) as { auth: string | null; path: string }) : null;
    check('realtime: handshake carried the resolved auth header and url variables', greetingData?.auth === 'Bearer s3cret' && greetingData.path === '/chat?room=s3cret' && wsLog1[0]?.kind === 'open' && wsLog1[0].direction === 'system', greetingData);
    const echoWait = run<RtWait>('realtime.message.wait', { id: wsConn.id, contains: 'echo:', timeoutMs: 3000 }, ws.id);
    const sentMsg = await run<RealtimeMessage>('realtime.send', { id: wsConn.id, data: 'hello {{token}}' }, ws.id);
    const wsEchoed = await echoWait;
    check('realtime: send resolves variables and wait returns the echo', sentMsg.direction === 'out' && sentMsg.data === 'hello s3cret' && !wsEchoed.timedOut && wsEchoed.message?.data === 'echo:hello s3cret', wsEchoed.message?.data);
    const savedWait = run<RtWait>('realtime.message.wait', { id: wsConn.id, contains: 'echo:ping', timeoutMs: 3000 }, ws.id);
    await run('realtime.send', { id: wsConn.id, messageId: 'm1' }, ws.id);
    check('realtime: saved messages send by id', (await savedWait).message?.data === 'echo:ping s3cret');
    const binWait = run<RtWait>('realtime.message.wait', { id: wsConn.id, timeoutMs: 3000 }, ws.id);
    await run('realtime.send', { id: wsConn.id, data: Buffer.from([1, 2, 3]).toString('base64'), binary: true }, ws.id);
    const bin = (await binWait).message;
    check('realtime: binary frames round-trip as base64', bin?.encoding === 'base64' && Buffer.from(bin.data, 'base64').toString('latin1') === 'bin:\u0001\u0002\u0003' && bin.size === 7, bin);
    const outOnly = await run<RealtimeMessage[]>('realtime.message.list', { id: wsConn.id, direction: 'out' }, ws.id);
    check('realtime: list filters by direction and reads oldest first', outOnly.length === 3 && outOnly[0].data === 'hello s3cret' && outOnly[2].encoding === 'base64', outOnly.map((m) => m.data));
    const reopenWait = run<RtWait>('realtime.message.wait', { id: wsConn.id, direction: 'system', contains: 'Connected', timeoutMs: 8000 }, ws.id);
    await run('realtime.send', { id: wsConn.id, data: 'bye' }, ws.id);
    const reopened = await reopenWait;
    const afterReopen = await run<RealtimeConnectionSummary>('realtime.connection.get', { id: wsConn.id }, ws.id);
    const wsSystem = await run<RealtimeMessage[]>('realtime.message.list', { id: wsConn.id, direction: 'system' }, ws.id);
    check(
      'realtime: a server close reconnects after a second',
      !reopened.timedOut && afterReopen.status === 'open' && wsSystem.some((m) => m.kind === 'close' && m.data.includes('4001')) && wsSystem.some((m) => m.kind === 'info' && m.data.includes('Reconnecting in 1 s')),
      wsSystem.map((m) => m.data),
    );
    const disconnected = await run<RealtimeConnectionSummary>('realtime.disconnect', { id: wsConn.id }, ws.id);
    await new Promise((r) => setTimeout(r, 1300));
    const stillClosed = await run<RealtimeConnectionSummary>('realtime.connection.get', { id: wsConn.id }, ws.id);
    check('realtime: disconnect closes and does not reconnect', disconnected.status === 'disconnected' && stillClosed.status === 'disconnected' && wsSockets.size === 0, { status: stillClosed.status, serverSockets: wsSockets.size });
    const deadConn = await run<RealtimeConnectionSummary>('realtime.connection.save', { connection: { name: 'smoke dead', kind: 'websocket', url: 'ws://127.0.0.1:1/', reconnect: false } }, ws.id);
    const deadOpen = await run<RealtimeConnectionSummary>('realtime.connect', { id: deadConn.id }, ws.id);
    check('realtime: an unreachable websocket reports the failure', deadOpen.status === 'disconnected' && typeof deadOpen.error === 'string' && deadOpen.error.length > 0, deadOpen.error);
    await run('realtime.connection.delete', { id: deadConn.id }, ws.id);
    check('realtime: delete removes the definition', !(await run<RealtimeConnectionSummary[]>('realtime.connection.list', {}, ws.id)).some((c) => c.id === deadConn.id));
    await run('realtime.connection.save', { connection: { id: wsConn.id, url: 'ws://127.0.0.1:{{nope}}/' } }, ws.id);
    const unresolvedRt = await host.invoke('realtime.connect', { id: wsConn.id }, { caller: 'ui', workspaceId: ws.id });
    check('realtime: unresolved variables are reported before connecting', !unresolvedRt.ok && unresolvedRt.error.code === 'UNRESOLVED_VARIABLES');
    const wsRestored = await run<RealtimeConnectionSummary>('realtime.connection.save', { connection: { id: wsConn.id, url: `ws://127.0.0.1:${wsPort}/chat` } }, ws.id);
    check('realtime: partial update keeps the rest of the connection', wsRestored.protocols.length === 2 && wsRestored.messages.length === 1 && wsRestored.auth.type === 'bearer');

    const sseConn = await run<RealtimeConnectionSummary>(
      'realtime.connection.save',
      { connection: { name: 'smoke sse', kind: 'sse', url: `http://127.0.0.1:${ssePort}/events`, headers: [{ id: 'h', key: 'X-Client', value: 'smoke', enabled: true }] } },
      ws.id,
    );
    const resumedWait = run<RtWait>('realtime.message.wait', { id: sseConn.id, event: 'resumed', timeoutMs: 8000 }, ws.id);
    const sseOpen = await run<RealtimeConnectionSummary>('realtime.connect', { id: sseConn.id }, ws.id);
    check('realtime: sse stream opens', sseOpen.status === 'open' && sseOpen.error === null, { status: sseOpen.status, error: sseOpen.error });
    const resumed = await resumedWait;
    const sseLog = await run<RealtimeMessage[]>('realtime.message.list', { id: sseConn.id }, ws.id);
    const tick = sseLog.find((m) => m.event === 'tick');
    const multiLine = sseLog.find((m) => m.eventId === '2');
    check(
      'realtime: sse events carry name, id and multi-line data',
      tick?.eventId === '1' && tick.data === '{"n":1}' && multiLine?.event === 'message' && multiLine.data === 'line one\nline two',
      sseLog.map((m) => [m.kind, m.event, m.eventId, m.data]),
    );
    check('realtime: sse reconnects after the retry hint with Last-Event-ID', !resumed.timedOut && resumed.message?.data === 'after 2' && sseSeenNow().length === 2 && sseSeenNow()[0].lastEventId === null && sseSeenNow()[1].lastEventId === '2', sseSeenNow());
    const sseAfter = await run<RealtimeConnectionSummary>('realtime.connection.get', { id: sseConn.id }, ws.id);
    check('realtime: sse summary tracks the last event id and sent the right headers', sseAfter.status === 'open' && sseAfter.lastEventId === '3' && sseSeenNow()[0].accept.includes('text/event-stream') && sseSeenNow()[0].method === 'GET');
    const sseInfo = sseLog.find((m) => m.kind === 'info');
    check('realtime: sse reconnect used the server retry hint', /Reconnecting in 200 ms/.test(sseInfo?.data ?? ''), sseInfo?.data);
    await run('realtime.disconnect', { id: sseConn.id }, ws.id);
    await run('realtime.connection.save', { connection: { id: sseConn.id, url: `http://127.0.0.1:${ssePort}/echo`, method: 'POST', body: '{"subscribe":"{{token}}"}' } }, ws.id);
    const echoEventWait = run<RtWait>('realtime.message.wait', { id: sseConn.id, event: 'echo', timeoutMs: 5000 }, ws.id);
    await run('realtime.connect', { id: sseConn.id }, ws.id);
    const echoEvent = await echoEventWait;
    check('realtime: sse can POST a body and streams the answer', echoEvent.message?.data === '{"subscribe":"s3cret"}' && sseSeenNow().at(-1)?.method === 'POST', echoEvent.message?.data);
    await run('realtime.disconnect', { id: sseConn.id }, ws.id);
    await run('realtime.connection.save', { connection: { id: sseConn.id, url: `http://127.0.0.1:${ssePort}/missing`, method: 'GET' } }, ws.id);
    const sse404 = await run<RealtimeConnectionSummary>('realtime.connect', { id: sseConn.id }, ws.id);
    check('realtime: a non-2xx stream answer is an error without reconnect', sse404.status === 'disconnected' && /HTTP 404/.test(sse404.error ?? '') && (sse404.error ?? '').includes('no such stream'), sse404.error);
    await run('realtime.connection.save', { connection: { id: sseConn.id, url: `http://127.0.0.1:${ssePort}/plain` } }, ws.id);
    const ssePlain = await run<RealtimeConnectionSummary>('realtime.connect', { id: sseConn.id }, ws.id);
    check('realtime: a wrong content type is reported', ssePlain.status === 'disconnected' && /text\/event-stream/.test(ssePlain.error ?? ''), ssePlain.error);
    const sseCleared = await run<{ cleared: number }>('realtime.message.clear', { id: sseConn.id }, ws.id);
    check('realtime: clear drops the log', sseCleared.cleared > 0 && (await run<RealtimeMessage[]>('realtime.message.list', { id: sseConn.id }, ws.id)).length === 0, sseCleared);
    await run('realtime.connection.save', { connection: { id: sseConn.id, url: `http://127.0.0.1:${ssePort}/events` } }, ws.id);
    // Leave the websocket connected for the MCP and UI checks below.
    await run('realtime.connect', { id: wsConn.id }, ws.id);
    await new Promise((r) => setTimeout(r, 1200));
    check('realtime: message log persisted under .quiver/local', (await fs.readdir(path.join(folder, '.quiver', 'local'))).includes(`realtime-messages-${wsConn.id}.json`));

    check(
      'mcp lists realtime tools',
      ['realtime_connection_list', 'realtime_connect', 'realtime_send', 'realtime_message_wait'].every((n) => names.includes(n)),
      names.filter((n) => n.startsWith('realtime')),
    );
    const mcpWait = rpc('tools/call', { name: 'realtime_message_wait', arguments: { id: wsConn.id, contains: 'echo:agent', timeoutMs: 5000 } });
    const mcpSend = await rpc('tools/call', { name: 'realtime_send', arguments: { id: wsConn.id, data: 'agent' } });
    const mcpWaited = JSON.parse((await mcpWait).result?.content?.[0]?.text ?? '{}') as { message?: RealtimeMessage; timedOut?: boolean };
    check('mcp can send over a websocket and wait for the answer', mcpSend.result?.isError !== true && mcpWaited.message?.data === 'echo:agent', mcpWaited);
    for (const [tool, args] of [
      ['realtime_disconnect', { id: wsConn.id }],
      ['realtime_message_clear', { id: wsConn.id }],
      ['realtime_connection_delete', { id: wsConn.id }],
    ] as const) {
      const blockedRt = await rpc('tools/call', { name: tool, arguments: args });
      check(`mcp blocks ${tool} by default`, blockedRt.result?.isError === true && (blockedRt.result.content?.[0]?.text ?? '').includes('MUTATION_BLOCKED'));
    }

    return {
      ui: async (u) => {
        const { js, wait, shot } = u;
        // Realtime module: connection rows, live message log, composer.
        const clickedRealtime = await js(
          `(() => { const btn = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || b.title || '') === 'Realtime'); if (btn) btn.click(); return Boolean(btn); })()`,
        );
        check('ui: realtime module button', clickedRealtime === true);
        await wait(800);
        const rtRows = await js(`[...document.querySelectorAll('[data-testid=realtime-connection]')].map((r) => [r.textContent, r.getAttribute('data-status')])`);
        check(
          'ui: connection rows show kind, name and status',
          Array.isArray(rtRows) &&
            rtRows.length === 2 &&
            rtRows.some((r: string[]) => r[0].includes('WS') && r[0].includes('smoke ws') && r[1] === 'open') &&
            rtRows.some((r: string[]) => r[0].includes('SSE') && r[0].includes('smoke sse') && r[1] === 'disconnected'),
          rtRows,
        );
        const clickedWsRow = await js(
          `(() => { const row = [...document.querySelectorAll('[data-testid=realtime-connection]')].find((r) => r.textContent.includes('smoke ws')); if (row) row.click(); return Boolean(row); })()`,
        );
        check('ui: websocket row opens its tab', clickedWsRow === true);
        await wait(1000);
        const rtStatus = await js(`document.querySelector('[data-testid=realtime-status]')?.textContent ?? ''`);
        check('ui: tab header shows connected with the subprotocol', typeof rtStatus === 'string' && rtStatus.includes('connected') && rtStatus.includes('quiver.v1'), rtStatus);
        const rtMessages = await js(`[...document.querySelectorAll('[data-testid=realtime-message]')].map((r) => r.getAttribute('data-direction') + ':' + r.textContent)`);
        check(
          'ui: message log lists system, received and sent entries',
          Array.isArray(rtMessages) &&
            rtMessages.length >= 4 &&
            rtMessages.some((t: string) => t.startsWith('system:') && t.includes('Connected')) &&
            rtMessages.some((t: string) => t.startsWith('in:') && t.includes('echo:agent')) &&
            rtMessages.some((t: string) => t.startsWith('out:') && t.includes('agent')),
          Array.isArray(rtMessages) ? rtMessages.slice(-4) : rtMessages,
        );
        for (const socket of wsSockets) socket.send('server push');
        await wait(900);
        const pushed = await js(`[...document.querySelectorAll('[data-testid=realtime-message]')].some((r) => r.textContent.includes('server push'))`);
        check('ui: message log updates live', pushed === true);
        const typed = await js(
          `(() => { const content = document.querySelector('[data-testid=realtime-composer] .cm-content'); if (!content) return false; content.focus(); return document.execCommand('insertText', false, 'from the ui'); })()`,
        );
        check('ui: composer accepts text', typed === true);
        await wait(200);
        const clickedRtSend = await js(`(() => { const btn = document.querySelector('[data-testid=realtime-send]'); if (btn && !btn.disabled) { btn.click(); return true; } return false; })()`);
        check('ui: send button enabled while connected', clickedRtSend === true);
        await wait(900);
        const uiEcho = await js(`[...document.querySelectorAll('[data-testid=realtime-message]')].filter((r) => r.textContent.includes('from the ui')).map((r) => r.getAttribute('data-direction'))`);
        check('ui: sent message and its echo appear', Array.isArray(uiEcho) && uiEcho.includes('out') && uiEcho.includes('in'), uiEcho);
        await shot('15-realtime-light');
        await js(`document.documentElement.classList.add('dark')`);
        await wait(300);
        await shot('16-realtime-dark');
        await js(`document.documentElement.classList.remove('dark')`);
        await wait(200);

        // The composed message is kept as an unsaved saved message; deleting it again leaves nothing to save.
        const rtSaveLabel = () => js(`document.querySelector('[data-testid=realtime-connection-tab] button[title="Ctrl+S"]')?.textContent.trim() ?? ''`);
        const savedItems = () => js(`[...document.querySelectorAll('[data-testid=realtime-connection-tab] .w-56 .overflow-y-auto button')].map((b) => b.textContent.trim())`);
        await js(`[...document.querySelectorAll('[data-testid=realtime-composer] button')].find((b) => b.textContent.trim() === 'Save message')?.click()`);
        await wait(400);
        const kept = {
          view: await js(`document.querySelector('[data-testid=realtime-connection-tab] [role=tab][aria-selected=true]')?.textContent ?? ''`),
          items: await savedItems(),
          firstName: await js(`document.querySelector('[data-testid=realtime-connection-tab] .w-56.border-r + div input')?.value ?? null`),
          save: await rtSaveLabel(),
        };
        check(
          'ui: a composed message joins the saved messages, unsaved, with the first one open',
          kept.view === 'Saved (2)' && JSON.stringify(kept.items) === JSON.stringify(['ping', 'Message 2']) && kept.firstName === 'ping' && kept.save === 'Save*',
          kept,
        );
        await js(`[...document.querySelectorAll('[data-testid=realtime-connection-tab] .w-56 .overflow-y-auto button')].find((b) => b.textContent.trim() === 'Message 2')?.click()`);
        await wait(300);
        const keptBody = await js(`document.querySelector('[data-testid=realtime-connection-tab] .cm-content')?.textContent ?? ''`);
        await js(`document.querySelector('[data-testid=realtime-connection-tab] [aria-label="Delete message"]')?.click()`);
        await wait(300);
        const afterRemove = { items: await savedItems(), save: await rtSaveLabel() };
        check(
          'ui: deleting the kept message leaves the connection unchanged',
          typeof keptBody === 'string' && keptBody.includes('from the ui') && Array.isArray(afterRemove.items) && afterRemove.items.length === 1 && afterRemove.save === 'Save',
          { keptBody, ...afterRemove },
        );
        await js(`[...document.querySelectorAll('[data-testid=realtime-connection-tab] [role=tab]')].find((b) => b.textContent.startsWith('Messages'))?.click()`);
        await wait(200);
      },
    };
  },
});
