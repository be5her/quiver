import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { GitBranch, GitCommit, GitFileContent, GitStash, GitStatus, GitWorktree, HostEvents, WorkspaceInfo } from '@quiver/core';
import { runToEnd } from '@quiver/core/node';
import { until, type RpcResult, type SmokeSection } from '../../part';

// Git worktrees, in a repository of its own in a temporary folder whose worktrees go beside it (the default
// `<repo>.worktrees/<branch>`, and folders named by hand): add with a new and an existing branch, the list, the branch
// list's worktreePath, checkout and delete refused with the worktree named, lock and unlock, remove refused for the
// main, the current, an open, a locked and a dirty worktree, prune; then status, stage, commit, stash, a file at the
// index, an operation in progress and the watcher inside a linked worktree opened as a workspace; agents gated. The UI
// check shows the Worktrees section, the New worktree dialog, the Branches tab badge and the status bar marker.

/** Folders compare as git and Windows do: either slash, and case on a drive path. */
const same = (a: string, b: string) => {
  const key = (p: string) => {
    const k = path.resolve(p).replace(/\\/g, '/');
    return /^[a-z]:/i.test(k) ? k.toLowerCase() : k;
  };
  return key(a) === key(b);
};

const exists = (p: string) => fs.stat(p).then(
  () => true,
  () => false,
);

