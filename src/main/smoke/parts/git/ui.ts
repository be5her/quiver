import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { GitCommit, GitDiffFile, GitStatus, TodoItem, WorkspaceInfo } from '@quiver/core';
import { runToEnd } from '@quiver/core/node';
import { writeFakeGh, type FakeGhPr, type FakeGhState } from '../../fake-gh';
import { until, type SmokeSection } from '../../part';

// The Git panel, on a repository of its own in a temporary folder opened as a second workspace: a file changed on disk
// shows in the sidebar, its diff opens side by side and inline, it is staged and committed from the commit box, the
// commit shows in the history, a branch is made from a dialog and another switched to from the list, the status bar
// follows the branch with its ahead count, a merge conflict opens the conflict editor rather than a diff, a merge started here shows
// the operation banner until it is continued, a change is stashed, popped and discarded, and the Branches tab lists,
// filters, renames and cleans up branches; then the pull requests
// against the fake gh of parts/git/pr.ts, with their check badges, a detail tab with the failed log on demand and a
// todo made from it, and the empty state when gh is missing.

const REPO = 'smoke/quiver';

function pr(number: number, over: Partial<FakeGhPr>): FakeGhPr {
  return {
    number,
    title: `PR ${number}`,
    state: 'OPEN',
    isDraft: false,
    author: { login: 'smoke-user' },
    headRefName: `feat/${number}`,
    baseRefName: 'main',
    url: `https://github.com/${REPO}/pull/${number}`,
    createdAt: '2026-10-20T10:00:00Z',
    updatedAt: '2026-10-20T10:00:00Z',
    reviewDecision: '',
    labels: [],
    statusCheckRollup: [],
    body: '',
    additions: 0,
    deletions: 0,
    files: [],
    reviews: [],
    comments: [],
    reviewRequested: [],
    isCrossRepository: false,
    headRepositoryOwner: { login: 'smoke' },
    ...over,
  };
}

function ghState(): FakeGhState {
  const run = (name: string, conclusion: string, job: number) => ({ __typename: 'CheckRun', name, workflowName: 'CI', status: 'COMPLETED', conclusion, detailsUrl: `https://github.com/${REPO}/actions/runs/7/job/${job}` });
  return {
    login: 'smoke-user',
    repo: REPO,
    defaultBranch: 'main',
    prs: [
      pr(1, {
        title: 'Add the parser',
        labels: [{ name: 'enhancement' }],
        statusCheckRollup: [run('build', 'SUCCESS', 70), run('test', 'FAILURE', 71)],
        body: 'Adds the parser.\n\nCloses #4.',
        additions: 2,
        deletions: 1,
        files: [{ path: 'src/x.ts', additions: 2, deletions: 1 }],
        reviews: [{ author: { login: 'reviewer' }, state: 'CHANGES_REQUESTED', submittedAt: '2026-10-20T11:00:00Z', body: 'Please add a test' }],
        comments: [{ author: { login: 'reviewer' }, createdAt: '2026-10-20T11:01:00Z', body: 'And fix the build' }],
        reviewDecision: 'CHANGES_REQUESTED',
      }),
      pr(2, { title: 'Theirs, waiting on review', author: { login: 'other' }, reviewRequested: ['smoke-user'], reviewDecision: 'REVIEW_REQUIRED', statusCheckRollup: [{ __typename: 'CheckRun', name: 'build', status: 'IN_PROGRESS', conclusion: '' }] }),
      pr(3, { title: 'Approved and green', author: { login: 'other' }, reviewDecision: 'APPROVED', statusCheckRollup: [run('build', 'SUCCESS', 80)] }),
    ],
    checks: {
      1: [
        { name: 'build', state: 'SUCCESS', bucket: 'pass', link: `https://github.com/${REPO}/actions/runs/7/job/70`, workflow: 'CI', startedAt: '2026-10-20T10:00:00Z', completedAt: '2026-10-20T10:02:00Z' },
        { name: 'test', state: 'FAILURE', bucket: 'fail', link: `https://github.com/${REPO}/actions/runs/7/job/71`, workflow: 'CI', startedAt: '2026-10-20T10:00:00Z', completedAt: '2026-10-20T10:01:02Z' },
      ],
    },
    jobLogs: {
      71: [
        'test\tRun npm test\t2026-10-20T10:01:01.0000000Z FAIL src/x.test.ts > parses',
        'test\tRun npm test\t2026-10-20T10:01:02.0000000Z ##[error]Process completed with exit code 1.',
        '',
      ].join('\n'),
    },
    diffs: { 1: ['diff --git a/src/x.ts b/src/x.ts', 'index 1..2 100644', '--- a/src/x.ts', '+++ b/src/x.ts', '@@ -1 +1,2 @@', '-old', '+new', '+more', ''].join('\n') },
    opened: [],
  };
}

