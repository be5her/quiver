import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { GitStatus, WorkspaceInfo } from '@quiver/core';
import { runToEnd } from '@quiver/core/node';
import { until, type SmokeSection } from '../../part';

// Changed files as a tree (UI checks, with --shots), on a repository of its own in a temporary folder opened as a
// second workspace: files changed under src/a/, src/a/b/, docs/ and the root, and untracked ones under src/a/b/ and
// docs/. View as tree shows folder rows with their counts, src/a/b compacted where it holds the only folder, a folder
// collapsing and expanding on a click and on the keys, Stage all in folder staging exactly its files and Unstage all
// taking them back, Discard in a folder asking first with the count, the preference saved per machine and kept
// through a reload of the window, a commit's files in the History and in a diff tab drawn as a tree, and View as list
// bringing the flat list back.

const section: SmokeSection = async ({ check, run, ws: mainWs }) => ({
  ui: async ({ win, js, wait, shot }) => {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'quiver-smoke-git-tree-'));
    const sh = (...args: string[]) => runToEnd('git', args, { cwd: folder });
    const write = async (rel: string, text: string) => {
      await fs.mkdir(path.dirname(path.join(folder, rel)), { recursive: true });
      await fs.writeFile(path.join(folder, rel), text);
    };
    const visible = (selector: string) => `[...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.offsetParent !== null)`;
    const click = (selector: string) => js(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el?.click(); return Boolean(el); })()`);
    const waitFor = (code: string, ms = 4000) => until(async () => Boolean(await js(code)), ms);
    const group = (g: string) => `[data-testid=git-group][data-group=${g}] + q-git-file-tree`;
    // Folder rows of a group as `path (count)`, and its file rows' paths, in the order drawn.
    const rowsOf = (g: string) =>
      js(
        `(() => { const t = document.querySelector(${JSON.stringify(group(g))}); return t ? [...t.querySelectorAll('[data-tree-row]')].map((r) => r.dataset.testid === 'git-folder' ? r.dataset.path + '/ (' + r.dataset.count + ')' : r.dataset.path) : null; })()`,
      );
    let ws: WorkspaceInfo | undefined;
    try {
      await sh('init', '-q', '-b', 'main');
      await sh('config', 'user.name', 'Smoke');
      await sh('config', 'user.email', 'smoke@quiver.test');
      await sh('config', 'core.autocrlf', 'false');
      await write('.gitignore', '.quiver/\n');
      for (const f of ['src/a/x.ts', 'src/a/b/y.ts', 'docs/guide.md', 'root.txt']) await write(f, 'one\n');
      await sh('add', '.');
      await sh('commit', '-q', '-m', 'Files in folders');
      for (const f of ['src/a/x.ts', 'src/a/b/y.ts', 'docs/guide.md', 'root.txt']) await write(f, 'one\ntwo\n');
      for (const f of ['src/a/b/new1.ts', 'src/a/b/new2.ts', 'docs/new.md']) await write(f, 'new\n');

      ws = await run<WorkspaceInfo>('workspace.open', { path: folder }, null);
      const id = ws.id;
      await waitFor(`Boolean(document.querySelector('[data-testid=workspace-tab][data-drag-id="${id}"]'))`);
      await click(`[data-testid=workspace-tab][data-drag-id="${id}"]`);
      await wait(300);
      await js(`document.documentElement.classList.remove('dark')`);
      await click('[data-testid=activity-item][data-drag-id=git]');
      // Untracked files are listed one by one here (no folder entry), since their folders hold tracked files too.
      const listed = await waitFor(`Boolean(document.querySelector('[data-testid=git-file][data-group=unstaged][data-path="src/a/b/y.ts"]')) && Boolean(document.querySelector('[data-testid=git-file][data-group=untracked][data-path="docs/new.md"]'))`, 6000);
      const listBefore = await rowsOf('unstaged');
      check(
        'git tree: the changes start as a flat list with the View as tree button',
        listed && JSON.stringify(listBefore) === JSON.stringify(['docs/guide.md', 'root.txt', 'src/a/b/y.ts', 'src/a/x.ts']) && (await js(`document.querySelector('[data-testid=git-file-layout]')?.getAttribute('data-layout')`)) === 'list',
        listBefore,
      );

      // View as tree: folders first with their counts; src and a merge into one row, b stays since a also has a file.
      await click('[data-testid=git-sidebar] [data-testid=git-file-layout]');
      await waitFor(`Boolean(document.querySelector('[data-testid=git-folder]'))`);
      const unstaged = await rowsOf('unstaged');
      const untracked = await rowsOf('untracked');
      check(
        'git tree: View as tree shows folder rows with their file counts, folders first',
        JSON.stringify(unstaged) === JSON.stringify(['docs/ (1)', 'docs/guide.md', 'src/a/ (2)', 'src/a/b/ (1)', 'src/a/b/y.ts', 'src/a/x.ts', 'root.txt']),
        unstaged,
      );
      const compactName = await js(`document.querySelector(${JSON.stringify(group('untracked'))})?.querySelector('[data-testid=git-folder][data-path="src/a/b"] [data-testid=git-folder-name]')?.textContent.trim() ?? null`);
      check(
        'git tree: a chain of folders holding one folder each is one row (src/a/b)',
        JSON.stringify(untracked) === JSON.stringify(['docs/ (1)', 'docs/new.md', 'src/a/b/ (2)', 'src/a/b/new1.ts', 'src/a/b/new2.ts']) && compactName === 'src/a/b',
        { untracked, compactName },
      );
      const fileName = await js(`(() => { const r = document.querySelector('[data-testid=git-file][data-group=unstaged][data-path="src/a/x.ts"]'); return r ? [...r.querySelectorAll('span')].map((s) => s.textContent.trim()).filter(Boolean) : null; })()`);
      check('git tree: a file row shows its name and status letter, its folder being the row above', JSON.stringify(fileName) === JSON.stringify(['x.ts', 'M']), fileName);
      await shot('32ta-git-tree-sidebar-light');
      await js(`document.documentElement.classList.add('dark')`);
      await wait(150);
      await shot('32tb-git-tree-sidebar-dark');
      await js(`document.documentElement.classList.remove('dark')`);

      // Collapsing src/a hides everything under it; a second click brings it back.
      const srcA = `${group('unstaged')} [data-testid=git-folder][data-path="src/a"]`;
      await click(srcA);
      await wait(150);
      const collapsed = await rowsOf('unstaged');
      await click(srcA);
      await wait(150);
      const expanded = await rowsOf('unstaged');
      check(
        'git tree: a click on a folder collapses it, hiding its files, and another expands it',
        JSON.stringify(collapsed) === JSON.stringify(['docs/ (1)', 'docs/guide.md', 'src/a/ (2)', 'root.txt']) && JSON.stringify(expanded) === JSON.stringify(unstaged),
        { collapsed, expanded },
      );

      // The keys: left closes the folder, right opens it, down moves to the next row, left on a file goes to its folder.
      const key = (k: string) => js(`document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true }))`);
      const focused = () => js(`(() => { const a = document.activeElement; return a?.dataset?.path ? a.dataset.testid + ':' + a.dataset.path : null; })()`);
      await js(`document.querySelector(${JSON.stringify(srcA)})?.focus()`);
      await key('ArrowLeft');
      await wait(100);
      const leftClosed = (await rowsOf('unstaged')) as string[];
      await key('ArrowRight');
      await wait(100);
      const rightOpened = (await rowsOf('unstaged')) as string[];
      await key('ArrowDown');
      const down = await focused();
      await key('ArrowDown');
      await key('ArrowLeft');
      const parent = await focused();
      check(
        'git tree: left and right close and open a folder, down moves on, left on a file goes to its folder',
        !leftClosed.includes('src/a/x.ts') && rightOpened.includes('src/a/x.ts') && down === 'git-folder:src/a/b' && parent === 'git-folder:src/a/b',
        { leftClosed, rightOpened, down, parent },
      );

      // Stage all in folder stages exactly the files under it.
      await click(`${srcA} [data-testid=git-folder-stage]`);
      const stagedShown = await waitFor(`Boolean(document.querySelector(${JSON.stringify(`${group('staged')} [data-testid=git-folder][data-path="src/a"]`)}))`);
      const afterStage = await run<GitStatus>('git.status', {}, id);
      const stagedPaths = afterStage.files.filter((f) => f.index !== '.' && f.index !== '?').map((f) => f.path).sort();
      check(
        'git tree: Stage all in folder stages exactly the files under it',
        stagedShown && JSON.stringify(stagedPaths) === JSON.stringify(['src/a/b/y.ts', 'src/a/x.ts']) && JSON.stringify(await rowsOf('staged')) === JSON.stringify(['src/a/ (2)', 'src/a/b/ (1)', 'src/a/b/y.ts', 'src/a/x.ts']),
        { stagedPaths, staged: await rowsOf('staged') },
      );
      // Unstage all in folder (b alone) takes back only its file.
      await click(`${group('staged')} [data-testid=git-folder][data-path="src/a/b"] [data-testid=git-folder-unstage]`);
      await waitFor(`!document.querySelector(${JSON.stringify(`${group('staged')} [data-testid=git-file][data-path="src/a/b/y.ts"]`)})`);
      const afterUnstage = await run<GitStatus>('git.status', {}, id);
      const stillStaged = afterUnstage.files.filter((f) => f.index !== '.' && f.index !== '?').map((f) => f.path);
      check('git tree: Unstage all in folder unstages only the files under it', JSON.stringify(stillStaged) === JSON.stringify(['src/a/x.ts']), stillStaged);

      // Discard in a folder asks first, naming how many files and where; Cancel changes nothing.
      await click(`${group('untracked')} [data-testid=git-folder][data-path="src/a/b"] [data-testid=git-folder-discard]`);
      await waitFor(`Boolean(document.querySelector('.fixed.inset-0 h2'))`, 2000);
      const asked = await js(`document.querySelector('.fixed.inset-0 h2')?.textContent.trim() ?? null`);
      await shot('32tc-git-tree-discard-ask-light');
      await js(`[...document.querySelectorAll('.fixed.inset-0 button')].find((b) => b.textContent.trim() === 'Cancel')?.click()`);
      await wait(200);
      const kept = await fs.stat(path.join(folder, 'src/a/b/new1.ts')).then(() => true, () => false);
      check('git tree: Delete all in folder asks first with the count and the folder, and Cancel keeps the files', asked === 'Delete 2 files in src/a/b?' && kept, asked);

      // The layout is kept per machine with the workspace's UI state, and survives a reload of the window.
      const saved = await until(async () => {
        const doc = JSON.parse(await fs.readFile(path.join(folder, '.quiver', 'local', 'state.json'), 'utf8').catch(() => '{}')) as Record<string, unknown>;
        return doc['git.fileLayout'] === 'tree';
      }, 3000);
      await new Promise<void>((resolve) => {
        win.webContents.once('did-finish-load', () => resolve());
        win.webContents.reload();
      });
      await waitFor(`Boolean(document.querySelector('[data-testid=app-ready]'))`, 10000);
      await waitFor(`Boolean(document.querySelector('[data-testid=workspace-tab][data-drag-id="${id}"]'))`, 6000);
      await click(`[data-testid=workspace-tab][data-drag-id="${id}"]`);
      await wait(300);
      await js(`document.documentElement.classList.remove('dark')`);
      if (!(await js(`Boolean(document.querySelector('[data-testid=git-sidebar]'))`))) await click('[data-testid=activity-item][data-drag-id=git]');
      const restored = await waitFor(`document.querySelector('[data-testid=git-sidebar] [data-testid=git-file-layout]')?.getAttribute('data-layout') === 'tree' && Boolean(document.querySelector(${JSON.stringify(`${group('unstaged')} [data-testid=git-folder][data-path="docs"]`)}))`, 8000);
      check('git tree: the tree layout is saved in the workspace state and kept after the window reloads', saved && restored, { saved, restored });

      // A commit's files in the History are a tree too, and so is a diff tab's list.
      await click('[data-testid=git-open-history]');
      const historyTree = await waitFor(`Boolean(${visible('[data-testid=git-history-tab]')}?.querySelector('[data-testid=git-diff-files] [data-testid=git-folder][data-path="src/a"]'))`, 6000);
      const historyRows = await js(
        `(() => { const t = ${visible('[data-testid=git-history-tab]')}?.querySelector('[data-testid=git-diff-files]'); return t ? [...t.querySelectorAll('[data-tree-row]')].map((r) => r.dataset.testid === 'git-folder' ? r.dataset.path + '/ (' + r.dataset.count + ')' : r.dataset.path) : null; })()`,
      );
      check(
        'git tree: the History shows a commit\'s files as a tree',
        historyTree && JSON.stringify(historyRows) === JSON.stringify(['docs/ (1)', 'docs/guide.md', 'src/a/ (2)', 'src/a/b/ (1)', 'src/a/b/y.ts', 'src/a/x.ts', '.gitignore', 'root.txt']),
        historyRows,
      );
      await js(`document.documentElement.classList.add('dark')`);
      await wait(150);
      await shot('32td-git-tree-history-dark');
      await js(`document.documentElement.classList.remove('dark')`);
      await js(`${visible('[data-testid=git-commit-open-tab]')}?.click()`);
      await waitFor(`${visible('[data-testid=git-diff-tab]')}?.getAttribute('data-kind') === 'commit'`, 6000);
      const tabFolder = `${visible('[data-testid=git-diff-tab] [data-testid=git-diff-files] [data-testid=git-folder][data-path="docs"]')}`;
      const tabTree = await waitFor(`Boolean(${tabFolder})`);
      await js(`${tabFolder}?.click()`);
      await wait(150);
      const tabCollapsed = await js(`!${visible('[data-testid=git-diff-tab] [data-testid=git-diff-file][data-path="docs/guide.md"]')}`);
      await js(`${visible('[data-testid=git-diff-tab] [data-testid=git-diff-file][data-path="src/a/x.ts"]')}?.click()`);
      const picked = await waitFor(`${visible('[data-testid=git-diff-tab] [data-testid=git-diff-path]')}?.textContent.trim() === 'src/a/x.ts'`);
      check('git tree: a diff tab lists its files as a tree, a folder collapses there and a file row opens its diff', tabTree && tabCollapsed === true && picked, { tabTree, tabCollapsed, picked });

      // View as list, from the diff tab's own button, brings the flat list back everywhere.
      await js(`${visible('[data-testid=git-diff-tab] [data-testid=git-file-layout]')}?.click()`);
      const flatTab = await waitFor(`!${visible('[data-testid=git-diff-tab] [data-testid=git-folder]')} && Boolean(${visible('[data-testid=git-diff-tab] [data-testid=git-diff-file][data-path="docs/guide.md"]')})`);
      const flatSidebar = await waitFor(`!document.querySelector('[data-testid=git-sidebar] [data-testid=git-folder]')`);
      const listAgain = await rowsOf('unstaged');
      check(
        'git tree: View as list brings back the flat list in the tab and the sidebar',
        flatTab && flatSidebar && JSON.stringify(listAgain) === JSON.stringify(['docs/guide.md', 'root.txt', 'src/a/b/y.ts']),
        listAgain,
      );
    } finally {
      await js(`[...document.querySelectorAll('.fixed.inset-0 button')].find((b) => b.textContent.trim() === 'Cancel')?.click()`).catch(() => {});
      await click(`[data-testid=workspace-tab][data-drag-id="${mainWs.id}"]`);
      await wait(200);
      if (ws) await run('workspace.close', { id: ws.id }, null).catch(() => {});
      await fs.rm(folder, { recursive: true, force: true }).catch(() => {});
    }
  },
});

export default section;