const section: SmokeSection = async (t) => {
  const { check, run, mcpPort } = t;
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'quiver-smoke-git-wt-'));
  const repo = path.join(base, 'repo');
  const sh = (cwd: string, ...args: string[]) => runToEnd('git', args, { cwd });
  const failure = (fn: () => Promise<unknown>) =>
    fn().then(
      () => '',
      (err: Error) => err.message,
    );

  const events: HostEvents['git.changed'][] = [];
  const emit = t.host.emit;
  t.host.emit = ((event, payload) => {
    if (event === 'git.changed') events.push(payload as HostEvents['git.changed']);
    emit.call(t.host, event, payload);
  }) as typeof t.host.emit;

  const opened: WorkspaceInfo[] = [];
  try {
    await fs.mkdir(repo);
    await sh(repo, 'init', '-q', '-b', 'main');
    await sh(repo, 'config', 'user.name', 'Smoke');
    await sh(repo, 'config', 'user.email', 'smoke@quiver.test');
    await sh(repo, 'config', 'core.autocrlf', 'false');
    // Quiver's own folder appears in each worktree opened as a workspace; ignored, so they stay clean.
    await fs.writeFile(path.join(repo, '.gitignore'), '.quiver/\n');
    await fs.writeFile(path.join(repo, 'app.txt'), 'one\n');
    await sh(repo, 'add', '.');
    await sh(repo, 'commit', '-q', '-m', 'First commit');
    await sh(repo, 'branch', 'existing');
    const ws = await run<WorkspaceInfo>('workspace.open', { path: repo }, null);
    opened.push(ws);

    const mainStatus = await run<GitStatus>('git.status', {}, ws.id);
    check('git worktrees: status in the main worktree says it is not linked', mainStatus.worktree?.linked === false && same(mainStatus.worktree.mainPath, repo), mainStatus.worktree);
    // The same folder opened through a junction (a link elsewhere) and, on Windows, with a lower-case drive letter: git
    // gives the git dir by its real path and the common dir as `.git` beside the folder opened, which still compare.
    const link = path.join(base, 'repo-link');
    await fs.symlink(repo, link, 'junction');
    const aliases = [link, ...(process.platform === 'win32' ? [repo.replace(/^[A-Z]:/, (d) => d.toLowerCase())] : [])];
    const aliased: unknown[] = [];
    for (const alias of aliases) {
      const other = await run<WorkspaceInfo>('workspace.open', { path: alias }, null);
      aliased.push((await run<GitStatus>('git.status', { files: false }, other.id)).worktree);
      if (other.id !== ws.id) {
        await run('workspace.close', { id: other.id }, null);
        await run('workspace.forgetRecent', { path: other.path }, null).catch(() => {});
      }
    }
    await fs.unlink(link);
    check('git worktrees: the main worktree opened through a junction or a lower-case drive letter is not taken for a linked one', aliased.every((w) => (w as GitStatus['worktree'])?.linked === false), aliased);
    const alone = await run<GitWorktree[]>('git.worktree.list', {}, ws.id);
    check('git worktrees: a repository alone lists its main worktree, current', alone.length === 1 && alone[0].main && alone[0].current && alone[0].branch === 'main' && same(alone[0].path, repo), alone);

    // Add: a new branch at the default folder beside the repository, and an existing branch in a folder named by hand.
    const wt1 = await run<GitWorktree>('git.worktree.add', { newBranch: 'feat/wt' }, ws.id);
    const wt1Path = path.join(base, 'repo.worktrees', 'feat-wt');
    check(
      'git worktrees: add with a new branch makes it in <repo>.worktrees/<branch> beside the repository',
      same(wt1.path, wt1Path) && wt1.branch === 'feat/wt' && !wt1.main && !wt1.current && (await exists(path.join(wt1Path, 'app.txt'))),
      wt1,
    );
    const wt2 = await run<GitWorktree>('git.worktree.add', { branch: 'existing', path: 'other tree' }, ws.id);
    const wt2Path = path.join(base, 'other tree');
    check('git worktrees: add with an existing branch takes a relative folder from beside the main worktree', same(wt2.path, wt2Path) && wt2.branch === 'existing' && (await exists(path.join(wt2Path, 'app.txt'))), wt2);
    const listed = await run<GitWorktree[]>('git.worktree.list', {}, ws.id);
    check(
      'git worktrees: list gives the main worktree first and the linked ones with their branches',
      listed.length === 3 && listed[0].main && listed[0].current && listed.filter((w) => w.current).length === 1 && listed.some((w) => w.branch === 'feat/wt' && same(w.path, wt1Path)) && listed.some((w) => w.branch === 'existing'),
      listed,
    );
    const branches = await run<GitBranch[]>('git.branch.list', {}, ws.id);
    const byName = (n: string) => branches.find((b) => b.name === n);
    check(
      'git worktrees: branch.list names the worktree of a branch checked out elsewhere, not of the current one',
      same(byName('feat/wt')?.worktreePath ?? '', wt1Path) && same(byName('existing')?.worktreePath ?? '', wt2Path) && byName('main')?.worktreePath === undefined,
      branches.map((b) => [b.name, b.worktreePath]),
    );

    // Git refuses a branch another worktree has; the message names that worktree.
    const checkout = await failure(() => run('git.checkout', { ref: 'feat/wt' }, ws.id));
    const deleted = await failure(() => run('git.branch.delete', { name: 'existing', force: true }, ws.id));
    check(
      'git worktrees: checkout and delete of a branch checked out in another worktree are refused, naming its folder',
      checkout.includes('feat/wt is checked out in the worktree at') && checkout.includes(wt1Path) && deleted.includes('existing is checked out in the worktree at') && deleted.includes(wt2Path),
      { checkout, deleted },
    );
    // Add refuses what would go wrong: a folder inside a worktree, one that is not empty, a branch in use, option-like input.
    await fs.mkdir(path.join(base, 'full'));
    await fs.writeFile(path.join(base, 'full', 'x.txt'), 'x\n');
    const refusals = {
      inside: await failure(() => run('git.worktree.add', { newBranch: 'inside', path: path.join(repo, 'nested') }, ws.id)),
      full: await failure(() => run('git.worktree.add', { newBranch: 'full', path: path.join(base, 'full') }, ws.id)),
      inUse: await failure(() => run('git.worktree.add', { branch: 'feat/wt', path: path.join(base, 'again') }, ws.id)),
      both: await failure(() => run('git.worktree.add', { branch: 'existing', newBranch: 'x' }, ws.id)),
      option: await failure(() => run('git.worktree.add', { newBranch: 'opt', path: '--force' }, ws.id)),
      refspec: await failure(() => run('git.worktree.add', { newBranch: '+x:main' }, ws.id)),
    };
    const leftBranches = (await run<GitBranch[]>('git.branch.list', {}, ws.id)).map((b) => b.name);
    check(
      'git worktrees: add refuses a folder inside a worktree, a folder that is not empty, a branch in use, branch with newBranch, and option-like or refspec input',
      refusals.inside.includes('is inside the worktree') &&
        refusals.full.includes('is not empty') &&
        refusals.inUse.includes('is checked out in the worktree at') &&
        refusals.both.includes('Give one of') &&
        refusals.option.length > 0 &&
        refusals.refspec.includes('not a branch name') &&
        !(await exists(path.join(repo, 'nested'))) &&
        !leftBranches.some((n) => ['inside', 'full', 'opt'].includes(n)),
      refusals,
    );

    // Lock and unlock; a locked worktree is not removed.
    const locked = await run<GitWorktree[]>('git.worktree.lock', { path: wt2Path, reason: 'on a usb disk' }, ws.id);
    const lockedOne = locked.find((w) => same(w.path, wt2Path));
    const removeLocked = await failure(() => run('git.worktree.remove', { path: wt2Path }, ws.id));
    const unlocked = (await run<GitWorktree[]>('git.worktree.unlock', { path: wt2Path }, ws.id)).find((w) => same(w.path, wt2Path));
    const lockMain = await failure(() => run('git.worktree.lock', { path: repo }, ws.id));
    check(
      'git worktrees: lock keeps the reason, a locked worktree is not removed, unlock frees it, and the main one is not locked',
      lockedOne?.locked === true && lockedOne.lockReason === 'on a usb disk' && removeLocked.includes('is locked') && unlocked?.locked === false && lockMain.includes('cannot be locked'),
      { lockedOne, removeLocked, unlocked, lockMain },
    );
    const notOne = await failure(() => run('git.worktree.remove', { path: path.join(base, 'nowhere') }, ws.id));
    const removeMain = await failure(() => run('git.worktree.remove', { path: repo }, ws.id));
    check('git worktrees: remove refuses the main worktree and a folder that is no worktree', removeMain.includes('is the main worktree') && notOne.includes('is not a worktree'), { removeMain, notOne });
    // A dirty worktree goes only with force.
    await fs.writeFile(path.join(wt2Path, 'scratch.txt'), 'unsaved\n');
    const dirty = await failure(() => run('git.worktree.remove', { path: wt2Path }, ws.id));
    const stillThere = await exists(path.join(wt2Path, 'scratch.txt'));
    const afterForce = await run<GitWorktree[]>('git.worktree.remove', { path: wt2Path, force: true }, ws.id);
    check(
      'git worktrees: remove refuses a worktree with changes, then removes it with force, keeping its branch',
      dirty.includes('has changes or untracked files') && stillThere && !afterForce.some((w) => same(w.path, wt2Path)) && !(await exists(wt2Path)) && (await run<GitBranch[]>('git.branch.list', {}, ws.id)).some((b) => b.name === 'existing' && !b.worktreePath),
      { dirty, afterForce },
    );

    // Inside a linked worktree opened as a workspace: status, stage, commit, stash, a file at the index and the operation in progress.
    const linked = await run<WorkspaceInfo>('workspace.open', { path: wt1Path }, null);
    opened.push(linked);
    const linkedStatus = await run<GitStatus>('git.status', {}, linked.id);
    check(
      'git worktrees: status in a linked worktree gives its branch and the main worktree',
      linkedStatus.branch === 'feat/wt' && linkedStatus.worktree?.linked === true && same(linkedStatus.worktree.mainPath, repo) && linkedStatus.files.length === 0,
      linkedStatus,
    );
    const linkedList = await run<GitWorktree[]>('git.worktree.list', {}, linked.id);
    check('git worktrees: list from a linked worktree marks it current, the main one still first', linkedList[0]?.main === true && !linkedList[0].current && linkedList.find((w) => w.current)?.branch === 'feat/wt', linkedList);
    const removeCurrent = await failure(() => run('git.worktree.remove', { path: wt1Path }, linked.id));
    const removeOpen = await failure(() => run('git.worktree.remove', { path: wt1Path }, ws.id));
    check('git worktrees: remove refuses the worktree the workspace is in, and one open as another workspace', removeCurrent.includes('this workspace is in') && removeOpen.includes('is open as the workspace'), { removeCurrent, removeOpen });

    await fs.writeFile(path.join(wt1Path, 'feature.txt'), 'feature\n');
    const staged = await run<GitStatus>('git.stage', { paths: ['feature.txt'] }, linked.id);
    const indexed = await run<GitFileContent>('git.file.show', { path: 'feature.txt', index: true }, linked.id);
    const commit = await run<GitCommit>('git.commit', { message: 'Feature in a worktree' }, linked.id);
    const fromMain = (await run<GitBranch[]>('git.branch.list', {}, ws.id)).find((b) => b.name === 'feat/wt');
    const mainClean = await run<GitStatus>('git.status', {}, ws.id);
    check(
      'git worktrees: stage, the index and commit work in a linked worktree, and the main worktree sees the branch move',
      staged.files.some((f) => f.path === 'feature.txt' && f.index === 'A') && indexed.content === 'feature\n' && fromMain?.head === commit.hash && !mainClean.files.some((f) => f.path === 'feature.txt'),
      { staged: staged.files, indexed, fromMain, main: mainClean.files },
    );
    await fs.writeFile(path.join(wt1Path, 'feature.txt'), 'feature, changed\n');
    await run('git.stash.push', { message: 'linked stash' }, linked.id);
    const stashesLinked = await run<GitStash[]>('git.stash.list', {}, linked.id);
    const stashesMain = await run<GitStash[]>('git.stash.list', {}, ws.id);
    const afterStash = await fs.readFile(path.join(wt1Path, 'feature.txt'), 'utf8');
    await run('git.stash.apply', { index: 0, hash: stashesLinked[0]?.hash, pop: true }, linked.id);
    const afterPop = await fs.readFile(path.join(wt1Path, 'feature.txt'), 'utf8');
    check(
      'git worktrees: a stash pushed in a linked worktree is listed there and in the main one (stashes are shared), and pops back',
      stashesLinked[0]?.message === 'linked stash' && stashesMain[0]?.hash === stashesLinked[0]?.hash && afterStash === 'feature\n' && afterPop === 'feature, changed\n',
      { stashesLinked, afterStash, afterPop },
    );
    await sh(wt1Path, 'checkout', '-q', '--', 'feature.txt');

    // A merge stopped on a conflict in the linked worktree is its own: the main worktree has no operation.
    await sh(repo, 'checkout', '-q', '-b', 'side');
    await fs.writeFile(path.join(repo, 'app.txt'), 'side\n');
    await sh(repo, 'commit', '-q', '-am', 'Side app');
    await sh(repo, 'checkout', '-q', 'main');
    await fs.writeFile(path.join(wt1Path, 'app.txt'), 'feature app\n');
    await sh(wt1Path, 'commit', '-q', '-am', 'Feature app');
    const merge = await run<{ conflicts: string[]; status: GitStatus }>('git.merge', { ref: 'side' }, linked.id);
    const mainDuring = await run<GitStatus>('git.status', {}, ws.id);
    await run('git.operation.abort', {}, linked.id);
    const linkedAfter = await run<GitStatus>('git.status', {}, linked.id);
    check(
      "git worktrees: a merge stopped in a linked worktree shows as its operation, not the main worktree's, and aborts there",
      merge.conflicts.includes('app.txt') && merge.status.operation === 'merge' && !mainDuring.operation && !linkedAfter.operation,
      { conflicts: merge.conflicts, linked: merge.status.operation, main: mainDuring.operation, after: linkedAfter.operation },
    );

    // The watcher: in a linked worktree its own HEAD and index, the shared refs, and the list of worktrees.
    events.length = 0;
    await fs.writeFile(path.join(wt1Path, 'watched.txt'), 'w\n');
    await sh(wt1Path, 'add', 'watched.txt');
    const indexEvent = await until(() => events.some((e) => e.workspaceId === linked.id && e.reason === 'status'), 5000);
    events.length = 0;
    await sh(wt1Path, 'commit', '-q', '-m', 'Watched');
    const commitEvents = await until(() => events.some((e) => e.workspaceId === linked.id && e.reason === 'branches') && events.some((e) => e.workspaceId === ws.id && e.reason === 'branches'), 5000);
    events.length = 0;
    await sh(repo, 'commit', '-q', '--allow-empty', '-m', 'Main moves');
    const mainCommit = await until(() => events.some((e) => e.workspaceId === linked.id && e.reason === 'branches'), 5000);
    check(
      'git worktrees: the watcher of a linked worktree sees its index and commits, and refs moved from the main worktree',
      indexEvent && commitEvents && mainCommit,
      { indexEvent, commitEvents, mainCommit, events },
    );
    events.length = 0;
    const wt3Path = path.join(base, 'from terminal');
    await sh(repo, 'worktree', 'add', '-q', '-b', 'terminal', '--', wt3Path);
    const addedEvent = await until(() => events.some((e) => e.workspaceId === ws.id && e.reason === 'worktrees') && events.some((e) => e.workspaceId === linked.id && e.reason === 'worktrees'), 5000);
    events.length = 0;
    await sh(repo, 'worktree', 'lock', '--', wt3Path);
    const lockEvent = await until(() => events.some((e) => e.workspaceId === ws.id && e.reason === 'worktrees'), 5000);
    await sh(repo, 'worktree', 'unlock', '--', wt3Path);
    check('git worktrees: a worktree added or locked in a terminal emits git.changed worktrees, in the main and the linked workspace', addedEvent && lockEvent, { addedEvent, lockEvent, events });

    // Prune: a worktree whose folder was deleted by hand is prunable, and prune forgets it.
    await fs.rm(wt3Path, { recursive: true, force: true });
    const prunable = (await run<GitWorktree[]>('git.worktree.list', {}, ws.id)).find((w) => same(w.path, wt3Path));
    const pruned = await run<{ pruned: string[]; worktrees: GitWorktree[] }>('git.worktree.prune', {}, ws.id);
    check(
      'git worktrees: a worktree whose folder is gone is prunable, and prune forgets it',
      prunable?.prunable === true && pruned.pruned.length === 1 && !pruned.worktrees.some((w) => same(w.path, wt3Path)) && pruned.worktrees.length === 2,
      { prunable, pruned },
    );
    const revealed = await run<{ revealed: boolean; path: string }>('git.worktree.reveal', { path: wt1Path }, ws.id);
    check('git worktrees: reveal finds the worktree (no file manager in the smoke)', revealed.revealed === false && same(revealed.path, wt1Path), revealed);

    // Agents: the list is open, every change is refused until mutations are allowed.
    const mcpUrl = `http://127.0.0.1:${mcpPort}/mcp?workspace=${encodeURIComponent(repo)}`;
    const rpc = async (name: string, args: unknown): Promise<RpcResult> => {
      const res = await fetch(mcpUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      });
      return (await res.json()) as RpcResult;
    };
    const agentList = await rpc('git_worktree_list', {});
    const agentListed = JSON.parse(agentList.result?.content?.[0]?.text || '[]') as GitWorktree[];
    check('git worktrees: agents can list the worktrees', !agentList.result?.isError && agentListed.length === 2, agentList.result?.content?.[0]?.text?.slice(0, 200));
    for (const [tool, args] of [
      ['git_worktree_add', { newBranch: 'agent' }],
      ['git_worktree_remove', { path: wt1Path, force: true }],
      ['git_worktree_lock', { path: wt1Path }],
      ['git_worktree_unlock', { path: wt1Path }],
      ['git_worktree_prune', {}],
    ] as const) {
      const blocked = await rpc(tool, args);
      check(`git worktrees: ${tool} is gated for agents`, blocked.result?.isError === true && (blocked.result.content?.[0]?.text ?? '').includes('MUTATION_BLOCKED'), blocked.result?.content?.[0]?.text);
    }
    check('git worktrees: the gated calls changed nothing', (await run<GitWorktree[]>('git.worktree.list', {}, ws.id)).length === 2 && !(await exists(path.join(base, 'repo.worktrees', 'agent'))));
    const agentReveal = await rpc('git_worktree_reveal', { path: wt1Path });
    check('git worktrees: agents cannot have a folder opened (reveal is for the UI only)', agentReveal.result?.isError === true || Boolean((agentReveal as { error?: unknown }).error), agentReveal);

    // The last linked worktree removed, git deletes <common>/worktrees; the next one makes it again, and the watcher
    // follows it there: a lock written inside the new folder is seen.
    await run('workspace.close', { id: linked.id }, null);
    await run('workspace.forgetRecent', { path: linked.path }, null).catch(() => {});
    opened.splice(opened.indexOf(linked), 1);
    await run('git.worktree.remove', { path: wt1Path, force: true }, ws.id);
    const dirGone = !(await exists(path.join(repo, '.git', 'worktrees')));
    await new Promise((r) => setTimeout(r, 400));
    events.length = 0;
    const wt4Path = path.join(base, 'later');
    await sh(repo, 'worktree', 'add', '-q', '-b', 'later', '--', wt4Path);
    const reAdded = await until(() => events.some((e) => e.workspaceId === ws.id && e.reason === 'worktrees'), 5000);
    await new Promise((r) => setTimeout(r, 400));
    events.length = 0;
    await sh(repo, 'worktree', 'lock', '--', wt4Path);
    const reLocked = await until(() => events.some((e) => e.workspaceId === ws.id && e.reason === 'worktrees'), 5000);
    check('git worktrees: the watcher drops its watch on worktrees/ when git deletes it, and watches it again when the next worktree makes it', dirGone && reAdded && reLocked, { dirGone, reAdded, reLocked, events });
  } finally {
    t.host.emit = emit;
    for (const w of opened.reverse()) {
      await run('workspace.close', { id: w.id }, null).catch(() => {});
      await run('workspace.forgetRecent', { path: w.path }, null).catch(() => {});
    }
    await fs.rm(base, { recursive: true, force: true }).catch(() => {});
  }

  return {
    ui: async ({ js, wait, shot }) => {
      const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'quiver-smoke-git-wt-ui-'));
      const uiRepo = path.join(folder, 'quiver');
      const setInput = `(el, value) => { const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }`;
      const visible = (selector: string) => `[...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.offsetParent !== null)`;
      const click = (selector: string) => js(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el?.click(); return Boolean(el); })()`);
      const waitFor = (code: string, ms = 4000) => until(async () => Boolean(await js(code)), ms);
      const dialogButton = (label: string) => js(`(() => { const b = [...document.querySelectorAll('.fixed.inset-0 button')].find((e) => e.textContent.trim() === ${JSON.stringify(label)}); b?.click(); return Boolean(b); })()`);
      const ui: WorkspaceInfo[] = [];
      try {
        await fs.mkdir(uiRepo);
        await sh(uiRepo, 'init', '-q', '-b', 'main');
        await sh(uiRepo, 'config', 'user.name', 'Smoke');
        await sh(uiRepo, 'config', 'user.email', 'smoke@quiver.test');
        await sh(uiRepo, 'config', 'core.autocrlf', 'false');
        await fs.writeFile(path.join(uiRepo, '.gitignore'), '.quiver/\n');
        await fs.writeFile(path.join(uiRepo, 'app.txt'), 'one\n');
        await sh(uiRepo, 'add', '.');
        await sh(uiRepo, 'commit', '-q', '-m', 'First commit');
        await sh(uiRepo, 'worktree', 'add', '-q', '-b', 'feat/blame', '--', path.join(folder, 'quiver.worktrees', 'feat-blame'));
        await sh(uiRepo, 'worktree', 'lock', '--reason', 'on a usb disk', '--', path.join(folder, 'quiver.worktrees', 'feat-blame'));
        const ws = await run<WorkspaceInfo>('workspace.open', { path: uiRepo }, null);
        ui.push(ws);
        await waitFor(`Boolean(document.querySelector('[data-testid=workspace-tab][data-drag-id="${ws.id}"]'))`);
        await click(`[data-testid=workspace-tab][data-drag-id="${ws.id}"]`);
        await wait(300);
        await js(`document.documentElement.classList.remove('dark')`);
        await click('[data-testid=activity-item][data-drag-id=git]');
        const rowsOf = () =>
          js(`[...document.querySelectorAll('[data-testid=git-worktree]')].map((r) => [r.getAttribute('data-branch'), r.getAttribute('data-current') === 'true' ? 'current' : '', r.getAttribute('data-locked') === 'true' ? 'locked' : ''].join(':'))`) as Promise<string[]>;
        const shown = await until(async () => JSON.stringify(await rowsOf()) === JSON.stringify(['main:current:', 'feat/blame::locked']), 6000);
        const where = await js(`[...document.querySelectorAll('[data-testid=git-worktree]')].map((r) => r.querySelector('span.text-muted')?.textContent.trim())`);
        check('git worktrees ui: the Worktrees section lists the main worktree, current, and the linked one, locked, with its folder beside the repository', shown, { rows: await rowsOf(), where });
        const marker = await js(`Boolean(document.querySelector('[data-testid=git-status-worktree]'))`);
        check('git worktrees ui: the status bar has no worktree marker in the main worktree', marker === false);
        await js(`document.querySelector('[data-testid=git-worktrees]')?.scrollIntoView()`);
        await wait(150);
        await shot('33a-git-worktrees-section-light');

        // New worktree: the folder follows the branch name.
        await click('[data-testid=git-worktree-new]');
        const dialogShown = await waitFor(`Boolean(document.querySelector('[data-testid=git-worktree-dialog]'))`);
        await js(`(() => { const set = ${setInput}; set(document.querySelector('[data-testid=git-worktree-new-branch]'), 'ui/side'); })()`);
        const expected = path.join(folder, 'quiver.worktrees', 'ui-side');
        const filled = await until(async () => same(String(await js(`document.querySelector('[data-testid=git-worktree-path]')?.value ?? ''`)), expected), 3000);
        check('git worktrees ui: New worktree opens a dialog whose folder follows the new branch name', dialogShown && filled, await js(`document.querySelector('[data-testid=git-worktree-path]')?.value ?? null`));
        await shot('33b-git-worktree-dialog-light');
        await js(`document.documentElement.classList.add('dark')`);
        await wait(150);
        await shot('33c-git-worktree-dialog-dark');
        await js(`document.documentElement.classList.remove('dark')`);
        await click('[data-testid=git-worktree-create]');
        const created = await until(async () => (await rowsOf()).includes('ui/side::') && (await exists(path.join(expected, 'app.txt'))), 8000);
        const closed = await js(`!document.querySelector('[data-testid=git-worktree-dialog]')`);
        check('git worktrees ui: Create worktree makes it, closes the dialog and lists it', created && closed === true, await rowsOf());

        // A branch another worktree has: the sidebar's click offers to open that worktree instead of failing.
        await waitFor(`Boolean(document.querySelector('[data-testid=git-branch][data-name="ui/side"]'))`);
        await click('[data-testid=git-branch][data-name="ui/side"]');
        await wait(300);
        const offerTitle = await js(`document.querySelector('.fixed.inset-0 h2')?.textContent.trim() ?? null`);
        await dialogButton('Cancel');
        check('git worktrees ui: switching to a branch checked out in another worktree offers to open that worktree', offerTitle === 'ui/side is checked out in another worktree', offerTitle);

        // The Branches tab: the badge with the folder, and the worktree items in the menu.
        await click('[data-testid=git-open-branches]');
        const badge = await waitFor(`Boolean(${visible('[data-testid=git-branches-row][data-name="ui/side"] [data-testid=git-branches-worktree]')}) && Boolean(${visible('[data-testid=git-branches-row][data-name="feat/blame"] [data-testid=git-branches-worktree]')})`, 6000);
        const mainBadge = await js(`Boolean(${visible('[data-testid=git-branches-row][data-name="main"] [data-testid=git-branches-worktree]')})`);
        check('git worktrees ui: the Branches tab marks the branches checked out in other worktrees, not the current one', badge && mainBadge === false);
        await js(`(() => { const el = ${visible('[data-testid=git-branches-row][data-name="ui/side"]')}; const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 40, clientY: r.top + r.height / 2 })); })()`);
        const menu = await waitFor(`Boolean(document.querySelector('[data-testid=context-menu] [data-testid=git-menu-open-worktree]')) && Boolean(document.querySelector('[data-testid=context-menu] [data-testid=git-menu-new-worktree]'))`, 2000);
        check('git worktrees ui: a branch in another worktree has Open worktree in its menu, beside New worktree from branch', menu);
        await shot('33d-git-branches-worktree-light');
        await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
        await js(`document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
        await wait(150);

        // Open the new worktree as a workspace: the status bar marks it, naming the main worktree.
        await click('[data-testid=git-worktree][data-branch="ui/side"] [data-testid=git-worktree-open]');
        const linkedOpen = await until(async () => {
          const list = await run<WorkspaceInfo[]>('workspace.list', {}, null);
          const found = list.find((w) => same(w.path, expected));
          if (found && !ui.some((w) => w.id === found.id)) ui.push(found);
          return Boolean(found);
        }, 6000);
        const markerShown = await waitFor(`Boolean(document.querySelector('[data-testid=git-status-worktree]')) && document.querySelector('[data-testid=git-status-item]')?.getAttribute('data-branch') === 'ui/side'`, 6000);
        const markerMain = String(await js(`document.querySelector('[data-testid=git-status-item]')?.getAttribute('data-worktree') ?? ''`));
        check('git worktrees ui: Open as workspace opens the worktree, and the status bar marks it as linked to the main worktree', linkedOpen && markerShown && same(markerMain, uiRepo), { linkedOpen, markerMain });
        await waitFor(`document.querySelector('[data-testid=git-worktree][data-current=true]')?.getAttribute('data-branch') === 'ui/side'`, 4000);
        // The sidebar's branches are the linked worktree's, never the main workspace's list still on screen.
        const currentBranches = () => js(`[...document.querySelectorAll('[data-testid=git-branch][data-current=true]')].map((r) => r.getAttribute('data-name'))`) as Promise<string[]>;
        const sidebarCurrent = await until(async () => JSON.stringify(await currentBranches()) === '["ui/side"]', 4000);
        check('git worktrees ui: in the linked worktree the sidebar marks its own branch current, not the main worktree\'s', sidebarCurrent, await currentBranches());
        await shot('33e-git-worktree-linked-light');

        // Back on the main worktree: close the linked workspace, then remove it from its row after asking.
        await click(`[data-testid=workspace-tab][data-drag-id="${ws.id}"]`);
        await wait(300);
        const linked = ui.find((w) => w.id !== ws.id);
        if (linked) await run('workspace.close', { id: linked.id }, null);
        await waitFor(`Boolean(document.querySelector('[data-testid=git-worktree][data-branch="ui/side"] [data-testid=git-worktree-remove]'))`, 4000);
        await click('[data-testid=git-worktree][data-branch="ui/side"] [data-testid=git-worktree-remove]');
        await wait(250);
        const removeTitle = await js(`document.querySelector('.fixed.inset-0 h2')?.textContent.trim() ?? null`);
        await dialogButton('Remove');
        const removed = await until(async () => !(await rowsOf()).some((r) => r.startsWith('ui/side')) && !(await exists(expected)), 8000);
        check('git worktrees ui: Remove asks first, then deletes the worktree and its folder', removeTitle === 'Remove the worktree ui/side?' && removed, { removeTitle, rows: await rowsOf() });
      } finally {
        await js(`[...document.querySelectorAll('.fixed.inset-0 button')].find((b) => b.textContent.trim() === 'Cancel')?.click()`).catch(() => {});
        await click(`[data-testid=workspace-tab][data-drag-id="${t.ws.id}"]`);
        await wait(200);
        for (const w of ui.reverse()) {
          await run('workspace.close', { id: w.id }, null).catch(() => {});
          await run('workspace.forgetRecent', { path: w.path }, null).catch(() => {});
        }
        await fs.rm(folder, { recursive: true, force: true }).catch(() => {});
      }
    },
  };
};

export default section;
