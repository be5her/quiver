import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { RunnerTask } from '@quiver/core';
import { freePort, until, type SmokeSection } from '../../part';

// A dev server stand-in for the panel: prints a coloured line, then "ready on <port>" in green once it listens, and
// echoes stdin. Run by Electron's own binary as Node, so the smoke needs no Node on PATH.
const FIXTURE = `
const net = require('net');
const port = Number(process.argv[2]);
console.log('\\u001b[36mstarting\\u001b[39m ui fixture');
net.createServer((s) => s.end()).listen(port, '127.0.0.1', () => console.log('\\u001b[32mready\\u001b[39m on ' + port));
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  for (let i = buf.indexOf('\\n'); i >= 0; i = buf.indexOf('\\n')) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    console.log('echo ' + line);
  }
});
`;

// The Runner panel: a fixture task started from the sidebar turning ready with its coloured output, the port link,
// the status bar's count of running tasks, stdin, search, stop, the settings form saved to the task's file, a
// discovered Makefile target saved as a task, and the confirmation before deleting it.
const section: SmokeSection = async ({ check, run, ws, folder }) => {
  const port = await freePort();
  await fs.writeFile(path.join(folder, 'runner-ui-fixture.cjs'), FIXTURE);
  await fs.writeFile(path.join(folder, 'Makefile'), 'ui-hello:\n\techo hello from make\n');
  const asNode = [{ id: 'n', key: 'ELECTRON_RUN_AS_NODE', value: '1', enabled: true }];
  const task = await run<RunnerTask>('runner.task.save', { task: { name: 'ui server', command: `"${process.execPath}" runner-ui-fixture.cjs ${port}`, env: asNode, readyPattern: 'ready on \\d+', port } }, ws.id);

  return {
    ui: async ({ js, wait, shot }) => {
      const setInput = `(el, value) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }`;
      const row = `document.querySelector('[data-testid=runner-task-row][data-id=${JSON.stringify(task.id)}]')`;
      const tab = `[...document.querySelectorAll('[data-testid=runner-task-tab]')].find((e) => e.offsetParent !== null)`;
      const rowState = () => js(`${row}?.getAttribute('data-state') ?? null`);
      const dialogTitle = () => js(`document.querySelector('.fixed.inset-0 h2')?.textContent.trim() ?? null`);
      const dialogButton = (label: string) => js(`(() => { const b = [...document.querySelectorAll('.fixed.inset-0 button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)}); b?.click(); return Boolean(b); })()`);

      await js(`document.querySelector('[data-testid=activity-item][data-drag-id=runner]').click()`);
      await until(async () => (await rowState()) !== null, 5000);
      check('runner ui: the activity bar opens the Runner sidebar with the saved task, stopped', (await js(`Boolean(document.querySelector('[data-testid=runner-sidebar]'))`)) === true && (await rowState()) === 'stopped', await rowState());

      const statusItem = () => js(`document.querySelector('[data-testid=runner-status-item]')?.getAttribute('data-count') ?? null`);
      check('runner ui: the status bar shows no runner item while no task runs', (await statusItem()) === null, await statusItem());

      // Start from the sidebar: the dot goes through starting to ready once the fixture prints its line.
      await js(`${row}?.querySelector('[data-testid=runner-task-start]')?.click()`);
      const ready = await until(async () => (await rowState()) === 'ready', 15_000);
      const hint = await js(`${row}?.textContent.trim() ?? ''`);
      check('runner ui: Start in the sidebar runs the task and its dot turns ready, with the port as its hint', ready && typeof hint === 'string' && hint.includes(`:${port}`), { state: await rowState(), hint });

      // The status bar counts it; a click there opens the Runner from another module.
      const counted = await until(async () => (await statusItem()) === '1', 5000);
      await js(`document.querySelector('[data-testid=activity-item][data-drag-id=todo]')?.click()`);
      await wait(200);
      const awayFromRunner = await js(`!document.querySelector('[data-testid=runner-sidebar]')`);
      await js(`document.querySelector('[data-testid=runner-status-item]')?.click()`);
      await wait(200);
      const backInRunner = await js(`Boolean(document.querySelector('[data-testid=runner-sidebar]'))`);
      const itemTitle = await js(`document.querySelector('[data-testid=runner-status-item]')?.getAttribute('title') ?? ''`);
      check(
        'runner ui: the status bar says 1 running, names the task in its tooltip, and a click opens the Runner',
        counted && awayFromRunner === true && backInRunner === true && String(itemTitle).includes('ui server: ready'),
        { counted: await statusItem(), awayFromRunner, backInRunner, itemTitle },
      );

      // Its tab: the output with the colour codes drawn, the header facts and the port as a link.
      await js(`${row}?.click()`);
      await until(async () => Boolean(await js(`${tab}?.querySelector('[data-testid=runner-output-line]')`)), 5000);
      await until(async () => String(await js(`${tab}?.querySelector('[data-testid=runner-output]')?.textContent ?? ''`)).includes(`ready on ${port}`), 5000);
      const output = await js(
        `(() => { const t = ${tab}; const lines = [...t.querySelectorAll('[data-testid=runner-output-line]')]; const ready = lines.find((l) => l.textContent.includes('ready on')); return { text: lines.map((l) => l.textContent).join('\\n'), colour: ready?.querySelector('span')?.getAttribute('style') ?? null, escapes: lines.some((l) => l.textContent.includes('\\u001b')), system: lines.some((l) => l.getAttribute('data-stream') === 'system') }; })()`,
      );
      const out = output as { text: string; colour: string | null; escapes: boolean; system: boolean };
      check(
        'runner ui: the task tab shows the output with ANSI colours drawn (no escape codes left) and the runner\'s own lines',
        out.text.includes(`ready on ${port}`) && out.text.includes('starting ui fixture') && Boolean(out.colour?.includes('var(--success)')) && !out.escapes && out.system,
        { colour: out.colour, escapes: out.escapes, system: out.system, text: out.text.slice(0, 300) },
      );
      const header = await js(
        `(() => { const t = ${tab}; return { state: t.getAttribute('data-state'), pid: t.querySelector('[data-testid=runner-tab-pid]')?.textContent.trim() ?? null, uptime: t.querySelector('[data-testid=runner-tab-uptime]')?.textContent.trim() ?? null, link: t.querySelector('[data-testid=runner-port-link]')?.getAttribute('href') ?? null, target: t.querySelector('[data-testid=runner-port-link]')?.getAttribute('target') ?? null }; })()`,
      );
      const h = header as { state: string; pid: string | null; uptime: string | null; link: string | null; target: string | null };
      check(
        'runner ui: the header shows the state, pid and uptime, and the port as a link that opens the system browser',
        h.state === 'ready' && /^\d+$/.test(h.pid ?? '') && /^\d+s$/.test(h.uptime ?? '') && h.link === `http://localhost:${port}` && h.target === '_blank',
        h,
      );

      // stdin: a line typed in the input line reaches the process, which echoes it.
      await js(`(() => { const set = ${setInput}; const el = ${tab}?.querySelector('[data-testid=runner-stdin]'); if (el) set(el, 'hello quiver'); })()`);
      await wait(100);
      await js(`${tab}?.querySelector('[data-testid=runner-stdin-send]')?.click()`);
      const echoed = await until(async () => String(await js(`${tab}?.querySelector('[data-testid=runner-output]')?.textContent ?? ''`)).includes('echo hello quiver'), 5000);
      const cleared = await js(`${tab}?.querySelector('[data-testid=runner-stdin]')?.value ?? null`);
      check('runner ui: the stdin line sends a line to the process and clears', echoed && cleared === '', { echoed, cleared });

      // Search filters the lines; emptying the box shows them all again.
      await js(`(() => { const set = ${setInput}; const el = ${tab}?.querySelector('[data-testid=runner-output-search]'); if (el) set(el, 'ECHO'); })()`);
      await wait(150);
      const searched = await js(`(() => { const t = ${tab}; return { lines: [...t.querySelectorAll('[data-testid=runner-output-line]')].map((l) => l.textContent), count: t.querySelector('[data-testid=runner-output-matches]')?.textContent.trim() ?? null }; })()`);
      const s = searched as { lines: string[]; count: string | null };
      check('runner ui: search keeps the matching lines only, ignoring case, and counts them', s.lines.length === 1 && s.lines[0] === 'echo hello quiver' && Boolean(s.count?.startsWith('1 of ')), s);
      await shot('34a-runner-output-search-light');
      await js(`(() => { const set = ${setInput}; const el = ${tab}?.querySelector('[data-testid=runner-output-search]'); if (el) set(el, ''); })()`);
      await wait(150);
      await js(`document.documentElement.classList.add('dark')`);
      await wait(200);
      await shot('34b-runner-output-dark');

      // Follow: on by default, off when pressed; Clear empties the view only.
      const followed = await js(`${tab}?.querySelector('[data-testid=runner-output-follow]')?.getAttribute('aria-pressed') ?? null`);
      await js(`${tab}?.querySelector('[data-testid=runner-output-follow]')?.click()`);
      await wait(100);
      const unfollowed = await js(`${tab}?.querySelector('[data-testid=runner-output-follow]')?.getAttribute('aria-pressed') ?? null`);
      await js(`${tab}?.querySelector('[data-testid=runner-output-follow]')?.click()`);
      await js(`${tab}?.querySelector('[data-testid=runner-output-clear]')?.click()`);
      await wait(150);
      const afterClear = await js(`${tab}?.querySelectorAll('[data-testid=runner-output-line]').length ?? -1`);
      check('runner ui: Follow toggles and Clear empties the view', followed === 'true' && unfollowed === 'false' && afterClear === 0, { followed, unfollowed, afterClear });

      // Stop from the tab: the run ends as stopped, not crashed, and the sidebar dot follows.
      await js(`${tab}?.querySelector('[data-testid=runner-tab-stop]')?.click()`);
      const stopped = await until(async () => (await rowState()) === 'stopped' && (await js(`${tab}?.getAttribute('data-state') ?? null`)) === 'stopped', 10_000);
      const stdinOff = await js(`${tab}?.querySelector('[data-testid=runner-stdin]')?.disabled ?? null`);
      const stopLine = await js(`${tab}?.querySelector('[data-testid=runner-output]')?.textContent ?? ''`);
      check('runner ui: Stop in the tab stops the task, the dot and header say stopped and stdin turns off', stopped && stdinOff === true, { state: await rowState(), stdinOff, stopLine: String(stopLine).slice(-200) });
      const quiet = await until(async () => (await statusItem()) === null, 3000);
      check('runner ui: the status bar item goes once the task stops', quiet, await statusItem());
      await shot('34c-runner-stopped-dark');
      await js(`document.documentElement.classList.remove('dark')`);

      // The settings form: rename, set the port and clear the pattern; Save writes the task's file.
      await js(`${tab}?.querySelector('[data-testid=runner-view-settings]')?.click()`);
      await wait(200);
      const editorShown = await js(`${tab}?.querySelector('[data-testid=runner-editor]')?.offsetParent !== null`);
      const port2 = port + 1 > 65535 ? port - 1 : port + 1;
      await js(
        `(() => { const set = ${setInput}; const t = ${tab}; set(t.querySelector('[data-testid=runner-edit-name]'), 'ui server edited'); set(t.querySelector('[data-testid=runner-edit-port]'), '${port2}'); set(t.querySelector('[data-testid=runner-edit-ready]'), ''); t.querySelector('[data-testid=runner-edit-autorestart]').click(); })()`,
      );
      await wait(200);
      // Marking the tab unsaved must not switch it back to the output.
      const stillShown = await js(`${tab}?.querySelector('[data-testid=runner-editor]')?.offsetParent !== null`);
      const dirtyLabel = await js(`${tab}?.querySelector('[data-testid=runner-save]')?.textContent.trim() ?? ''`);
      await shot('34d-runner-settings-light');
      await js(`${tab}?.querySelector('[data-testid=runner-save]')?.click()`);
      const readTask = async () => JSON.parse(await fs.readFile(path.join(folder, '.quiver', 'runner', `${task.id}.json`), 'utf8').catch(() => '{}')) as Partial<RunnerTask>;
      await until(async () => (await readTask()).name === 'ui server edited' && (await js(`${tab}?.querySelector('[data-testid=runner-save]')?.textContent.trim() ?? ''`)) === 'Save', 5000);
      const file = JSON.parse(await fs.readFile(path.join(folder, '.quiver', 'runner', `${task.id}.json`), 'utf8').catch(() => '{}')) as Partial<RunnerTask>;
      const savedLabel = await js(`${tab}?.querySelector('[data-testid=runner-save]')?.textContent.trim() ?? ''`);
      const renamed = await js(`${row}?.textContent.includes('ui server edited') ?? false`);
      check(
        'runner ui: the settings form saves name, port, auto restart and a cleared pattern to .quiver/runner/<id>.json',
        editorShown === true && stillShown === true && dirtyLabel === 'Save*' && savedLabel === 'Save' && file.name === 'ui server edited' && file.port === port2 && file.autoRestart === true && file.readyPattern === undefined && file.command === task.command && renamed === true,
        { editorShown, stillShown, dirtyLabel, savedLabel, file, renamed },
      );
      // A port that is no port is refused before it is sent: the form says why, and the name typed with it stays unsaved.
      await js(`(() => { const set = ${setInput}; const t = ${tab}; set(t.querySelector('[data-testid=runner-edit-port]'), '99999'); set(t.querySelector('[data-testid=runner-edit-name]'), 'ui server refused'); })()`);
      await wait(150);
      const problem = await js(`${tab}?.querySelector('[data-testid=runner-edit-problem]')?.textContent.trim() ?? null`);
      await js(`${tab}?.querySelector('[data-testid=runner-save]')?.click()`);
      await wait(400);
      const kept = await readTask();
      await js(`${tab}?.querySelector('[data-testid=runner-revert]')?.click()`);
      check('runner ui: a port out of range is refused by the form and nothing is saved', kept.port === port2 && kept.name === 'ui server edited' && String(problem ?? '').includes('1 to 65535'), { problem, port: kept.port, name: kept.name });

      // Discovered: the Makefile target is listed, and Save as task saves it and marks it.
      const discovered = `document.querySelector('[data-testid=runner-discovered-row][data-source=make][data-name=ui-hello]')`;
      await until(async () => Boolean(await js(discovered)), 5000);
      const listed = await js(`${discovered}?.getAttribute('data-saved') ?? null`);
      await js(`${discovered}?.querySelector('[data-testid=runner-discovered-save]')?.click()`);
      const marked = await until(async () => (await js(`${discovered}?.getAttribute('data-saved') ?? null`)) === 'true', 5000);
      const made = (await run<RunnerTask[]>('runner.task.list', {}, ws.id)).find((t) => t.command === 'make ui-hello');
      check('runner ui: a discovered Makefile target is listed and Save as task saves it (source make) and marks it saved', listed === 'false' && marked && made?.source === 'make' && made.name === 'ui-hello', { listed, marked, made });
      await shot('34e-runner-sidebar-light');

      // Deleting asks first: cancel keeps the task, Delete removes its file and closes its tab.
      // Only on the saved target's own tab, so a wrong tab never deletes another task.
      const onMadeTab = made ? await until(async () => Boolean(await js(`${tab}?.getAttribute('data-id') === ${JSON.stringify(made.id)}`)), 3000) : false;
      if (!onMadeTab) check('runner ui: Save as task opens the saved target\'s tab', false, { made, shown: await js(`${tab}?.getAttribute('data-id') ?? null`) });
      else if (made) {
        await js(`${tab}?.querySelector('[data-testid=runner-delete]')?.click()`);
        await wait(300);
        const title = await dialogTitle();
        await dialogButton('Cancel');
        await wait(300);
        const stays = await fs.stat(path.join(folder, '.quiver', 'runner', `${made.id}.json`)).then(() => true, () => false);
        await js(`${tab}?.querySelector('[data-testid=runner-delete]')?.click()`);
        await wait(300);
        await dialogButton('Delete');
        await wait(700);
        const gone = await fs.stat(path.join(folder, '.quiver', 'runner', `${made.id}.json`)).then(() => false, () => true);
        const tabOpen = await js(`[...document.querySelectorAll('[data-testid=runner-task-tab]')].some((t) => t.getAttribute('data-id') === ${JSON.stringify(made.id)})`);
        check('runner ui: Delete task asks first, then removes its file and closes its tab', title === 'Delete task "ui-hello"?' && stays && gone && tabOpen === false, { title, stays, gone, tabOpen });
      }
    },
    after: async () => {
      await run('runner.task.delete', { id: task.id }, ws.id).catch(() => undefined);
      const left = (await run<RunnerTask[]>('runner.task.list', {}, ws.id).catch(() => [] as RunnerTask[])).filter((t) => t.command === 'make ui-hello');
      for (const t of left) await run('runner.task.delete', { id: t.id }, ws.id).catch(() => undefined);
      await fs.rm(path.join(folder, 'Makefile'), { force: true });
      await fs.rm(path.join(folder, 'runner-ui-fixture.cjs'), { force: true });
    },
  };
};

export default section;
