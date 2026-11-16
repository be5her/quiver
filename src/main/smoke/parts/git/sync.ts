import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { GitBranch, GitBranchSyncItem, GitBranchSyncResult, HostEvents, WorkspaceInfo } from '@quiver/core';
import { runToEnd } from '@quiver/core/node';
import { until, type RpcResult, type SmokeSection } from '../../part';

// Pulling, pushing and syncing branches other than the current one, against a bare repository as the remote and a
// second clone that pushes to it as someone else would. The workspace's branches: feat (current, behind), main and
// stable (behind, not checked out), side (behind, checked out in a linked worktree), diverge (commits on both sides),
// ahead (local commits only), mine (tracks a branch of another name on the remote), gone (its remote branch deleted)
// and nobody (no upstream). Checks the outcome of each, that a branch not checked out moves without touching any file,
// that the current one and the worktree's are fast-forwarded in their folder and refused over uncommitted changes in
// the way, pushes to the upstream's own name, publishing, a rejected push and its force with lease, refusals, events
// and the agent gate. The UI check drives the branch menu and Pull all in the Branches tab.

const section: SmokeSection = async (t) => {
  const { check, run, mcpPort } = t;
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'quiver-smoke-git-sync-')));
  const bare = path.join(base, 'remote.git');
  const repo = path.join(base, 'repo');
  const other = path.join(base, 'other');
  const wt = path.join(base, 'side-wt');
  const sh = async (cwd: string, ...args: string[]) => {
    const r = await runToEnd('git', args, { cwd });
    if (r.code !== 0) throw new Error(`git ${args.join(' ')} in ${cwd}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const failure = (fn: () => Promise<unknown>) =>
    fn().then(
      () => '',
      (err: Error) => err.message,
    );
  const identity = async (cwd: string) => {
    await sh(cwd, 'config', 'user.name', 'Smoke');
    await sh(cwd, 'config', 'user.email', 'smoke@quiver.test');
    await sh(cwd, 'config', 'core.autocrlf', 'false');
  };
  /** A commit in `cwd` changing `file`, on whatever is checked out there. */
  const commitIn = async (cwd: string, file: string, text: string) => {
    await fs.writeFile(path.join(cwd, file), text);
    await sh(cwd, 'add', file);
    await sh(cwd, 'commit', '-q', '-m', `${file}: ${text.trim()}`);
  };
  /** As the other clone: check out `branch`, commit to it and push. */
  const pushFromOther = async (branch: string, file: string, text: string) => {
    await sh(other, 'checkout', '-q', branch);
    await commitIn(other, file, text);
    await sh(other, 'push', '-q', 'origin', branch);
  };
  const rev = (cwd: string, ref: string) => sh(cwd, 'rev-parse', ref);
  const sorted = (o: Record<string, string>) => JSON.stringify(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));

  const events: HostEvents['git.changed'][] = [];
  const emit = t.host.emit;
  t.host.emit = ((event, payload) => {
    if (event === 'git.changed') events.push(payload as HostEvents['git.changed']);
    emit.call(t.host, event, payload);
  }) as typeof t.host.emit;

  let ws: WorkspaceInfo | null = null;
  try {
    await sh(base, 'init', '-q', '--bare', '-b', 'main', bare);
    await fs.mkdir(repo);
    await sh(repo, 'init', '-q', '-b', 'main');
    await identity(repo);
    await fs.writeFile(path.join(repo, '.gitignore'), '.quiver/\n');
    await sh(repo, 'add', '.gitignore');
    await commitIn(repo, 'app.txt', 'one\n');
    await sh(repo, 'remote', 'add', 'origin', bare);
    for (const b of ['stable', 'feat', 'side', 'diverge', 'ahead', 'gone']) await sh(repo, 'branch', b);
    await sh(repo, 'push', '-q', '-u', 'origin', 'main', 'stable', 'feat', 'side', 'diverge', 'ahead', 'gone');
    // mine is pushed under another name and tracks it there.
    await sh(repo, 'branch', 'mine');
    await sh(repo, 'push', '-q', 'origin', 'mine:their-name');
    await sh(repo, 'branch', '--set-upstream-to=origin/their-name', 'mine');
    await sh(repo, 'branch', 'nobody');
    await sh(repo, 'checkout', '-q', 'feat');
    await sh(repo, 'worktree', 'add', '-q', '--', wt, 'side');

    await sh(base, 'clone', '-q', bare, other);
    await identity(other);
    await pushFromOther('main', 'main.txt', 'main 1\n');
    await pushFromOther('main', 'main.txt', 'main 2\n');
    await pushFromOther('stable', 'stable.txt', 'stable 1\n');
    await pushFromOther('feat', 'feat.txt', 'feat 1\n');
    await pushFromOther('side', 'side.txt', 'side 1\n');
    await pushFromOther('diverge', 'diverge.txt', 'theirs\n');
    await sh(other, 'push', '-q', 'origin', '--delete', 'gone');
    // Local commits: diverge has one of its own as well, ahead and mine only theirs.
    for (const [b, file] of [['diverge', 'mine.txt'], ['ahead', 'ahead.txt'], ['mine', 'mine.txt']]) {
      await sh(repo, 'checkout', '-q', b);
      await commitIn(repo, file, `${b} local\n`);
    }
    await sh(repo, 'checkout', '-q', 'feat');

    ws = await run<WorkspaceInfo>('workspace.open', { path: repo }, null);
    await new Promise((r) => setTimeout(r, 400));
    events.length = 0;

    // ---- Pull every branch ----
    const mainBefore = await rev(repo, 'main');
    const pulled = await run<GitBranchSyncResult>('git.branch.pull', {}, ws.id);
    const by = (r: GitBranchSyncResult) => Object.fromEntries(r.branches.map((b) => [b.name, b])) as Record<string, GitBranchSyncItem>;
    const outcomes = Object.fromEntries(pulled.branches.map((b) => [b.name, b.outcome]));
    check(
      'git sync: Pull all fetches once and gives each tracking branch its outcome (nobody tracks nothing and is left out)',
      JSON.stringify(pulled.fetched) === '["origin"]' &&
        sorted(outcomes) === sorted({ main: 'updated', stable: 'updated', feat: 'updated', side: 'updated', diverge: 'diverged', ahead: 'ahead', gone: 'gone', mine: 'ahead' }),
      { fetched: pulled.fetched, outcomes },
    );
    const main = by(pulled).main;
    check(
      'git sync: main, not checked out, is fast-forwarded to origin/main and says by how much',
      (await rev(repo, 'main')) === (await rev(bare, 'main')) && main.from === mainBefore && main.to === (await rev(bare, 'main')) && main.behind === 2 && main.ahead === 0,
      main,
    );
    const repoFiles = (await fs.readdir(repo)).sort();
    check(
      'git sync: moving main and stable touched no file, and feat, the current branch, was fast-forwarded in place',
      !repoFiles.includes('main.txt') && !repoFiles.includes('stable.txt') && repoFiles.includes('feat.txt') && (await sh(repo, 'branch', '--show-current')) === 'feat' && (await sh(repo, 'status', '--porcelain')) === '',
      { repoFiles, status: await sh(repo, 'status', '--porcelain') },
    );
    check(
      'git sync: side, checked out in a linked worktree, was fast-forwarded there with its files',
      (await rev(repo, 'side')) === (await rev(bare, 'side')) && (await fs.readFile(path.join(wt, 'side.txt'), 'utf8').catch(() => '')) === 'side 1\n' && (await sh(wt, 'status', '--porcelain')) === '' && by(pulled).side.worktreePath !== undefined,
      by(pulled).side,
    );
    check(
      'git sync: diverge, with commits on both sides, is neither moved nor merged',
      (await rev(repo, 'diverge')) !== (await rev(bare, 'diverge')) && by(pulled).diverge.ahead === 1 && by(pulled).diverge.behind === 1 && (await sh(repo, 'log', '--format=%s', '-1', 'diverge')) === 'mine.txt: diverge local',
      by(pulled).diverge,
    );
    check('git sync: Pull all announces the branches and the status', events.some((e) => e.workspaceId === ws!.id && e.reason === 'branches') && events.some((e) => e.workspaceId === ws!.id && e.reason === 'status'), events);

    // ---- Uncommitted changes in the way ----
    await pushFromOther('side', 'side.txt', 'side 2\n');
    await fs.writeFile(path.join(wt, 'side.txt'), 'edited in the worktree\n');
    const sideBefore = await rev(repo, 'side');
    const blocked = by(await run<GitBranchSyncResult>('git.branch.pull', { names: ['side'] }, ws.id)).side;
    check(
      'git sync: a fast-forward over uncommitted changes in the worktree is refused with git\'s reason, and they are kept',
      blocked.outcome === 'failed' && /overwritten|local changes/i.test(blocked.message ?? '') && (await rev(repo, 'side')) === sideBefore && (await fs.readFile(path.join(wt, 'side.txt'), 'utf8')) === 'edited in the worktree\n',
      blocked,
    );
    await sh(wt, 'checkout', '--', 'side.txt');

    // ---- Sync: pull, then push ----
    // frommain is made from origin/main, as `git checkout -b frommain origin/main` does, and tracks it.
    await sh(repo, 'branch', '--track', 'frommain', 'origin/main');
    await sh(repo, 'checkout', '-q', 'frommain');
    await commitIn(repo, 'frommain.txt', 'from main\n');
    await sh(repo, 'checkout', '-q', 'feat');
    const bareMain = await rev(bare, 'main');
    const synced = by(await run<GitBranchSyncResult>('git.branch.sync', { names: ['ahead', 'mine', 'frommain', 'stable', 'diverge'] }, ws.id));
    check(
      'git sync: Sync pushes a branch that is only ahead to where git push would send it',
      synced.ahead.outcome === 'pushed' && synced.ahead.pushTarget === 'origin/ahead' && (await rev(bare, 'ahead')) === (await rev(repo, 'ahead')),
      synced.ahead,
    );
    check(
      'git sync: a branch made from origin/main, or tracking another name, is never pushed there; it is ahead with a message',
      synced.frommain.outcome === 'ahead' &&
        /another name/.test(synced.frommain.message ?? '') &&
        (await rev(bare, 'main')) === bareMain &&
        synced.mine.outcome === 'ahead' &&
        (await rev(bare, 'their-name')) !== (await rev(repo, 'mine')) &&
        !(await sh(bare, 'branch', '--list', 'mine')),
      { frommain: synced.frommain, mine: synced.mine },
    );
    // With push.default=upstream, git itself pushes a branch to its upstream of another name, and so does Sync.
    await sh(repo, 'config', 'push.default', 'upstream');
    const upstreamMode = by(await run<GitBranchSyncResult>('git.branch.sync', { names: ['mine'] }, ws.id));
    await sh(repo, 'config', '--unset', 'push.default');
    check(
      'git sync: under push.default=upstream, Sync pushes to the upstream of another name, as git push would',
      upstreamMode.mine.outcome === 'pushed' && upstreamMode.mine.pushTarget === 'origin/their-name' && (await rev(bare, 'their-name')) === (await rev(repo, 'mine')) && !(await sh(bare, 'branch', '--list', 'mine')),
      upstreamMode.mine,
    );
    check(
      'git sync: Sync leaves an up-to-date branch alone and never pushes a diverged one',
      synced.stable.outcome === 'up-to-date' && synced.diverge.outcome === 'diverged' && (await sh(bare, 'log', '--format=%s', '-1', 'diverge')) === 'diverge.txt: theirs',
      { stable: synced.stable, diverge: synced.diverge },
    );

    // ---- Push one branch ----
    const published = await run('git.branch.push', { name: 'nobody' }, ws.id);
    check(
      'git sync: pushing a branch with no upstream publishes it to origin and tracks it',
      Boolean(published) && (await rev(bare, 'nobody')) === (await rev(repo, 'nobody')) && (await sh(repo, 'rev-parse', '--abbrev-ref', 'nobody@{u}')) === 'origin/nobody',
    );
    const noTarget = await failure(() => run('git.branch.push', { name: 'frommain' }, ws!.id));
    const goneRefused = await failure(() => run('git.branch.push', { name: 'gone' }, ws!.id));
    check(
      'git sync: a push of a branch tracking origin/main under another name, or of one deleted on the remote, is refused and nothing moves',
      noTarget.includes('would not push frommain') && goneRefused.includes('deleted on the remote') && (await rev(bare, 'main')) === bareMain && !(await sh(bare, 'branch', '--list', 'gone')),
      { noTarget, goneRefused },
    );
    await run('git.branch.push', { name: 'frommain', publish: true }, ws.id);
    check(
      'git sync: publish pushes it under its own name and tracks that, main untouched',
      (await rev(bare, 'frommain')) === (await rev(repo, 'frommain')) && (await sh(repo, 'rev-parse', '--abbrev-ref', 'frommain@{u}')) === 'origin/frommain' && (await rev(bare, 'main')) === bareMain,
    );
    const rejected = await failure(() => run('git.branch.push', { name: 'diverge' }, ws!.id));
    check('git sync: pushing a diverged branch is rejected by the remote, which keeps its commit', /rejected|non-fast-forward|fetch first/i.test(rejected) && (await sh(bare, 'log', '--format=%s', '-1', 'diverge')) === 'diverge.txt: theirs', rejected);
    await run('git.branch.push', { name: 'diverge', forceWithLease: true }, ws.id);
    check('git sync: a force push with lease replaces it', (await rev(bare, 'diverge')) === (await rev(repo, 'diverge')));

    // ---- Refusals ----
    const refusals = await Promise.all([
      failure(() => run('git.branch.pull', { names: ['origin/main'] }, ws!.id)),
      failure(() => run('git.branch.sync', { names: [':main'] }, ws!.id)),
      failure(() => run('git.branch.push', { name: '+main' }, ws!.id)),
      failure(() => run('git.branch.push', { name: 'missing' }, ws!.id)),
    ]);
    check(
      'git sync: a remote branch, a refspec or an unknown name is refused, not read as something else',
      refusals[0].includes('not a local branch') && refusals[1].includes('not a branch name') && refusals[2].includes('not a branch name') && refusals[3].includes('not a local branch'),
      refusals,
    );

    // ---- The branch list afterwards ----
    const list = await run<GitBranch[]>('git.branch.list', {}, ws.id);
    const row = (n: string) => list.find((b) => b.name === n && !b.remote);
    check('git sync: the branch list shows main and side caught up', row('main')?.behind === 0 && row('side')?.behind === 1 && row('stable')?.behind === 0, list.filter((b) => !b.remote).map((b) => `${b.name} +${b.ahead} -${b.behind}`));
    check(
      'git sync: the branch list gives where each branch is pushed, none for one tracking another name, and the upstream remote',
      row('ahead')?.push === 'origin/ahead' && row('ahead')?.upstreamRemote === 'origin' && row('mine')?.upstream === 'origin/their-name' && row('mine')?.push === undefined && row('frommain')?.push === 'origin/frommain' && row('nobody')?.push === 'origin/nobody',
      list.filter((b) => !b.remote).map((b) => `${b.name} up=${b.upstream} remote=${b.upstreamRemote} push=${b.push}`),
    );

    // ---- Agents ----
    const mcpUrl = `http://127.0.0.1:${mcpPort}/mcp?workspace=${encodeURIComponent(repo)}`;
    const rpc = async (name: string, args: unknown): Promise<RpcResult> => {
      const res = await fetch(mcpUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      });
      return (await res.json()) as RpcResult;
    };
    const stableAt = await rev(repo, 'stable');
    for (const [tool, args] of [
      ['git_branch_pull', {}],
      ['git_branch_sync', { names: ['stable'] }],
      ['git_branch_push', { name: 'stable' }],
    ] as const) {
      const res = await rpc(tool, args);
      check(`git sync: ${tool} is gated for agents`, res.result?.isError === true && (res.result.content?.[0]?.text ?? '').includes('MUTATION_BLOCKED'), res.result?.content?.[0]?.text);
    }
    check('git sync: the gated calls moved nothing', (await rev(repo, 'stable')) === stableAt);
  } finally {
    t.host.emit = emit;
    if (ws) {
      await run('workspace.close', { id: ws.id }, null).catch(() => {});
      await run('workspace.forgetRecent', { path: ws.path }, null).catch(() => {});
    }
    await fs.rm(base, { recursive: true, force: true }).catch(() => {});
  }

  return {
    ui: async ({ js, wait, shot }) => {
      const folder = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'quiver-smoke-git-sync-ui-')));
      const uiBare = path.join(folder, 'remote.git');
      const uiRepo = path.join(folder, 'quiver');
      const uiOther = path.join(folder, 'other');
      const click = (selector: string) => js(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el?.click(); return Boolean(el); })()`);
      const waitFor = (code: string, ms = 4000) => until(async () => Boolean(await js(code)), ms);
      const toast = () => js(`[...document.querySelectorAll('.fixed.bottom-8.right-3 span.flex-1')].map((e) => e.textContent.trim()).join(' | ')`) as Promise<string>;
      const dismissToasts = () => js(`[...document.querySelectorAll('.fixed.bottom-8.right-3 button[aria-label=Dismiss]')].forEach((b) => b.click())`);
      const behind = (name: string) => js(`document.querySelector('[data-testid=git-branches-row][data-kind=local][data-name="${name}"] [data-testid=git-branches-upstream]')?.textContent.replace(/\\s+/g, ' ').trim() ?? ''`) as Promise<string>;
      let uiWs: WorkspaceInfo | null = null;
      try {
        await sh(folder, 'init', '-q', '--bare', '-b', 'main', uiBare);
        await fs.mkdir(uiRepo);
        await sh(uiRepo, 'init', '-q', '-b', 'main');
        await identity(uiRepo);
        await fs.writeFile(path.join(uiRepo, '.gitignore'), '.quiver/\n');
        await sh(uiRepo, 'add', '.gitignore');
        await commitIn(uiRepo, 'app.txt', 'one\n');
        await sh(uiRepo, 'remote', 'add', 'origin', uiBare);
        await sh(uiRepo, 'branch', 'stable');
        await sh(uiRepo, 'branch', 'feat/ui');
        await sh(uiRepo, 'push', '-q', '-u', 'origin', 'main', 'stable', 'feat/ui');
        await sh(uiRepo, 'checkout', '-q', 'feat/ui');
        await sh(folder, 'clone', '-q', uiBare, uiOther);
        await identity(uiOther);
        for (const [b, n] of [['main', 3], ['stable', 1]] as const) {
          await sh(uiOther, 'checkout', '-q', b);
          for (let i = 1; i <= n; i++) await commitIn(uiOther, `${b}.txt`, `${b} ${i}\n`);
          await sh(uiOther, 'push', '-q', 'origin', b);
        }
        // The workspace knows about the new commits, as after the last fetch.
        await sh(uiRepo, 'fetch', '-q', 'origin');

        uiWs = await run<WorkspaceInfo>('workspace.open', { path: uiRepo }, null);
        await waitFor(`Boolean(document.querySelector('[data-testid=workspace-tab][data-drag-id="${uiWs.id}"]'))`);
        await click(`[data-testid=workspace-tab][data-drag-id="${uiWs.id}"]`);
        await wait(300);
        await js(`document.documentElement.classList.remove('dark')`);
        await click('[data-testid=activity-item][data-drag-id=git]');
        await waitFor(`Boolean(document.querySelector('[data-testid=git-open-branches]'))`);
        await click('[data-testid=git-open-branches]');
        const listed = await waitFor(`Boolean(document.querySelector('[data-testid=git-branches-row][data-kind=local][data-name=main] [data-testid=git-branches-upstream]'))`, 6000);
        const mainBehind = await behind('main');

        // The menu of main, which is not checked out: Pull from origin/main, Push, Sync.
        await js(`document.querySelector('[data-testid=git-branches-row][data-kind=local][data-name=main] [data-testid=git-branches-menu]').click()`);
        await waitFor(`Boolean(document.querySelector('[data-testid=context-menu] [data-testid=git-menu-pull]'))`, 2000);
        const items = (await js(`[...document.querySelectorAll('[data-testid=context-menu] [data-testid^=git-menu-]')].filter((e) => ['git-menu-pull', 'git-menu-push', 'git-menu-sync'].includes(e.getAttribute('data-testid'))).map((e) => e.textContent.trim() + (e.disabled ? ' (disabled)' : ''))`)) as string[];
        check('git sync ui: a branch that is not checked out offers Pull from its upstream and Sync, and Push only once it has commits to push', JSON.stringify(items) === JSON.stringify(['Pull from origin/main', 'Push to origin/main (disabled)', 'Sync (pull, then push)']), { items, listed, mainBehind });
        check('git sync ui: before the pull, the row of main says it is 3 behind', listed && /3$/.test(mainBehind), mainBehind);
        await shot('32u-git-branch-menu-pull-light');
        await click('[data-testid=context-menu] [data-testid=git-menu-pull]');
        const pulledMain = await waitFor(`(document.querySelector('.fixed.bottom-8.right-3')?.textContent ?? '').includes('Pulled 3 commits into main')`, 8000);
        // The row shows only its upstream once it is neither ahead nor behind.
        const caughtUp = await until(async () => (await behind('main')) === 'origin/main', 5000);
        const head = await sh(uiRepo, 'branch', '--show-current');
        check('git sync ui: Pull on main fast-forwards it without switching, says so, and its row catches up', pulledMain && caughtUp && head === 'feat/ui' && (await rev(uiRepo, 'main')) === (await rev(uiBare, 'main')), { toast: await toast(), row: await behind('main'), head, mainBehind });
        await dismissToasts();

        // Pull all: stable is behind, feat/ui (current) and main up to date.
        await sh(uiOther, 'checkout', '-q', 'stable');
        await commitIn(uiOther, 'stable.txt', 'stable 2\n');
        await sh(uiOther, 'push', '-q', 'origin', 'stable');
        await click('[data-testid=git-branches-pull-all]');
        const pulledAll = await waitFor(`(document.querySelector('.fixed.bottom-8.right-3')?.textContent ?? '').includes('Pulled into stable')`, 8000);
        await wait(300);
        await shot('32v-git-branches-pull-all-light');
        check('git sync ui: Pull all fetches and fast-forwards every branch that is behind, and sums it up', pulledAll && (await rev(uiRepo, 'stable')) === (await rev(uiBare, 'stable')), await toast());
        await dismissToasts();

        // A branch made from origin/main, which tracks it: the menu offers to publish it under its own name, never a push to main.
        await sh(uiRepo, 'branch', '--track', 'ui/from-main', 'origin/main');
        await click('[data-testid=git-branches-refresh]');
        await waitFor(`Boolean(document.querySelector('[data-testid=git-branches-row][data-kind=local][data-name="ui/from-main"] [data-testid=git-branches-menu]'))`, 4000);
        await js(`document.querySelector('[data-testid=git-branches-row][data-kind=local][data-name="ui/from-main"] [data-testid=git-branches-menu]').click()`);
        await waitFor(`Boolean(document.querySelector('[data-testid=context-menu] [data-testid=git-menu-push]'))`, 2000);
        const pushLabel = (await js(`(() => { const e = document.querySelector('[data-testid=context-menu] [data-testid=git-menu-push]'); return e.textContent.trim() + (e.disabled ? ' (disabled)' : ''); })()`)) as string;
        await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
        check('git sync ui: a branch tracking origin/main under another name is offered Publish to origin/<its name>, not a push to main', pushLabel === 'Publish to origin/ui/from-main', pushLabel);
      } finally {
        await js(`document.querySelector('[data-testid=context-menu]') && document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`).catch(() => {});
        await click(`[data-testid=workspace-tab][data-drag-id="${t.ws.id}"]`);
        await wait(200);
        if (uiWs) {
          await run('workspace.close', { id: uiWs.id }, null).catch(() => {});
          await run('workspace.forgetRecent', { path: uiWs.path }, null).catch(() => {});
        }
        await fs.rm(folder, { recursive: true, force: true }).catch(() => {});
      }
    },
  };
};

export default section;
