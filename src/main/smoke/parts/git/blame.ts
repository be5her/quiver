import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { GitBlame, WorkspaceInfo } from '@quiver/core';
import { runToEnd } from '@quiver/core/node';
import { until, type RpcResult, type SmokeSection } from '../../part';

// Git blame (lane A of docs/plans/git-blame-conflicts-pr-worktrees.md), on a repository of its own in a temporary
// folder: greet.ts written by Ann, changed by Bob, renamed to hello.ts by Carl and reindented by Dee. The host checks
// read the blame in the working tree and at a ref, with whitespace ignored and through .git-blame-ignore-revs, blame
// before a commit across the rename, uncommitted lines, and the refusals; the UI checks open the Blame tab from the
// sidebar, the diff tab, the history and the palette, and use its gutter, Back, the ref field and the whitespace toggle.

const FIRST = ['export function greet(name) {', "  const greeting = 'Hello';", "  return greeting + ', ' + name;", '}', '', 'export const answer = 41;', ''].join('\n');
const SECOND = ['export function greet(name) {', "  const greeting = 'Hi';", "  return greeting + ', ' + name + '!';", '}', '', 'export const answer = 42;', "export const question = 'unknown';", ''].join('\n');
/** Dee's change is whitespace only: line 3 indented further. */
const FOURTH = SECOND.replace("  return greeting + ', ' + name + '!';", "    return greeting + ', ' + name + '!';");

interface Repo {
  sh: (...args: string[]) => ReturnType<typeof runToEnd>;
  /** Ann, Bob, Carl (the rename, no lines) and Dee. */
  c1: string;
  c2: string;
  c3: string;
  c4: string;
}

async function buildRepo(folder: string): Promise<Repo> {
  const sh = (...args: string[]) => runToEnd('git', args, { cwd: folder });
  const commit = async (author: string, date: string, message: string) => {
    await sh('add', '-A');
    await sh('commit', '-q', `--author=${author} <${author.toLowerCase()}@quiver.test>`, `--date=${date}`, '-m', message);
    return (await sh('rev-parse', 'HEAD')).stdout.trim();
  };
  await sh('init', '-q', '-b', 'main');
  await sh('config', 'user.name', 'Smoke');
  await sh('config', 'user.email', 'smoke@quiver.test');
  await sh('config', 'core.autocrlf', 'false');
  // Quiver's own folder appears when the workspace opens; ignored, so the tree starts clean.
  await fs.writeFile(path.join(folder, '.gitignore'), '.quiver/\n');
  await fs.writeFile(path.join(folder, 'greet.ts'), FIRST);
  const c1 = await commit('Ann', '2026-01-01T00:00:00Z', 'Greet by name');
  await fs.writeFile(path.join(folder, 'greet.ts'), SECOND);
  const c2 = await commit('Bob', '2026-02-01T00:00:00Z', 'Say hi and fix the answer');
  await sh('mv', 'greet.ts', 'hello.ts');
  const c3 = await commit('Carl', '2026-03-01T00:00:00Z', 'Rename greet.ts to hello.ts');
  await fs.writeFile(path.join(folder, 'hello.ts'), FOURTH);
  const c4 = await commit('Dee', '2026-04-01T00:00:00Z', 'Reindent');
  return { sh, c1, c2, c3, c4 };
}

