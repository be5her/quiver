import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { GitCommit, GitDiffFile, GitStatus, WorkspaceInfo } from '@quiver/core';
import { runToEnd } from '@quiver/core/node';
import { writeFakeGh, type FakeGhPr, type FakeGhState } from '../../fake-gh';
import { until, type SmokeSection } from '../../part';

// The Git panel, on a repository of its own in a temporary folder opened as a second workspace: a file changed on disk
// shows in the sidebar, its diff opens side by side and inline, it is staged and committed from the commit box, the
// commit shows in the history, a branch is made from a dialog and another switched to from the list, a merge conflict
// gets a note rather than a diff; then the pull
// requests against the fake gh of parts/git/pr.ts, with their check badges, a detail tab with the failed log on demand,
// and the empty state when gh is missing.

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

      // A file changed on disk shows under Changes (the status is read again on refresh, focus and every few seconds).
      await fs.writeFile(path.join(folder, 'app.txt'), 'one\nTWO\nthree\nfour\nfive\n');
      await fs.writeFile(path.join(folder, 'notes.txt'), 'new\n');
      await click('[data-testid=git-refresh]');
      const changed = await waitFor(`Boolean(document.querySelector('[data-testid=git-file][data-group=unstaged][data-path="app.txt"]')) && Boolean(document.querySelector('[data-testid=git-file][data-group=untracked][data-path="notes.txt"]'))`);
      check('git ui: a changed file shows under Changes and a new one under Untracked', changed);
      await shot('32a-git-sidebar-changes-light');

      // Its diff, side by side and then inline.
      await click('[data-testid=git-file][data-group=unstaged][data-path="app.txt"]');
      await waitFor(`Boolean(${visible('[data-testid=git-patch]')})`);
      const split = await js(
        `(() => { const t = ${visible('[data-testid=git-diff-tab]')}; const p = t?.querySelector('[data-testid=git-patch]'); return p ? { kind: t.getAttribute('data-kind'), path: t.getAttribute('data-path'), mode: p.getAttribute('data-mode'), del: [...p.querySelectorAll('td[data-kind=del]')].map((e) => e.textContent), add: [...p.querySelectorAll('td[data-kind=add]')].map((e) => e.textContent) } : null; })()`,
      );
      check(
        'git ui: clicking the file opens its working diff side by side, the edit paired with the old line',
        JSON.stringify(split) === JSON.stringify({ kind: 'working', path: 'app.txt', mode: 'split', del: ['two'], add: ['TWO', 'five'] }),
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
      const commitTab = await waitFor(`${visible('[data-testid=git-diff-tab]')}?.getAttribute('data-kind') === 'commit' && Boolean(${visible('[data-testid=git-patch]')})`);
      check('git ui: a commit opens in a diff tab of its own', commitTab);

      // Switch branch from the list, then make one from the dialog.
      await waitFor(`Boolean(document.querySelector('[data-testid=git-branch][data-name=feature]'))`);
      await click('[data-testid=git-branch][data-name=feature]');
      const switched = await waitFor(`document.querySelector('[data-testid=git-current-branch]')?.textContent.trim() === 'feature'`);
      check('git ui: clicking a branch switches to it', switched && (await run<GitStatus>('git.status', {}, id)).branch === 'feature');
      await click('[data-testid=git-new-branch]');
      await wait(250);
      const dialogTitle = await js(`document.querySelector('.fixed.inset-0 h2')?.textContent.trim() ?? null`);
      await js(
        `(() => { const set = ${setInput}; const form = document.querySelector('.fixed.inset-0 form'); set(form.querySelector('input'), 'ui/new-branch'); [...form.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Create and switch')?.click(); })()`,
      );
      const created = await waitFor(`document.querySelector('[data-testid=git-current-branch]')?.textContent.trim() === 'ui/new-branch'`);
      check('git ui: New branch asks for a name, creates the branch and switches to it', dialogTitle === 'New branch' && created, dialogTitle);

      // A merge conflict: the file is listed once, under Merge conflicts, and its tab says to resolve it rather than
      // drawing the combined diff. The host pairs it with its own patch, so another changed file still has its diff.
      await sh('checkout', '-q', '-b', 'ui/conflict');
      await fs.writeFile(path.join(folder, 'app.txt'), 'one\nother\n');
      await sh('commit', '-q', '-am', 'Other app');
      await sh('merge', '-q', 'main');
      await fs.writeFile(path.join(folder, 'readme.md'), '# Smoke, edited\n');
      await click('[data-testid=git-refresh]');
      const conflictRow = await waitFor(`document.querySelectorAll('[data-testid=git-file][data-path="app.txt"]').length === 1 && Boolean(document.querySelector('[data-testid=git-file][data-group=conflicts][data-path="app.txt"]'))`);
      await click('[data-testid=git-file][data-group=conflicts][data-path="app.txt"]');
      const conflictNote = await waitFor(`${visible('[data-testid=git-diff-tab][data-path="app.txt"]')}?.querySelector('[data-testid=git-patch-note]')?.getAttribute('data-conflict') === 'true'`);
      const working = await run<GitDiffFile[]>('git.diff', { staged: false }, id);
      const pairs = working.map((d) => ({ path: d.path, patch: d.patch?.slice(0, 10) ?? null, truncated: Boolean(d.truncated) }));
      check(
        'git ui: a conflicted file is listed once and its tab says to resolve it; the other files keep their diffs',
        conflictRow && conflictNote && JSON.stringify(pairs) === JSON.stringify([{ path: 'app.txt', patch: 'diff --cc ', truncated: false }, { path: 'readme.md', patch: 'diff --git', truncated: false }]),
        { conflictRow, conflictNote, pairs },
      );
      await sh('merge', '--abort');
      await sh('checkout', '-q', '--', 'readme.md');
      await sh('checkout', '-q', 'ui/new-branch');
      await click('[data-testid=git-refresh]');
      await waitFor(`document.querySelector('[data-testid=git-current-branch]')?.textContent.trim() === 'ui/new-branch' && !document.querySelector('[data-testid=git-group][data-group=conflicts]')`);

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
