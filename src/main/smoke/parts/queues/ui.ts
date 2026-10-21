import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { QueueConnection } from '@quiver/core';
import type { SmokeSection } from '../../part';

type Summary = QueueConnection & { secrets: string[] };

// The Queues panel, driven on the in-memory broker: a connection made from the sidebar, a topic created from a
// dialog, a password saved through the secret box, a message produced from the composer and seen in the live tail and
// the peek table, the confirmations before purging and deleting, and the tail stopped when its tab closes.
const section: SmokeSection = async ({ check, run, ws, folder }) => ({
  ui: async ({ js, wait, shot }) => {
    const setInput = `(el, value) => { const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }`;
    const dialogTitle = () => js(`document.querySelector('.fixed.inset-0 h2')?.textContent.trim() ?? null`);
    const dialogButton = (label: string) => js(`(() => { const b = [...document.querySelectorAll('.fixed.inset-0 button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)}); b?.click(); return Boolean(b); })()`);
    /** Fill the open prompt's text and choice, then press its confirm button. */
    const answerPrompt = (text: string, choice: string, confirm: string) =>
      js(
        `(() => { const set = ${setInput}; const form = document.querySelector('.fixed.inset-0 form'); if (!form) return false; set(form.querySelector('input'), ${JSON.stringify(text)}); const sel = form.querySelector('select'); if (sel) set(sel, ${JSON.stringify(choice)}); const b = [...form.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(confirm)}); b?.click(); return Boolean(b); })()`,
      );
    const visibleTab = `[...document.querySelectorAll('[data-testid=queues-destination-tab]')].find((e) => e.offsetParent !== null)`;

    await js(`document.querySelector('[data-testid=activity-item][data-drag-id=queues]').click()`);
    await wait(400);
    check('queues ui: the activity bar opens the Queues sidebar', (await js(`Boolean(document.querySelector('[data-testid=queues-sidebar]'))`)) === true);

    // A memory connection from the sidebar's +, through the name and broker dialog.
    await js(`document.querySelector('[data-testid=queues-new-connection]')?.click()`);
    await wait(300);
    const newTitle = await dialogTitle();
    const answered = await answerPrompt('ui memory', 'memory', 'Create');
    await wait(900);
    const conn = (await run<Summary[]>('queues.connection.list', {}, ws.id)).find((c) => c.name === 'ui memory');
    const onDisk = conn ? await fs.readFile(path.join(folder, '.quiver', 'queues', `${conn.id}.json`), 'utf8').catch(() => '') : '';
    const connTab = await js(
      `(() => { const t = [...document.querySelectorAll('[data-testid=queues-connection-tab]')].find((e) => e.offsetParent !== null); return t ? { kind: t.getAttribute('data-kind'), note: Boolean(t.querySelector('[data-testid=queues-memory-note]')) } : null; })()`,
    );
    check(
      'queues ui: New connection asks for a name and broker, saves it under .quiver/queues and opens its settings',
      newTitle === 'New queue connection' && answered === true && Boolean(conn) && conn?.kind === 'memory' && onDisk.includes('"ui memory"') && JSON.stringify(connTab) === JSON.stringify({ kind: 'memory', note: true }),
      { newTitle, answered, conn: conn?.name, connTab },
    );
    if (!conn) return;
    await js(`[...document.querySelectorAll('[data-testid=queues-connection-tab]')].find((e) => e.offsetParent !== null)?.querySelector('[data-testid=queues-test]')?.click()`);
    await wait(500);
    const tested = await js(`document.querySelector('[data-testid=queues-test-result]')?.getAttribute('data-ok') ?? null`);
    check('queues ui: Test reports the memory broker reachable', tested === 'true', tested);

    // The Kafka form shows its fields and a password box that never shows what is stored.
    await js(`(() => { const set = ${setInput}; const el = document.querySelector('[data-testid=queues-kind]'); if (el) set(el, 'kafka'); })()`);
    await wait(200);
    await js(`(() => { const set = ${setInput}; const el = document.querySelector('[data-testid=queues-sasl]'); if (el) set(el, 'plain'); })()`);
    await wait(200);
    const kafkaForm = await js(
      `({ brokers: Boolean(document.querySelector('[data-testid=queues-brokers]')), secret: document.querySelector('[data-testid=queues-secret]')?.type ?? null, save: document.querySelector('[data-testid=queues-save]')?.textContent.trim() ?? '' })`,
    );
    await shot('30a-queues-kafka-form-light');
    check('queues ui: switching the broker shows its fields, the password as a password box, and marks the tab unsaved', JSON.stringify(kafkaForm) === JSON.stringify({ brokers: true, secret: 'password', save: 'Save*' }), kafkaForm);
    // Back to what was saved: SASL off, then the memory broker.
    await js(`(() => { const set = ${setInput}; set(document.querySelector('[data-testid=queues-sasl]'), 'none'); })()`);
    await wait(150);
    await js(`(() => { const set = ${setInput}; set(document.querySelector('[data-testid=queues-kind]'), 'memory'); })()`);
    await wait(200);
    const clean = await js(`document.querySelector('[data-testid=queues-save]')?.textContent.trim() ?? ''`);
    check('queues ui: putting the fields back leaves nothing to save', clean === 'Save', clean);

    // A password typed in the box goes to host.secrets on save, never into the committed file, and the box clears.
    const setField = (testId: string, value: string) =>
      js(`(() => { const set = ${setInput}; const el = document.querySelector('[data-testid=${testId}]'); if (el) set(el, ${JSON.stringify(value)}); return Boolean(el); })()`);
    const saveButton = () => js(`document.querySelector('[data-testid=queues-save]')?.click()`);
    await setField('queues-kind', 'kafka');
    await wait(150);
    await setField('queues-sasl', 'plain');
    await wait(150);
    const typedSecret = await setField('queues-secret', 'ui-s3cret-pass');
    await wait(150);
    await saveButton();
    await wait(700);
    const withSecret = await run<Summary>('queues.connection.get', { id: conn.id }, ws.id);
    const committed = await fs.readFile(path.join(folder, '.quiver', 'queues', `${conn.id}.json`), 'utf8').catch(() => '');
    const local = await fs.readFile(path.join(folder, '.quiver', 'local', 'queues-secrets.json'), 'utf8').catch(() => '');
    const box = await js(
      `({ value: document.querySelector('[data-testid=queues-secret]')?.value ?? null, state: document.querySelector('[data-testid=queues-secret-state]')?.textContent.trim() ?? null, save: document.querySelector('[data-testid=queues-save]')?.textContent.trim() ?? '' })`,
    );
    check(
      'queues ui: the password box saves to host.secrets (listed by name, encrypted, not in the committed file) and clears',
      typedSecret === true &&
        withSecret.kind === 'kafka' &&
        withSecret.secrets.join() === 'password' &&
        committed.includes('"kafka"') &&
        !committed.includes('ui-s3cret-pass') &&
        local.includes(conn.id) &&
        !local.includes('ui-s3cret-pass') &&
        JSON.stringify(box) === JSON.stringify({ value: '', state: 'Stored on this machine', save: 'Save' }),
      { typedSecret, kind: withSecret.kind, secrets: withSecret.secrets, box },
    );

    // Back to the memory broker: the password it no longer uses is listed, and "Remove on save" drops it.
    await setField('queues-sasl', 'none');
    await wait(150);
    await setField('queues-kind', 'memory');
    await wait(200);
    const unusedText = await js(`document.querySelector('[data-testid=queues-secret-unused]')?.textContent ?? null`);
    await js(`document.querySelector('[data-testid=queues-secret-unused] input[type=checkbox]')?.click()`);
    await wait(150);
    await saveButton();
    await wait(700);
    const withoutSecret = await run<Summary>('queues.connection.get', { id: conn.id }, ws.id);
    const unusedAfter = await js(`Boolean(document.querySelector('[data-testid=queues-secret-unused]'))`);
    check(
      'queues ui: a stored secret the settings no longer use is shown and removed on save',
      typeof unusedText === 'string' && unusedText.includes('password') && withoutSecret.kind === 'memory' && withoutSecret.secrets.length === 0 && unusedAfter === false,
      { unusedText, kind: withoutSecret.kind, secrets: withoutSecret.secrets, unusedAfter },
    );

    // A topic from the connection's + in the sidebar, through the name and partitions dialog.
    const connRow = `[...document.querySelectorAll('[data-testid=queues-connection-row]')].find((r) => r.textContent.includes('ui memory'))`;
    await js(`${connRow}?.querySelector('[data-testid=queues-new-destination]')?.click()`);
    await wait(300);
    const topicTitle = await dialogTitle();
    await answerPrompt('ui-orders', '3', 'Create');
    await wait(900);
    const destTab = await js(`${visibleTab}?.getAttribute('data-destination') ?? null`);
    const info = await js(`${visibleTab}?.querySelector('[data-testid=queues-destination-info]')?.textContent.trim() ?? null`);
    check('queues ui: New topic asks for a name and partitions, creates it and opens it', topicTitle === 'New topic on ui memory' && destTab === 'ui-orders' && typeof info === 'string' && info.includes('0 messages') && info.includes('3 partitions'), { topicTitle, destTab, info });

    // A live tail first, so the message produced next arrives in it.
    await js(`${visibleTab}?.querySelector('[data-testid=queues-view-tail]')?.click()`);
    await wait(200);
    await js(`${visibleTab}?.querySelector('[data-testid=queues-tail-start]')?.click()`);
    await wait(600);
    const tailStatus = await js(`${visibleTab}?.querySelector('[data-testid=queues-tail-status]')?.getAttribute('data-status') ?? null`);
    check('queues ui: Start begins a live tail', tailStatus === 'running', tailStatus);

    // The composer: a key, a header and a JSON body, sent to partition 2.
    await js(`${visibleTab}?.querySelector('[data-testid=queues-view-produce]')?.click()`);
    await wait(400);
    const filled = await js(
      `(() => { const set = ${setInput}; const tab = ${visibleTab}; const key = tab?.querySelector('[data-testid=queues-produce-key]'); const part = tab?.querySelector('[data-testid=queues-produce-partition]'); if (!key || !part) return false; set(key, 'order-1'); set(part, '2'); const body = tab.querySelector('[data-testid=queues-produce-body] .cm-content'); if (!body) return false; body.focus(); return document.execCommand('insertText', false, '{"id":1,"item":"quiver","qty":2}'); })()`,
    );
    await wait(200);
    // A header row: Add row, then its key and value.
    await js(`[...((${visibleTab})?.querySelectorAll('q-key-value-editor button') ?? [])].find((b) => b.textContent.includes('Add row'))?.click()`);
    await wait(200);
    await js(
      `(() => { const set = ${setInput}; const inputs = [...((${visibleTab})?.querySelectorAll('q-key-value-editor input') ?? [])].filter((i) => i.type !== 'checkbox'); if (inputs[0]) set(inputs[0], 'source'); if (inputs[1]) set(inputs[1], 'smoke-ui'); })()`,
    );
    await wait(200);
    await shot('30b-queues-producer-light');
    await js(`${visibleTab}?.querySelector('[data-testid=queues-produce-send]')?.click()`);
    await wait(700);
    const sent = await js(`${visibleTab}?.querySelector('[data-testid=queues-produce-result]')?.textContent.trim() ?? null`);
    const peekedByHost = await run<{ key?: string; partition?: number; headers: Record<string, string>; body: string }[]>('queues.message.peek', { connectionId: conn.id, destination: 'ui-orders' }, ws.id);
    check(
      'queues ui: Send produces the key, header, partition and body',
      filled === true &&
        typeof sent === 'string' &&
        sent.includes('2:0') &&
        peekedByHost.length === 1 &&
        peekedByHost[0].key === 'order-1' &&
        peekedByHost[0].partition === 2 &&
        peekedByHost[0].headers['source'] === 'smoke-ui' &&
        peekedByHost[0].body === '{"id":1,"item":"quiver","qty":2}',
      { filled, sent, peekedByHost },
    );

    // The tail received it while the producer was on screen.
    await js(`${visibleTab}?.querySelector('[data-testid=queues-view-tail]')?.click()`);
    await wait(500);
    const tailRows = await js(`[...(${visibleTab})?.querySelectorAll('[data-testid=queues-tail-list] [data-testid=queues-message]') ?? []].map((r) => r.textContent)`);
    const filterTo = async (text: string) => {
      await js(`(() => { const set = ${setInput}; const el = (${visibleTab})?.querySelector('[data-testid=queues-tail-filter]'); if (el) set(el, ${JSON.stringify(text)}); })()`);
      await wait(200);
      return js(`(${visibleTab})?.querySelectorAll('[data-testid=queues-tail-list] [data-testid=queues-message]').length ?? -1`);
    };
    const missed = await filterTo('nothing-like-this');
    const matched = await filterTo('smoke-ui');
    await shot('30c-queues-tail-light');
    await filterTo('');
    check(
      'queues ui: the live tail shows the message as it arrives, and its filter matches body, key or header',
      Array.isArray(tailRows) && tailRows.length === 1 && String(tailRows[0]).includes('order-1') && String(tailRows[0]).includes('quiver') && missed === 0 && matched === 1,
      { tailRows, missed, matched },
    );

    // The peek table, and the message in full with its body pretty-printed.
    await js(`${visibleTab}?.querySelector('[data-testid=queues-view-messages]')?.click()`);
    await wait(600);
    const peekRows = await js(`[...(${visibleTab})?.querySelectorAll('[data-testid=queues-peek-list] [data-testid=queues-message]') ?? []].map((r) => r.textContent)`);
    await js(`(${visibleTab})?.querySelector('[data-testid=queues-peek-list] [data-testid=queues-message]')?.click()`);
    await wait(400);
    const detail = await js(`(${visibleTab})?.querySelector('[data-testid=queues-message-detail]')?.textContent ?? null`);
    const body = await js(`[...((${visibleTab})?.querySelectorAll('[data-testid=queues-message-body] .cm-line') ?? [])].map((l) => l.textContent)`);
    const count = await js(`[...document.querySelectorAll('[data-testid=queues-destination-row]')].find((r) => r.getAttribute('data-name') === 'ui-orders')?.getAttribute('data-count') ?? null`);
    check(
      'queues ui: peek lists the message with its key and header count, and the detail pretty-prints the JSON body',
      Array.isArray(peekRows) &&
        peekRows.length === 1 &&
        String(peekRows[0]).includes('2:0') &&
        String(peekRows[0]).includes('order-1') &&
        typeof detail === 'string' &&
        detail.includes('source') &&
        detail.includes('smoke-ui') &&
        Array.isArray(body) &&
        body.length >= 5 &&
        body.some((l) => String(l).includes('"item": "quiver"')),
      { peekRows, detail, body },
    );
    check('queues ui: the sidebar lists the topic with its count', count === '1', count);
    await shot('30d-queues-peek-light');
    await js(`document.documentElement.classList.add('dark')`);
    await wait(300);
    await shot('30e-queues-peek-dark');

    // Purge asks first: cancelling keeps the message, confirming empties the topic.
    await js(`${visibleTab}?.querySelector('[data-testid=queues-purge]')?.click()`);
    await wait(300);
    const purgeTitle = await dialogTitle();
    const purgeMessage = await js(`document.querySelector('[data-testid=dialog-message]')?.textContent ?? ''`);
    await shot('30f-queues-purge-confirm-dark');
    await dialogButton('Cancel');
    await wait(300);
    const kept = (await run<unknown[]>('queues.message.peek', { connectionId: conn.id, destination: 'ui-orders' }, ws.id)).length;
    await js(`${visibleTab}?.querySelector('[data-testid=queues-purge]')?.click()`);
    await wait(300);
    await dialogButton('Purge');
    await wait(700);
    const left = (await run<unknown[]>('queues.message.peek', { connectionId: conn.id, destination: 'ui-orders' }, ws.id)).length;
    const shownAfter = await js(`(${visibleTab})?.querySelectorAll('[data-testid=queues-peek-list] [data-testid=queues-message]').length ?? -1`);
    check(
      'queues ui: Purge asks first; Cancel keeps the messages, Purge empties the topic and the table',
      purgeTitle === 'Purge topic "ui-orders"?' && String(purgeMessage).includes('cannot be undone') && kept === 1 && left === 0 && shownAfter === 0,
      { purgeTitle, kept, left, shownAfter },
    );
    await js(`document.documentElement.classList.remove('dark')`);
    await wait(200);

    // Deleting the topic and then the connection both ask first, and close their tabs; the closed tab's tail goes too.
    const tailsBefore = await run<{ destination: string; status: string }[]>('queues.consumer.list', { connectionId: conn.id }, ws.id);
    await js(`${visibleTab}?.querySelector('[data-testid=queues-delete-destination]')?.click()`);
    await wait(300);
    const deleteTitle = await dialogTitle();
    await dialogButton('Delete');
    await wait(700);
    const topicsLeft = await run<{ name: string }[]>('queues.destination.list', { connectionId: conn.id }, ws.id);
    const destTabOpen = await js(`Boolean(document.querySelector('[data-testid=queues-destination-tab]'))`);
    check('queues ui: Delete topic asks first, deletes it and closes its tab', deleteTitle === 'Delete topic "ui-orders"?' && topicsLeft.length === 0 && destTabOpen === false, { deleteTitle, topicsLeft, destTabOpen });
    const tailsAfter = await run<{ destination: string }[]>('queues.consumer.list', { connectionId: conn.id }, ws.id);
    check(
      'queues ui: closing the tab stops its live tail and forgets it on the host',
      tailsBefore.filter((t) => t.destination === 'ui-orders').length === 1 && tailsAfter.filter((t) => t.destination === 'ui-orders').length === 0,
      { tailsBefore, tailsAfter },
    );

    const menuOpened = await js(`(() => { const b = (${connRow})?.querySelector('[data-testid=queues-connection-menu]'); b?.click(); return Boolean(b); })()`);
    await wait(300);
    const menuItem = await js(`(() => { const b = document.querySelector('[data-testid=queues-menu-delete]'); b?.click(); return Boolean(b); })()`);
    await wait(300);
    const connDeleteTitle = await dialogTitle();
    await dialogButton('Delete');
    await wait(700);
    const connsLeft = (await run<Summary[]>('queues.connection.list', {}, ws.id)).filter((c) => c.id === conn.id).length;
    const connTabOpen = await js(`Boolean(document.querySelector('[data-testid=queues-connection-tab]'))`);
    check('queues ui: Delete connection asks first, deletes it and closes its tabs', connDeleteTitle === 'Delete "ui memory"?' && connsLeft === 0 && connTabOpen === false, { menuOpened, menuItem, connDeleteTitle, connsLeft, connTabOpen });
  },
});

export default section;