const section: SmokeSection = async (t) => {
  const { check, run, mcpPort, ws: mainWs } = t;
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'quiver-smoke-git-blame-'));
  let ws: WorkspaceInfo | undefined;
  /** A call that should fail: its message and `details.reason`, both empty when it went through. */
  const failure = async (input: unknown) => {
    const out = await t.host.invoke('git.blame', input, { caller: 'ui', workspaceId: ws?.id ?? null });
    if (out.ok) return { message: '', reason: undefined };
    return { message: out.error.message, reason: (out.error.details as { reason?: string } | undefined)?.reason };
  };
  try {
    const { sh, c1, c2, c3, c4 } = await buildRepo(folder);
    ws = await run<WorkspaceInfo>('workspace.open', { path: folder }, null);
    const id = ws.id;
    const blame = (input: Record<string, unknown>) => run<GitBlame>('git.blame', input, id);
    const owners = (b: GitBlame) => b.lines.map((l) => l.commit);

    // Each line to the commit that last changed it, each commit listed once, across the rename.
    const now = await blame({ path: 'hello.ts' });
    check(
      'git blame: each line goes to the commit that last changed it, across a rename, and each commit is listed once',
      JSON.stringify(owners(now)) === JSON.stringify([c1, c2, c4, c1, c1, c2, c2]) && Object.keys(now.commits).sort().join() === [c1, c2, c4].sort().join() && !(c3 in now.commits) && now.ref === undefined,
      { owners: owners(now), commits: Object.keys(now.commits) },
    );
    const bob = now.commits[c2];
    check(
      "git blame: a commit has its author, email, time, summary, its path then and previous (the commit before it and the path there)",
      bob?.author === 'Bob' &&
        bob.authorEmail === 'bob@quiver.test' &&
        bob.authorTime === '2026-02-01T00:00:00.000Z' &&
        bob.summary === 'Say hi and fix the answer' &&
        bob.path === 'greet.ts' &&
        bob.previous?.commit === c1 &&
        bob.previous.path === 'greet.ts' &&
        now.commits[c1]?.boundary === true &&
        now.lines[2].text === "    return greeting + ', ' + name + '!';" &&
        now.lines[2].originalLine === 3,
      { bob, line3: now.lines[2], first: now.commits[c1] },
    );

    // Whitespace: -w looks through Dee's reindent; so does .git-blame-ignore-revs naming it.
    const ignored = await blame({ path: 'hello.ts', ignoreWhitespace: true });
    check('git blame: ignoreWhitespace looks through a whitespace-only change', owners(ignored)[2] === c2 && !(c4 in ignored.commits), owners(ignored));
    await fs.writeFile(path.join(folder, '.git-blame-ignore-revs'), `# reformatting\n${c4}\n`);
    const throughFile = await blame({ path: 'hello.ts' });
    await fs.writeFile(path.join(folder, '.git-blame-ignore-revs'), `${'f'.repeat(40)}\n`);
    const brokenFile = await blame({ path: 'hello.ts' }).catch((err: Error) => err);
    await fs.rm(path.join(folder, '.git-blame-ignore-revs'));
    check(
      "git blame: the repository's .git-blame-ignore-revs is honoured, and one naming a commit this clone has not got is left out rather than failing",
      owners(throughFile)[2] === c2 && !(brokenFile instanceof Error) && owners(brokenFile)[2] === c4,
      { throughFile: owners(throughFile), brokenFile: brokenFile instanceof Error ? brokenFile.message : owners(brokenFile) },
    );

    // At a ref, and before a commit: Bob's previous is Ann's greet.ts.
    const atRename = await blame({ path: 'hello.ts', ref: 'HEAD~1' });
    check('git blame: at a ref, the file as it was there', atRename.ref === 'HEAD~1' && JSON.stringify(owners(atRename)) === JSON.stringify([c1, c2, c2, c1, c1, c2, c2]), owners(atRename));
    const before = await blame({ path: bob.previous!.path, ref: bob.previous!.commit });
    check('git blame: blaming the previous commit and path goes back before the commit, past the rename', before.path === 'greet.ts' && owners(before).every((c) => c === c1) && before.lines.length === 6 && before.lines[1].text === "  const greeting = 'Hello';", owners(before));

    // Uncommitted lines in the working tree have no commit.
    await fs.appendFile(path.join(folder, 'hello.ts'), 'export const extra = true;\n');
    const working = await blame({ path: 'hello.ts' });
    const atHead = await blame({ path: 'hello.ts', ref: 'HEAD' });
    check(
      'git blame: a line not committed yet has commit null in the working tree, and is not there at HEAD',
      working.lines.length === 8 && working.lines[7].commit === null && working.lines[7].text === 'export const extra = true;' && !Object.values(working.commits).some((c) => c.author.includes('Not Committed')) && atHead.lines.length === 7,
      working.lines.at(-1),
    );
    await sh('checkout', '--', 'hello.ts');

    // A file name with spaces, and CRLF lines.
    await fs.writeFile(path.join(folder, 'my notes.txt'), 'first\r\nsecond\r\n');
    await sh('add', '--', 'my notes.txt');
    await sh('commit', '-q', '-m', 'Notes');
    const spaced = await blame({ path: 'my notes.txt' });
    check('git blame: a file name with spaces and CRLF lines', spaced.path === 'my notes.txt' && JSON.stringify(spaced.lines.map((l) => l.text)) === JSON.stringify(['first', 'second']), spaced.lines);

    // Refusals: option-like input, outside the repository, a folder, a missing file, binary and over 2 MB.
    await fs.mkdir(path.join(folder, 'sub'));
    await fs.writeFile(path.join(folder, 'sub', 'x.txt'), 'x\n');
    await fs.writeFile(path.join(folder, 'bin.dat'), Buffer.from([1, 0, 2, 0, 3]));
    await sh('add', '-A');
    await sh('commit', '-q', '-m', 'Binary');
    const optionPath = await failure({ path: '--output=owned.txt' });
    const optionRef = await failure({ path: 'hello.ts', ref: '--output=owned.txt' });
    const outside = await failure({ path: '../outside.txt' });
    const folderPath = await failure({ path: 'sub' });
    const missing = await failure({ path: 'gone.txt' });
    const missingAtRef = await failure({ path: 'hello.ts', ref: c1 });
    const outsideAtRef = await failure({ path: '../outside.txt', ref: 'HEAD' });
    await fs.writeFile(path.join(folder, 'new.txt'), 'not added\n');
    const untracked = await failure({ path: 'new.txt' });
    await fs.rm(path.join(folder, 'new.txt'));
    const owned = await fs.stat(path.join(folder, 'owned.txt')).then(() => true, () => false);
    check(
      'git blame: an option-like path or ref, a path outside the repository (also at a ref), a folder, a missing file and an untracked one are refused, and nothing is written',
      Boolean(
        optionPath.message &&
          optionRef.message &&
          outside.message.includes('not a file inside the repository') &&
          outsideAtRef.message.includes('not a file inside the repository') &&
          folderPath.message.includes('folder') &&
          missing.message.includes('not in the working tree') &&
          missingAtRef.message &&
          untracked.reason === 'untracked',
      ) && !owned,
      { optionPath, optionRef, outside, outsideAtRef, folderPath, missing, missingAtRef, untracked, owned },
    );
    const binaryHead = await failure({ path: 'bin.dat', ref: 'HEAD' });
    const binaryWorking = await failure({ path: 'bin.dat' });
    await fs.writeFile(path.join(folder, 'big.txt'), 'x'.repeat(2 * 1024 * 1024 + 10));
    const big = await failure({ path: 'big.txt' });
    // At a ref the committed file is measured, not the working tree's: small on disk, over 2 MB at HEAD.
    await sh('add', '--', 'big.txt');
    await sh('commit', '-q', '-m', 'Big');
    await fs.writeFile(path.join(folder, 'big.txt'), 'small now\n');
    const bigAtRef = await failure({ path: 'big.txt', ref: 'HEAD' });
    const smallNow = await failure({ path: 'big.txt' });
    await sh('rm', '-q', '-f', '--', 'big.txt');
    await sh('commit', '-q', '-m', 'No big');
    check(
      'git blame: a binary file (at a ref and in the working tree) and one over 2 MB (on disk, and at a ref whatever the working tree holds) are refused with a clear reason',
      binaryHead.reason === 'binary' && binaryWorking.reason === 'binary' && big.reason === 'too-large' && big.message.includes('2 MB') && bigAtRef.reason === 'too-large' && smallNow.message === '',
      { binaryHead, binaryWorking, big, bigAtRef, smallNow },
    );

    // Agents may read a blame.
    const res = await fetch(`http://127.0.0.1:${mcpPort}/mcp?workspace=${encodeURIComponent(folder)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'git_blame', arguments: { path: 'hello.ts' } } }),
    });
    const agent = (await res.json()) as RpcResult;
    const text = agent.result?.content?.[0]?.text ?? '';
    check('git blame: agents can call git_blame', agent.result?.isError !== true && text.includes(c4) && text.includes('Reindent'), text.slice(0, 200));
  } finally {
    if (ws) await run('workspace.close', { id: ws.id }, null).catch(() => {});
    await run('workspace.forgetRecent', { path: folder }, null).catch(() => {});
    await fs.rm(folder, { recursive: true, force: true }).catch(() => {});
  }

  return {
    ui: async ({ js, wait, shot }) => {
      const uiFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'quiver-smoke-git-blame-ui-'));
      const setInput = `(el, value) => { const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }`;
      const visible = (selector: string) => `[...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.offsetParent !== null)`;
      const click = (selector: string) => js(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el?.click(); return Boolean(el); })()`);
      const waitFor = (code: string, ms = 5000) => until(async () => Boolean(await js(code)), ms);
      const rightClick = (el: string) =>
        js(`(() => { const el = ${el}; if (!el) return false; const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + r.height / 2 })); return true; })()`);
      const tab = visible('[data-testid=git-blame-tab]');
      /** The gutter markers of the blame tab on screen, one per line (the gutter's hidden spacer left out). */
      const marks = `[...(${tab}?.querySelectorAll('.cm-lineMarker') ?? [])].filter((m) => m.closest('.cm-gutterElement')?.style.visibility !== 'hidden')`;
      /** The blame tab on screen: its path, ref and each gutter marker's text and commit. */
      const state = () =>
        js(
          `(() => { const t = ${tab}; if (!t) return null; return { path: t.getAttribute('data-path'), ref: t.getAttribute('data-ref'), loaded: t.getAttribute('data-loaded') === 'true', markers: [...t.querySelectorAll('.cm-lineMarker')].filter((m) => m.closest('.cm-gutterElement')?.style.visibility !== 'hidden').map((m) => [m.textContent, m.getAttribute('data-id') ?? null]) }; })()`,
        ) as Promise<{ path: string; ref: string; loaded: boolean; markers: [string, string | null][] } | null>;
      const shownAs = (p: string, ref: string, lines: number) =>
        until(async () => {
          const s = await state();
          return s?.path === p && s.ref === ref && s.loaded && s.markers.length === lines;
        }, 6000);
      let uiWs: WorkspaceInfo | undefined;
      try {
        const { c1, c2, c4 } = await buildRepo(uiFolder);
        await fs.appendFile(path.join(uiFolder, 'hello.ts'), 'export const extra = true;\n');
        uiWs = await run<WorkspaceInfo>('workspace.open', { path: uiFolder }, null);
        const id = uiWs.id;
        await waitFor(`Boolean(document.querySelector('[data-testid=workspace-tab][data-drag-id="${id}"]'))`);
        await click(`[data-testid=workspace-tab][data-drag-id="${id}"]`);
        await wait(300);
        await js(`document.documentElement.classList.remove('dark')`);
        await click('[data-testid=activity-item][data-drag-id=git]');
        await click('[data-testid=git-refresh]');
        const row = `[data-testid=git-file][data-group=unstaged][data-path="hello.ts"]`;
        await waitFor(`Boolean(document.querySelector('${row}'))`);

        // From the sidebar's file menu: the working tree, the uncommitted line last, each run labelled once.
        await rightClick(`document.querySelector('${row}')`);
        await waitFor(`Boolean(document.querySelector('[data-testid=git-menu-blame]'))`);
        await click('[data-testid=git-menu-blame]');
        const opened = await shownAs('hello.ts', '', 8);
        const first = await state();
        const short = (h: string) => h.slice(0, 7);
        const ids = first?.markers.map((m) => m[1]);
        const texts = first?.markers.map((m) => m[0]) ?? [];
        check(
          'git blame ui: the sidebar file menu opens Blame with one marker per line, each run labelled once and the uncommitted line last',
          opened &&
            JSON.stringify(ids) === JSON.stringify([c1, c2, c4, c1, c1, c2, c2, null]) &&
            texts[0].startsWith(`${short(c1)} Ann`) &&
            texts[2].startsWith(`${short(c4)} Dee`) &&
            texts[4] === '' &&
            texts[6] === '' &&
            texts[7] === 'Not committed yet',
          first,
        );
        const hover = await js(`(${marks})[1]?.title ?? null`);
        check('git blame ui: hovering a marker shows the summary and the full date', typeof hover === 'string' && hover.includes('Say hi and fix the answer') && hover.includes('Bob <bob@quiver.test>') && hover.includes('2026'), hover);
        await shot('32ba-git-blame-light');

        // Ignore whitespace looks through Dee's reindent, and off again.
        await js(`${tab}?.querySelector('[data-testid=git-blame-whitespace]')?.click()`);
        const looked = await until(async () => (await state())?.markers[2]?.[1] === c2, 5000);
        await js(`${tab}?.querySelector('[data-testid=git-blame-whitespace]')?.click()`);
        const back = await until(async () => (await state())?.markers[2]?.[1] === c4, 5000);
        check('git blame ui: Ignore whitespace gives the reindented line to the commit before it, and off again to the reindent', looked && back);

        // Right-click Bob's line: Blame before this commit goes to Ann's greet.ts; Back returns.
        await rightClick(`(${marks})[1]`);
        await waitFor(`Boolean(document.querySelector('[data-testid=git-blame-menu-before]'))`);
        await click('[data-testid=git-blame-menu-before]');
        const beforeShown = await shownAs('greet.ts', c1, 6);
        const beforeState = await state();
        check('git blame ui: Blame before this commit re-blames at its previous commit, following the rename', beforeShown && beforeState!.markers.every((m) => m[1] === c1), beforeState);
        await js(`document.documentElement.classList.add('dark')`);
        await wait(150);
        await shot('32bb-git-blame-before-dark');
        await js(`document.documentElement.classList.remove('dark')`);
        await js(`${tab}?.querySelector('[data-testid=git-blame-back]')?.click()`);
        const backShown = await shownAs('hello.ts', '', 8);
        check('git blame ui: Back returns to the previous blame', backShown, await state());

        // The ref field: HEAD, without the uncommitted line.
        await js(`(() => { const set = ${setInput}; const el = ${tab}?.querySelector('[data-testid=git-blame-ref]'); set(el, 'HEAD'); el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
        const atHead = await shownAs('hello.ts', 'HEAD', 7);
        check('git blame ui: the ref field blames the file at that ref', atHead && !(await state())!.markers.some((m) => m[0] === 'Not committed yet'), await state());

        // A click on a marker opens the commit in a diff tab, on the file.
        await js(`(${marks})[1]?.click()`);
        const commitTab = await waitFor(`${visible('[data-testid=git-diff-tab]')}?.getAttribute('data-kind') === 'commit' && ${visible('[data-testid=git-diff-tab]')}?.getAttribute('data-path') === 'greet.ts'`, 5000);
        check("git blame ui: clicking a marker opens its commit, on the file's path there", commitTab, await js(`(() => { const t = ${visible('[data-testid=git-diff-tab]')}; return t ? [t.getAttribute('data-kind'), t.getAttribute('data-path')] : null; })()`));

        // The diff tab's Blame button: the working diff of hello.ts blames the working tree.
        await click(row);
        await waitFor(`Boolean(${visible('[data-testid=git-diff-blame]')})`);
        await js(`${visible('[data-testid=git-diff-blame]')}?.click()`);
        const fromDiff = await shownAs('hello.ts', '', 8);
        check('git blame ui: the Blame button of a working diff opens the working tree blame', fromDiff, await state());

        // From the history: the Blame button of a commit's file blames it at that commit.
        await click('[data-testid=git-open-history]');
        await waitFor(`Boolean(${visible('[data-testid=git-history-tab]')}?.querySelector('[data-testid=git-commit-row][data-hash="${c2}"]'))`);
        await js(`${visible('[data-testid=git-history-tab]')}?.querySelector('[data-testid=git-commit-row][data-hash="${c2}"]')?.click()`);
        await waitFor(`${visible('[data-testid=git-commit-detail]')}?.getAttribute('data-hash') === '${c2}' && Boolean(${visible('[data-testid=git-diff-blame]')})`);
        await js(`${visible('[data-testid=git-diff-blame]')}?.click()`);
        const fromHistory = await shownAs('greet.ts', c2, 7);
        check('git blame ui: the history opens Blame of a file at the commit picked', fromHistory, await state());

        // The palette asks for a path; a file gone from the working tree says so.
        await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))`);
        await waitFor(`Boolean(document.querySelector('.palette-input'))`);
        await js(`(() => { const set = ${setInput}; set(document.querySelector('.palette-input'), 'Blame file'); })()`);
        await waitFor(`[...document.querySelectorAll('.palette-item')].some((e) => e.textContent.includes('Blame file'))`);
        await js(`[...document.querySelectorAll('.palette-item')].find((e) => e.textContent.includes('Blame file'))?.click()`);
        await waitFor(`Boolean(document.querySelector('.fixed.inset-0 form input'))`);
        await js(`(() => { const set = ${setInput}; set(document.querySelector('.fixed.inset-0 form input'), 'greet.ts'); document.querySelector('.fixed.inset-0 form button[type=submit]').click(); })()`);
        const paletteError = await waitFor(`${tab}?.getAttribute('data-path') === 'greet.ts' && ${tab}?.getAttribute('data-ref') === '' && (${tab}?.querySelector('[data-testid=git-blame-error]')?.textContent ?? '').includes('not in the working tree')`, 6000);
        check('git blame ui: the palette asks for a path and opens its blame, here saying the file is not in the working tree', paletteError, await js(`${tab}?.querySelector('[data-testid=git-blame-error]')?.textContent ?? null`));
      } finally {
        // A dialog a failed step left open would block every later part.
        await js(`[...document.querySelectorAll('.fixed.inset-0 button')].find((b) => b.textContent.trim() === 'Cancel')?.click()`).catch(() => {});
        await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`).catch(() => {});
        await click(`[data-testid=workspace-tab][data-drag-id="${mainWs.id}"]`);
        await wait(200);
        if (uiWs) await run('workspace.close', { id: uiWs.id }, null).catch(() => {});
        await run('workspace.forgetRecent', { path: uiFolder }, null).catch(() => {});
        await fs.rm(uiFolder, { recursive: true, force: true }).catch(() => {});
      }
    },
  };
};

export default section;