const section: SmokeSection = async ({ check, run, ws: mainWs }) => ({
  ui: async ({ js, wait, shot }) => {
    await js(`document.querySelector('[data-testid=activity-item][data-drag-id=git]').click()`);
    await wait(300);
    check('git ui: the activity bar opens the Git sidebar', (await js(`Boolean(document.querySelector('[data-testid=git-sidebar]'))`)) === true);

    const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'quiver-smoke-git-ui-'));
    const ghDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quiver-smoke-git-ui-gh-'));
    const sh = (...args: string[]) => runToEnd('git', args, { cwd: folder });
    const previousGh = process.env.QUIVER_GH_PATH;
    const setInput = `(el, value) => { const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }`;
    const visible = (selector: string) => `[...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.offsetParent !== null)`;
    const click = (selector: string) => js(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el?.click(); return Boolean(el); })()`);
    const waitFor = (code: string, ms = 4000) => until(async () => Boolean(await js(code)), ms);
    let ws: WorkspaceInfo | undefined;
    try {
      await sh('init', '-q', '-b', 'main');
      await sh('config', 'user.name', 'Smoke');
      await sh('config', 'user.email', 'smoke@quiver.test');
      await sh('config', 'core.autocrlf', 'false');
      await fs.writeFile(path.join(folder, 'app.txt'), 'one\ntwo\nthree\nfour\n');
      await fs.writeFile(path.join(folder, 'readme.md'), '# Smoke\n');
      // Quiver's own folder appears when the workspace opens; ignored, so the tree starts clean.
      await fs.writeFile(path.join(folder, '.gitignore'), '.quiver/\n');
      await sh('add', '.');
      await sh('commit', '-q', '-m', 'First commit');
      await sh('remote', 'add', 'origin', `https://github.com/${REPO}.git`);
      await sh('branch', 'feature');
      const fake = await writeFakeGh(ghDir, ghState());
      process.env.QUIVER_GH_PATH = fake.command;

      ws = await run<WorkspaceInfo>('workspace.open', { path: folder }, null);
      const id = ws.id;
      await waitFor(`Boolean(document.querySelector('[data-testid=workspace-tab][data-drag-id="${id}"]'))`);
      await click(`[data-testid=workspace-tab][data-drag-id="${id}"]`);
      await wait(300);
      // Showing another workspace applies the system theme again; the light shots want light.
      await js(`document.documentElement.classList.remove('dark')`);
      await click('[data-testid=activity-item][data-drag-id=git]');
      const branchShown = await waitFor(`document.querySelector('[data-testid=git-current-branch]')?.textContent.trim() === 'main'`);
      check('git ui: the sidebar shows the current branch with a clean tree', branchShown && (await js(`Boolean(document.querySelector('[data-testid=git-clean]'))`)) === true);
      const statusItem = () => js(`(() => { const el = document.querySelector('[data-testid=git-status-item]'); return el ? { branch: el.getAttribute('data-branch'), ahead: el.getAttribute('data-ahead'), behind: el.getAttribute('data-behind'), text: el.textContent.replace(/\\s+/g, ' ').trim() } : null; })()`);
      const itemOn = (branch: string, ahead = '0') => until(async () => {
        const item = (await statusItem()) as { branch: string; ahead: string } | null;
        return item?.branch === branch && item.ahead === ahead;
      }, 5000);
      check('git ui: the status bar shows the branch, without arrows while nothing is ahead or behind', (await itemOn('main')) && JSON.stringify(await statusItem()) === JSON.stringify({ branch: 'main', ahead: '0', behind: '0', text: 'main' }), await statusItem());

      // A file changed on disk shows under Changes (the status is read again on refresh, focus and every few seconds).
      await fs.writeFile(path.join(folder, 'app.txt'), 'one\nTWO\nthree\nfour\nfive\n');
      await fs.writeFile(path.join(folder, 'notes.txt'), 'new\n');
      await click('[data-testid=git-refresh]');
      const changed = await waitFor(`Boolean(document.querySelector('[data-testid=git-file][data-group=unstaged][data-path="app.txt"]')) && Boolean(document.querySelector('[data-testid=git-file][data-group=untracked][data-path="notes.txt"]'))`);
      check('git ui: a changed file shows under Changes and a new one under Untracked', changed);
      await shot('32a-git-sidebar-changes-light');

      // Its diff, side by side as whole files in the merge view (the old side read from the index), then inline.
      await click('[data-testid=git-file][data-group=unstaged][data-path="app.txt"]');
      await waitFor(`Boolean(${visible('[data-testid=git-full-diff] .cm-merge-b .cm-changedLine')})`);
      const split = await js(
        `(() => { const t = ${visible('[data-testid=git-diff-tab]')}; const v = t?.querySelector('[data-testid=git-full-diff]'); const lines = (sel) => [...v.querySelectorAll(sel)].map((e) => e.textContent); return v ? { kind: t.getAttribute('data-kind'), path: t.getAttribute('data-path'), old: lines('.cm-merge-a .cm-changedLine'), new: lines('.cm-merge-b .cm-changedLine'), whole: lines('.cm-merge-b .cm-line') } : null; })()`,
      );
      check(
        'git ui: clicking the file opens its working diff side by side as whole files, the edit marked on both sides',
        JSON.stringify(split) === JSON.stringify({ kind: 'working', path: 'app.txt', old: ['two'], new: ['TWO', 'five'], whole: ['one', 'TWO', 'three', 'four', 'five', ''] }),
        split,
      );
      await shot('32b-git-diff-split-light');
      await js(`${visible('[data-testid=git-diff-inline]')}?.click()`);
      await wait(200);
      const inline = await js(`(() => { const p = ${visible('[data-testid=git-patch]')}; return p ? { mode: p.getAttribute('data-mode'), rows: [...p.querySelectorAll('tr[data-kind]')].map((r) => r.getAttribute('data-kind')) } : null; })()`);
      check(
        'git ui: Inline shows the same change as one column',
        JSON.stringify(inline) === JSON.stringify({ mode: 'inline', rows: ['context', 'del', 'add', 'context', 'context', 'add'] }),
        inline,
      );
      await js(`document.documentElement.classList.add('dark')`);
      await wait(150);
      await shot('32c-git-diff-inline-dark');
      await js(`document.documentElement.classList.remove('dark')`);
      await js(`${visible('[data-testid=git-diff-split]')}?.click()`);

      // Stage it from its row; it moves to Staged changes.
      await click('[data-testid=git-file][data-group=unstaged][data-path="app.txt"] [data-testid=git-stage]');
      const staged = await waitFor(`Boolean(document.querySelector('[data-testid=git-file][data-group=staged][data-path="app.txt"]')) && !document.querySelector('[data-testid=git-file][data-group=unstaged][data-path="app.txt"]')`);
      const index = await run<GitStatus>('git.status', {}, id);
      check('git ui: Stage moves the file to Staged changes', staged && index.files.some((f) => f.path === 'app.txt' && f.index === 'M' && f.worktree === '.'), index.files);
      // The open working diff follows: nothing is left between the index and the working tree.
      const emptied = await waitFor(`Boolean(${visible('[data-testid=git-diff-tab]')}?.querySelector('[data-testid=git-diff-empty]'))`);
      check('git ui: the working diff empties once the file is staged', emptied);

      // main tracks feature for a moment, so the commit below puts it one ahead in the status bar.
      await sh('branch', '--set-upstream-to=feature', 'main');
      // Commit from the box: the button waits for a message, then commits what is staged.
      const disabledBefore = await js(`document.querySelector('[data-testid=git-commit]')?.disabled ?? null`);
      await js(`(() => { const set = ${setInput}; set(document.querySelector('[data-testid=git-commit-message]'), 'Change app\\n\\nFrom the panel.'); })()`);
      await wait(150);
      const enabled = await js(`document.querySelector('[data-testid=git-commit]')?.disabled ?? null`);
      await click('[data-testid=git-commit]');
      const committed = await until(async () => (await run<{ commits: GitCommit[] }>('git.log', { limit: 1 }, id)).commits[0]?.subject === 'Change app', 4000);
      const head = (await run<{ commits: GitCommit[] }>('git.log', { limit: 1 }, id)).commits[0];
      const cleared = await waitFor(`document.querySelector('[data-testid=git-commit-message]')?.value === '' && !document.querySelector('[data-testid=git-file][data-group=staged]')`);
      check(
        'git ui: Commit is enabled by a message, commits the staged file and clears the box',
        disabledBefore === true && enabled === false && committed && head?.body === 'From the panel.' && cleared,
        { disabledBefore, enabled, head, cleared },
      );
      await shot('32d-git-sidebar-committed-light');
      const ahead = await itemOn('main', '1');
      check('git ui: after the commit the status bar shows the branch one ahead of its upstream', ahead && ((await statusItem()) as { text: string } | null)?.text === 'main1', await statusItem());
      await sh('branch', '--unset-upstream', 'main');

      // The history lists it first, with its files and diff.
      await click('[data-testid=git-open-history]');
      const historyShown = await waitFor(`${visible('[data-testid=git-history-tab]')}?.querySelector('[data-testid=git-commit-detail]')?.getAttribute('data-hash') === ${JSON.stringify(head?.hash ?? '')}`);
      const history = await js(
        `(() => { const t = ${visible('[data-testid=git-history-tab]')}; return t ? { rows: [...t.querySelectorAll('[data-testid=git-commit-row]')].map((r) => r.querySelector('span span').textContent.trim()), path: t.querySelector('[data-testid=git-diff-path]')?.textContent.trim() ?? null } : null; })()`,
      );
      check(
        'git ui: the history lists the new commit first and shows its files and diff',
        historyShown && JSON.stringify(history) === JSON.stringify({ rows: ['Change app', 'First commit'], path: 'app.txt' }),
        history,
      );
      await shot('32e-git-history-light');
      await js(`document.documentElement.classList.add('dark')`);
      await wait(150);
      await shot('32f-git-history-dark');
      await js(`document.documentElement.classList.remove('dark')`);
      await js(`${visible('[data-testid=git-commit-open-tab]')}?.click()`);
      const commitTab = await waitFor(`${visible('[data-testid=git-diff-tab]')}?.getAttribute('data-kind') === 'commit' && Boolean(${visible('[data-testid=git-full-diff] .cm-mergeView')})`);
      check('git ui: a commit opens in a diff tab of its own', commitTab);

      // Switch branch from the list, then make one from the dialog.
      await waitFor(`Boolean(document.querySelector('[data-testid=git-branch][data-name=feature]'))`);
      await click('[data-testid=git-branch][data-name=feature]');
      const switched = await waitFor(`document.querySelector('[data-testid=git-current-branch]')?.textContent.trim() === 'feature'`);
      check('git ui: clicking a branch switches to it', switched && (await run<GitStatus>('git.status', {}, id)).branch === 'feature');
      // The status bar follows the checkout, and a click there opens Git from another module.
      const followed = await itemOn('feature');
      await click('[data-testid=activity-item][data-drag-id=todo]');
      await wait(200);
      const away = await js(`!document.querySelector('[data-testid=git-sidebar]')`);
      await click('[data-testid=git-status-item]');
      const opened = await waitFor(`Boolean(document.querySelector('[data-testid=git-sidebar]'))`, 2000);
      // The sidebar is made anew; the steps below need its branch read and its buttons in place.
      await waitFor(`document.querySelector('[data-testid=git-current-branch]')?.textContent.trim() === 'feature' && Boolean(document.querySelector('[data-testid=git-new-branch]'))`);
      check('git ui: the status bar follows a branch switch, and a click on it opens Git', followed && away === true && opened, { item: await statusItem(), away, opened });
      await click('[data-testid=git-new-branch]');
      await wait(250);
      const dialogTitle = await js(`document.querySelector('.fixed.inset-0 h2')?.textContent.trim() ?? null`);
      await js(
        `(() => { const set = ${setInput}; const form = document.querySelector('.fixed.inset-0 form'); set(form.querySelector('input'), 'ui/new-branch'); [...form.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Create and switch')?.click(); })()`,
      );
      const created = await waitFor(`document.querySelector('[data-testid=git-current-branch]')?.textContent.trim() === 'ui/new-branch'`);
      check('git ui: New branch asks for a name, creates the branch and switches to it', dialogTitle === 'New branch' && created, dialogTitle);

      // A merge conflict: the file is listed once, under Merge conflicts, and its row opens the conflict editor rather
      // than the combined diff. The host pairs it with its own patch, so another changed file still has its diff.
      await sh('checkout', '-q', '-b', 'ui/conflict');
      await fs.writeFile(path.join(folder, 'app.txt'), 'one\nother\n');
      await sh('commit', '-q', '-am', 'Other app');
      await sh('merge', '-q', 'main');
      await fs.writeFile(path.join(folder, 'readme.md'), '# Smoke, edited\n');
      await click('[data-testid=git-refresh]');
      const conflictRow = await waitFor(`document.querySelectorAll('[data-testid=git-file][data-path="app.txt"]').length === 1 && Boolean(document.querySelector('[data-testid=git-file][data-group=conflicts][data-path="app.txt"]'))`);
      await click('[data-testid=git-file][data-group=conflicts][data-path="app.txt"]');
      const conflictNote = await waitFor(`${visible('[data-testid=git-conflict-tab][data-path="app.txt"]')}?.getAttribute('data-view') === 'text'`);
      const working = await run<GitDiffFile[]>('git.diff', { staged: false }, id);
      const pairs = working.map((d) => ({ path: d.path, patch: d.patch?.slice(0, 10) ?? null, truncated: Boolean(d.truncated) }));
      check(
        'git ui: a conflicted file is listed once and its row opens the conflict editor; the other files keep their diffs',
        conflictRow && conflictNote && JSON.stringify(pairs) === JSON.stringify([{ path: 'app.txt', patch: 'diff --cc ', truncated: false }, { path: 'readme.md', patch: 'diff --git', truncated: false }]),
        { conflictRow, conflictNote, pairs },
      );
      await sh('merge', '--abort');
      await sh('checkout', '-q', '--', 'readme.md');
      await sh('checkout', '-q', 'ui/new-branch');
      await click('[data-testid=git-refresh]');
      await waitFor(`document.querySelector('[data-testid=git-current-branch]')?.textContent.trim() === 'ui/new-branch' && !document.querySelector('[data-testid=git-group][data-group=conflicts]')`);

      // The operation banner: a merge started from Quiver stops on a conflict; Continue waits for it to be resolved.
      // On a branch of its own, so ui/new-branch keeps the last commit the pull request form starts from.
      const dialogButton = (label: string) => js(`(() => { const b = [...document.querySelectorAll('.fixed.inset-0 button')].find((e) => e.textContent.trim() === ${JSON.stringify(label)}); b?.click(); return Boolean(b); })()`);
      const answerPrompt = (value: string, label: string) =>
        js(`(() => { const set = ${setInput}; const form = document.querySelector('.fixed.inset-0 form'); if (!form) return false; set(form.querySelector('input, textarea'), ${JSON.stringify(value)}); const b = [...form.querySelectorAll('button')].find((e) => e.textContent.trim() === ${JSON.stringify(label)}); b?.click(); return Boolean(b); })()`);
      const rightClick = (selector: string) =>
        js(`(() => { const el = ${visible(selector)}; if (!el) return false; const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 40, clientY: r.top + r.height / 2 })); return true; })()`);
      await sh('checkout', '-q', '-b', 'ui/ops');
      await sh('checkout', '-q', '-b', 'ui/theirs');
      await fs.writeFile(path.join(folder, 'app.txt'), 'theirs\n');
      await sh('commit', '-q', '-am', 'Their app');
      await sh('checkout', '-q', 'ui/ops');
      await fs.writeFile(path.join(folder, 'app.txt'), 'ours\n');
      await sh('commit', '-q', '-am', 'Our app');
      await run('git.merge', { ref: 'ui/theirs' }, id);
      const banner = await waitFor(`document.querySelector('[data-testid=git-operation]')?.getAttribute('data-operation') === 'merge' && document.querySelector('[data-testid=git-operation-continue]')?.disabled === true && !document.querySelector('[data-testid=git-operation-skip]')`);
      check('git ui: a merge stopped on a conflict shows the banner, Continue waiting for the conflict and no Skip for a merge', banner, await js(`document.querySelector('[data-testid=git-operation]')?.textContent.trim() ?? null`));
      await shot('32m-git-operation-banner-light');
      await fs.writeFile(path.join(folder, 'app.txt'), 'ours and theirs\n');
      await click('[data-testid=git-file][data-group=conflicts][data-path="app.txt"] [data-testid=git-stage]');
      const canContinue = await waitFor(`document.querySelector('[data-testid=git-operation-continue]')?.disabled === false`);
      await click('[data-testid=git-operation-continue]');
      const finished = await waitFor(`!document.querySelector('[data-testid=git-operation]')`, 6000);
      const mergeHead = (await run<{ commits: GitCommit[] }>('git.log', { limit: 1 }, id)).commits[0];
      check('git ui: once the conflict is marked resolved, Continue commits the merge and the banner goes', canContinue && finished && mergeHead?.parents.length === 2, { canContinue, finished, mergeHead: mergeHead?.subject });

      // The Stashes section: stash a change with a message, see it, pop it; then discard it from its row.
      await fs.writeFile(path.join(folder, 'app.txt'), 'stash me\n');
      await click('[data-testid=git-refresh]');
      await waitFor(`Boolean(document.querySelector('[data-testid=git-file][data-group=unstaged][data-path="app.txt"]'))`);
      await click('[data-testid=git-stash-push]');
      await wait(250);
      const stashPrompt = await answerPrompt('ui stash', 'Stash');
      const stashed = await waitFor(`Boolean(document.querySelector('[data-testid=git-stash][data-index="0"][data-message="ui stash"]')) && !document.querySelector('[data-testid=git-file][data-path="app.txt"]')`);
      check('git ui: Stash changes asks for a message and lists the stash, the change gone from the tree', stashPrompt === true && stashed && (await fs.readFile(path.join(folder, 'app.txt'), 'utf8')) === 'ours and theirs\n');
      await shot('32n-git-stashes-light');
      await click('[data-testid=git-stash][data-index="0"]');
      const stashTab = await waitFor(`${visible('[data-testid=git-diff-tab]')}?.getAttribute('data-kind') === 'stash' && Boolean(${visible('[data-testid=git-full-diff] .cm-merge-b .cm-changedLine')})`, 6000);
      check('git ui: a stash opens in a diff tab with its changes', stashTab);
      await click('[data-testid=git-stash][data-index="0"] [data-testid=git-stash-pop]');
      const popped = await waitFor(`Boolean(document.querySelector('[data-testid=git-stashes-empty]')) && Boolean(document.querySelector('[data-testid=git-file][data-group=unstaged][data-path="app.txt"]'))`);
      check('git ui: Pop brings the change back and drops the stash', popped && (await fs.readFile(path.join(folder, 'app.txt'), 'utf8')) === 'stash me\n');
      await click('[data-testid=git-file][data-group=unstaged][data-path="app.txt"] [data-testid=git-discard]');
      await wait(250);
      const discardTitle = await js(`document.querySelector('.fixed.inset-0 h2')?.textContent.trim() ?? null`);
      await dialogButton('Discard');
      const discarded = await waitFor(`!document.querySelector('[data-testid=git-file][data-path="app.txt"]')`);
      check(
        'git ui: Discard asks first, then puts the file back, leaving untracked files alone',
        discardTitle === 'Discard the changes to app.txt?' && discarded && (await fs.readFile(path.join(folder, 'app.txt'), 'utf8')) === 'ours and theirs\n' && (await fs.stat(path.join(folder, 'notes.txt')).then(() => true, () => false)),
        discardTitle,
      );

      // The Branches tab: local branches with their badges, remote branches and tags, a filter, a menu and Clean up.
      await sh('branch', 'ui/merged', 'main');
      await sh('tag', 'v0.1', 'HEAD~1');
      await click('[data-testid=git-open-branches]');
      const rowsOf = () =>
        js(`[...(${visible('[data-testid=git-branches-tab]')}?.querySelectorAll('[data-testid=git-branches-row]') ?? [])].map((r) => [r.getAttribute('data-kind'), r.getAttribute('data-name'), r.getAttribute('data-current') === 'true' ? 'current' : r.getAttribute('data-merged') === 'true' ? 'merged' : ''].join(':'))`) as Promise<string[]>;
      const branchesShown = await waitFor(`Boolean(${visible('[data-testid=git-branches-row][data-name="v0.1"]')})`, 6000);
      const branchRows = await rowsOf();
      check(
        'git ui: the Branches tab lists local branches with current and merged badges (merged into main, which is never merged itself), and the tags',
        branchesShown && branchRows.includes('local:ui/ops:current') && branchRows.includes('local:ui/merged:merged') && branchRows.includes('local:main:') && branchRows.includes('tag:v0.1:'),
        branchRows,
      );
      await shot('32o-git-branches-light');
      await js(`document.documentElement.classList.add('dark')`);
      await wait(150);
      await shot('32p-git-branches-dark');
      await js(`document.documentElement.classList.remove('dark')`);
      await js(`(() => { const set = ${setInput}; set(${visible('[data-testid=git-branches-filter]')}, 'ui/mer'); })()`);
      const filteredRows = await until(async () => JSON.stringify(await rowsOf()) === JSON.stringify(['local:ui/merged:merged']), 3000);
      check('git ui: the filter keeps the branches and tags whose name matches', filteredRows, await rowsOf());
      await js(`(() => { const set = ${setInput}; set(${visible('[data-testid=git-branches-filter]')}, ''); })()`);
      // Rename from the row's menu.
      await waitFor(`Boolean(${visible('[data-testid=git-branches-row][data-name="ui/theirs"]')})`);
      await rightClick('[data-testid=git-branches-row][data-name="ui/theirs"]');
      const menuShown = await waitFor(`Boolean(document.querySelector('[data-testid=context-menu] [data-testid=git-menu-rename]')) && Boolean(document.querySelector('[data-testid=context-menu] [data-testid=git-menu-delete]'))`, 2000);
      await shot('32q-git-branch-menu-light');
      await click('[data-testid=context-menu] [data-testid=git-menu-rename]');
      await wait(250);
      await answerPrompt('ui/theirs-renamed', 'Rename');
      const renamedRow = await waitFor(`Boolean(${visible('[data-testid=git-branches-row][data-name="ui/theirs-renamed"]')})`, 4000);
      check('git ui: a branch row has a menu, and Rename from it renames the branch', menuShown && renamedRow);
      // Clean up offers the merged branches, ticked; deleting asks first.
      await click('[data-testid=git-branches-cleanup]');
      await waitFor(`Boolean(${visible('[data-testid=git-cleanup]')})`);
      const offered = await js(`[...(${visible('[data-testid=git-cleanup]')}?.querySelectorAll('[data-testid=git-cleanup-row]') ?? [])].map((r) => r.getAttribute('data-name') + (r.querySelector('input').checked ? ':ticked' : ''))`);
      await shot('32r-git-branches-cleanup-light');
      // Only ui/merged goes: feature and ui/new-branch, merged into main too, are unticked, and the steps below need them.
      await js(`[...(${visible('[data-testid=git-cleanup]')}?.querySelectorAll('[data-testid=git-cleanup-row]') ?? [])].filter((r) => r.getAttribute('data-name') !== 'ui/merged' && r.querySelector('input').checked).forEach((r) => r.querySelector('input').click())`);
      await wait(150);
      const ticked = await js(`[...(${visible('[data-testid=git-cleanup]')}?.querySelectorAll('[data-testid=git-cleanup-row]') ?? [])].filter((r) => r.querySelector('input').checked).map((r) => r.getAttribute('data-name'))`);
      await click('[data-testid=git-cleanup-delete]');
      await wait(250);
      const confirmTitle = await js(`document.querySelector('.fixed.inset-0 h2')?.textContent.trim() ?? null`);
      const confirmed = await dialogButton('Delete');
      const branchNames = async () => (await run<{ name: string }[]>('git.branch.list', {}, id)).map((b) => b.name);
      const cleaned = await until(async () => {
        const names = await branchNames();
        return !names.includes('ui/merged') && ['main', 'feature', 'ui/new-branch', 'ui/theirs-renamed'].every((n) => names.includes(n));
      }, 5000);
      check('git ui: Clean up lists the merged branches ticked, and deletes the ones left ticked after asking once, a branch merged into main going without force from another branch', cleaned && Array.isArray(offered) && (offered as string[]).includes('ui/merged:ticked'), { offered, ticked, confirmTitle, confirmed, names: await branchNames() });
      await waitFor(`${visible('[data-testid=git-branches-tab]')}?.getAttribute('data-view') === 'list'`);
      await sh('checkout', '-q', 'ui/new-branch');
      await click('[data-testid=git-refresh]');
      await waitFor(`document.querySelector('[data-testid=git-current-branch]')?.textContent.trim() === 'ui/new-branch'`);

      // Pull requests: the list with check badges and review decisions.
      await click('[data-testid=git-open-prs]');
      const listed = await waitFor(`(${visible('[data-testid=git-prs-tab]')}?.querySelectorAll('[data-testid=git-pr-row]').length ?? 0) === 3`, 8000);
      const rows = await js(
        `[...(${visible('[data-testid=git-prs-tab]')}?.querySelectorAll('[data-testid=git-pr-row]') ?? [])].map((r) => ({ n: r.getAttribute('data-number'), checks: r.getAttribute('data-checks'), badge: r.querySelector('[data-testid=git-pr-checks]')?.textContent.trim() ?? '', review: r.querySelector('[data-testid=git-pr-review]')?.textContent.trim() ?? '' }))`,
      );
      check(
        'git ui: the pull requests list shows check badges and review decisions',
        listed &&
          JSON.stringify(rows) ===
            JSON.stringify([
              { n: '3', checks: 'success', badge: '✓ 1', review: 'Approved' },
              { n: '2', checks: 'pending', badge: '● 1/1', review: 'Review required' },
              { n: '1', checks: 'failure', badge: '✗ 1/2', review: 'Changes requested' },
            ]),
        rows,
      );
      await shot('32g-git-prs-light');
      await js(`${visible('[data-testid=git-prs-filter-review]')}?.click()`);
      const filtered = await waitFor(`[...(${visible('[data-testid=git-prs-tab]')}?.querySelectorAll('[data-testid=git-pr-row]') ?? [])].map((r) => r.getAttribute('data-number')).join() === '2'`, 6000);
      check('git ui: Review requested lists only the pull requests waiting on me', filtered);
      await js(`${visible('[data-testid=git-prs-filter-all]')}?.click()`);
      await waitFor(`(${visible('[data-testid=git-prs-tab]')}?.querySelectorAll('[data-testid=git-pr-row]').length ?? 0) === 3`, 6000);

      // The detail: body and conversation, then the checks with the failed log on demand.
      await js(`${visible('[data-testid=git-pr-row][data-number="1"]')}?.click()`);
      const detail = await waitFor(`${visible('[data-testid=git-pr-tab]')}?.querySelector('[data-testid=git-pr-body-text]')?.textContent.includes('Adds the parser.')`, 6000);
      const conversation = await js(`[...(${visible('[data-testid=git-pr-tab]')}?.querySelectorAll('[data-testid=git-pr-comment]') ?? [])].map((c) => c.getAttribute('data-kind'))`);
      check('git ui: a pull request opens with its description, review and comment', detail && JSON.stringify(conversation) === JSON.stringify(['review', 'comment']), conversation);
      await shot('32h-git-pr-conversation-light');
      // Add todo: one todo per open pull request, titled with its number and title, its address in the notes. An open
      // todo for #12 does not count as one for #1, though its address starts with #1's.
      const prUrl = `https://github.com/${REPO}/pull/1`;
      const todosOf = async () => (await run<TodoItem[]>('todo.list', {}, id)).filter((t) => t.notes === prUrl);
      await run('todo.add', { title: '#12 Another pull request', notes: `${prUrl}2` }, id);
      await js(`${visible('[data-testid=git-pr-todo]')}?.click()`);
      const added = await until(async () => (await todosOf()).length === 1, 4000);
      const todo = (await todosOf())[0];
      await js(`${visible('[data-testid=git-pr-todo]')}?.click()`);
      await wait(400);
      const once = (await todosOf()).length;
      check(
        'git ui: Add todo makes a todo from the pull request (title, address in the notes), once while it is open, beside one for #12',
        added && todo?.title === '#1 Add the parser' && !todo.done && once === 1,
        { todo, once },
      );
      await js(`document.documentElement.classList.add('dark')`);
      await wait(150);
      await shot('32l-git-pr-todo-dark');
      await js(`document.documentElement.classList.remove('dark')`);
      // An open todo with the address inside other text (a markdown link, the end of a sentence) counts as well.
      if (todo) await run('todo.remove', { id: todo.id }, id);
      const linked = await run<TodoItem>('todo.add', { title: 'Review it', notes: `See [the parser](${prUrl}).` }, id);
      await js(`${visible('[data-testid=git-pr-todo]')}?.click()`);
      await wait(400);
      const afterLinked = (await todosOf()).length;
      await run('todo.remove', { id: linked.id }, id);
      check('git ui: Add todo finds the pull request already in an open todo as a markdown link', afterLinked === 0, { afterLinked });
      await js(`${visible('[data-testid=git-pr-view-checks]')}?.click()`);
      const checksShown = await waitFor(`(${visible('[data-testid=git-pr-tab]')}?.querySelectorAll('[data-testid=git-pr-check]').length ?? 0) === 2`, 6000);
      const logBefore = await js(`Boolean(${visible('[data-testid=git-pr-tab]')}?.querySelector('[data-testid=git-pr-check-log]'))`);
      await js(`${visible('[data-testid=git-pr-failed-logs]')}?.click()`);
      const logShown = await waitFor(`${visible('[data-testid=git-pr-tab]')}?.querySelector('[data-testid=git-pr-check][data-name=test] [data-testid=git-pr-check-log]')?.textContent.includes('Process completed with exit code 1')`, 8000);
      check('git ui: the checks tab lists the checks and shows the failed log only when asked', checksShown && logBefore === false && logShown, { checksShown, logBefore, logShown });
      await js(`document.documentElement.classList.add('dark')`);
      await wait(150);
      await shot('32i-git-pr-checks-dark');
      await js(`document.documentElement.classList.remove('dark')`);

      // A comment from the box reaches gh and shows in the conversation.
      await js(`${visible('[data-testid=git-pr-view-conversation]')}?.click()`);
      await wait(150);
      await js(`(() => { const set = ${setInput}; set(${visible('[data-testid=git-pr-comment-body]')}, 'Fixed in the next push'); })()`);
      await wait(100);
      await js(`${visible('[data-testid=git-pr-comment-submit]')}?.click()`);
      const commented = await waitFor(`[...(${visible('[data-testid=git-pr-tab]')}?.querySelectorAll('[data-testid=git-pr-comment]') ?? [])].some((c) => c.textContent.includes('Fixed in the next push'))`, 6000);
      check('git ui: Comment posts through gh and the comment shows', commented && (await fake.getState()).prs[0].comments.some((c) => c.body === 'Fixed in the next push'));

      // The form for a new pull request says the branch is not pushed yet.
      await click('[data-testid=git-open-prs]');
      await js(`${visible('[data-testid=git-pr-new]')}?.click()`);
      const pushNote = await waitFor(`${visible('[data-testid=git-pr-push-note]')}?.textContent.includes('not on GitHub yet')`, 4000);
      await waitFor(`${visible('[data-testid=git-pr-title]')}?.value === 'First commit'`, 3000);
      const prefilled = await js(`${visible('[data-testid=git-pr-title]')}?.value ?? null`);
      // ui/new-branch was made from feature, whose last commit is the first one.
      check('git ui: New pull request starts from the last commit and asks to publish an unpushed branch first', pushNote && prefilled === 'First commit', prefilled);
      await shot('32j-git-pr-new-light');

      // gh missing: a clear empty state instead of the list.
      process.env.QUIVER_GH_PATH = path.join(ghDir, 'no-such-gh.exe');
      await js(`${visible('[data-testid=git-prs-refresh]')}?.click()`);
      const missing = await waitFor(`${visible('[data-testid=git-gh-missing]')}?.getAttribute('data-reason') === 'no-gh'`, 6000);
      check('git ui: without gh the pull requests view says so instead of listing', missing);
      await shot('32k-git-prs-no-gh-light');

      // Back on the first workspace, the sidebar never shows this repository's files while it reads that one's.
      const shownHere = await waitFor(`Boolean(document.querySelector('[data-testid=git-file][data-path="notes.txt"]'))`);
      await click(`[data-testid=workspace-tab][data-drag-id="${mainWs.id}"]`);
      const leaked = await js(`Boolean(document.querySelector('[data-testid=git-file][data-path="notes.txt"]'))`);
      check('git ui: switching workspace drops the other repository\'s status at once', shownHere && leaked === false, { shownHere, leaked });
      const mainBranch = await run<GitStatus>('git.status', {}, mainWs.id).then((st) => st.branch, () => undefined);
      const itemThere = await until(async () => ((await statusItem()) as { branch: string } | null)?.branch === mainBranch || (mainBranch === undefined && (await statusItem()) === null), 4000);
      check('git ui: the status bar shows the branch of the workspace on screen, and nothing outside a repository', itemThere, { mainBranch, item: await statusItem() });
    } finally {
      // A dialog a failed step left open would block every later part.
      await js(`[...document.querySelectorAll('.fixed.inset-0 button')].find((b) => b.textContent.trim() === 'Cancel')?.click()`).catch(() => {});
      if (previousGh === undefined) delete process.env.QUIVER_GH_PATH;
      else process.env.QUIVER_GH_PATH = previousGh;
      await click(`[data-testid=workspace-tab][data-drag-id="${mainWs.id}"]`);
      await wait(200);
      if (ws) await run('workspace.close', { id: ws.id }, null).catch(() => {});
      await fs.rm(folder, { recursive: true, force: true }).catch(() => {});
      await fs.rm(ghDir, { recursive: true, force: true }).catch(() => {});
    }
  },
});

export default section;
