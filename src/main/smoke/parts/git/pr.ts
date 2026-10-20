import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { GhStatus, GitDiffFile, GitPrCheckWithLog, GitPullRequest, GitPullRequestDetail, GitStatus, HostEvents, WorkspaceInfo } from '@quiver/core';
import { runToEnd } from '@quiver/core/node';
import { writeFakeGh, type FakeGhPr, type FakeGhState } from '../../fake-gh';
import type { RpcResult, SmokeSection } from '../../part';

// Git: pull requests through gh, against a fake gh (fake-gh.ts) pointed at with QUIVER_GH_PATH, in a repository of its
// own whose origin is on github.com. The fake and the variable are cleaned up in this section's `after` hook.

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
    ...over,
  };
}

const JOB_LOG = [
  'test\tRun npm test\t﻿2026-10-20T10:01:00.0000000Z ##[group]Run npm test',
  'test\tRun npm test\t2026-10-20T10:01:01.0000000Z \u001b[31mFAIL\u001b[0m src/x.test.ts > adds',
  'test\tRun npm test\t2026-10-20T10:01:02.0000000Z ##[error]Process completed with exit code 1.',
  '',
].join('\n');

const DIFF = ['diff --git a/src/x.ts b/src/x.ts', 'index 1..2 100644', '--- a/src/x.ts', '+++ b/src/x.ts', '@@ -1 +1,2 @@', '-old', '+new', '+more', ''].join('\n');

function initialState(): FakeGhState {
  const run = (name: string, conclusion: string, job: number) => ({ __typename: 'CheckRun', name, workflowName: 'CI', status: 'COMPLETED', conclusion, detailsUrl: `https://github.com/${REPO}/actions/runs/7/job/${job}` });
  return {
    login: null,
    repo: REPO,
    prs: [
      pr(1, {
        title: 'Mine, failing',
        labels: [{ name: 'bug' }],
        statusCheckRollup: [run('build', 'SUCCESS', 70), run('test', 'FAILURE', 71)],
        body: 'Fixes the thing.',
        additions: 2,
        deletions: 1,
        files: [{ path: 'src/x.ts', additions: 2, deletions: 1 }],
        reviews: [{ author: { login: 'reviewer' }, state: 'CHANGES_REQUESTED', submittedAt: '2026-10-20T11:00:00Z', body: 'Please fix' }],
        comments: [{ author: { login: 'reviewer' }, createdAt: '2026-10-20T11:01:00Z', body: 'And a test' }],
        reviewDecision: 'CHANGES_REQUESTED',
      }),
      pr(2, { title: 'Theirs, review wanted', author: { login: 'other' }, reviewRequested: ['smoke-user'], statusCheckRollup: [{ __typename: 'CheckRun', name: 'build', status: 'IN_PROGRESS', conclusion: '' }] }),
      pr(3, { title: 'Merged', state: 'MERGED', author: { login: 'other' } }),
    ],
    checks: {
      1: [
        { name: 'build', state: 'SUCCESS', bucket: 'pass', link: `https://github.com/${REPO}/actions/runs/7/job/70`, workflow: 'CI', startedAt: '2026-10-20T10:00:00Z', completedAt: '2026-10-20T10:02:00Z' },
        { name: 'test', state: 'FAILURE', bucket: 'fail', link: `https://github.com/${REPO}/actions/runs/7/job/71`, workflow: 'CI', startedAt: '2026-10-20T10:00:00Z', completedAt: '2026-10-20T10:01:02Z' },
        { name: 'external', state: 'FAILURE', bucket: 'fail', link: 'https://ci.example.com/build/9', workflow: '' },
      ],
      2: [{ name: 'build', state: 'IN_PROGRESS', bucket: 'pending', link: '', workflow: 'CI', startedAt: '2026-10-20T10:00:00Z', completedAt: '0001-01-01T00:00:00Z' }],
    },
    jobLogs: { 71: JOB_LOG },
    diffs: { 1: DIFF },
    opened: [],
  };
}

const section: SmokeSection = async (t) => {
  const { check, run, mcpPort } = t;
  const ghDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quiver-smoke-gh-'));
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'quiver-smoke-gh-repo-'));
  const fake = await writeFakeGh(ghDir, initialState());
  const previousGh = process.env.QUIVER_GH_PATH;
  const after = async () => {
    if (previousGh === undefined) delete process.env.QUIVER_GH_PATH;
    else process.env.QUIVER_GH_PATH = previousGh;
    await fs.rm(ghDir, { recursive: true, force: true }).catch(() => {});
  };
  const sh = (...args: string[]) => runToEnd('git', args, { cwd: folder });
  const failure = (fn: () => Promise<unknown>) =>
    fn().then(
      () => '',
      (err: Error & { code?: string }) => `${err.code ?? ''} ${err.message}`,
    );

  const events: HostEvents['git.changed'][] = [];
  const emit = t.host.emit;
  t.host.emit = ((event, payload) => {
    if (event === 'git.changed') events.push(payload as HostEvents['git.changed']);
    emit.call(t.host, event, payload);
  }) as typeof t.host.emit;

  let ws: WorkspaceInfo | undefined;
  try {
    await sh('init', '-q', '-b', 'main');
    await sh('config', 'user.name', 'Smoke');
    await sh('config', 'user.email', 'smoke@quiver.test');
    await sh('config', 'core.autocrlf', 'false');
    await fs.writeFile(path.join(folder, 'readme.txt'), 'hi\n');
    await sh('add', '.');
    await sh('commit', '-q', '-m', 'first');
    await sh('remote', 'add', 'origin', 'https://oauth2:glpat-smoke-token@gitlab.com/smoke/quiver.git');
    ws = await run<WorkspaceInfo>('workspace.open', { path: folder }, null);
    const id = ws.id;

    // gh missing.
    process.env.QUIVER_GH_PATH = path.join(ghDir, 'no-such-gh.exe');
    const missing = await run<GhStatus>('git.pr.status', {}, id);
    check('git pr: status says when gh is not installed', !missing.installed && !missing.authenticated && /not found.*cli\.github\.com/s.test(missing.message ?? ''), missing);
    const missingList = await failure(() => run('git.pr.list', {}, id));
    check('git pr: commands fail clearly without gh', missingList.includes('NOT_FOUND') && missingList.includes('GitHub CLI (gh) was not found'), missingList);
    process.env.QUIVER_GH_PATH = fake.command;

    // Signed out, and a repository that is not on GitHub.
    const signedOut = await run<GhStatus>('git.pr.status', {}, id);
    check('git pr: status says gh is signed out', signedOut.installed && !signedOut.authenticated && (signedOut.message ?? '').includes('gh auth login'), signedOut);
    await fake.update((s) => {
      s.login = 'smoke-user';
    });
    const notGithub = await run<GhStatus>('git.pr.status', {}, id);
    check('git pr: status says when no remote is on GitHub', notGithub.authenticated && !notGithub.repo && (notGithub.message ?? '').includes('No remote of this repository is on GitHub'), notGithub);
    const notGithubList = await failure(() => run('git.pr.list', {}, id));
    check('git pr: commands fail clearly when the repository is not on GitHub', notGithubList.includes('NOT_FOUND') && notGithubList.includes('gitlab.com'), notGithubList);
    check('git pr: a token in a remote URL is not shown', !`${notGithub.message} ${notGithubList}`.includes('glpat-smoke-token'), { notGithub, notGithubList });

    await sh('remote', 'set-url', 'origin', `https://github.com/${REPO}.git`);
    await fake.update((s) => {
      s.login = null;
    });
    const outList = await failure(() => run('git.pr.list', {}, id));
    check('git pr: a signed-out gh is AUTH_REQUIRED with what to run', outList.includes('AUTH_REQUIRED') && outList.includes('gh auth login'), outList);
    await fake.update((s) => {
      s.login = 'smoke-user';
    });
    const ready = await run<GhStatus>('git.pr.status', {}, id);
    check('git pr: status gives the user and the repository', ready.installed && ready.authenticated && ready.user === 'smoke-user' && ready.repo === REPO && !ready.message, ready);

    // Reads.
    const open = await run<GitPullRequest[]>('git.pr.list', {}, id);
    const first = open.find((p) => p.number === 1);
    check(
      'git pr: list gives the open pull requests with their check roll-up and review decision',
      open.map((p) => p.number).join() === '2,1' &&
        first?.checks.state === 'failure' &&
        first.checks.passed === 1 &&
        first.reviewDecision === 'changes_requested' &&
        first.labels.join() === 'bug' &&
        open.find((p) => p.number === 2)?.checks.state === 'pending',
      open,
    );
    const mine = await run<GitPullRequest[]>('git.pr.list', { filter: 'mine' }, id);
    const review = await run<GitPullRequest[]>('git.pr.list', { filter: 'review-requested' }, id);
    const merged = await run<GitPullRequest[]>('git.pr.list', { state: 'merged' }, id);
    check('git pr: list filters mine, review-requested and merged', mine.map((p) => p.number).join() === '1' && review.map((p) => p.number).join() === '2' && merged.map((p) => `${p.number}${p.state}`).join() === '3merged', { mine, review, merged });

    const detail = await run<GitPullRequestDetail>('git.pr.get', { number: 1 }, id);
    check(
      'git pr: get gives the body, files, reviews and comments',
      detail.body === 'Fixes the thing.' && detail.files[0]?.path === 'src/x.ts' && detail.reviews[0]?.author === 'reviewer' && detail.comments[0]?.body === 'And a test',
      detail,
    );
    const missingPr = await failure(() => run('git.pr.get', { number: 99 }, id));
    check("git pr: a pull request that does not exist gives gh's message", missingPr.includes('REQUEST_FAILED') && missingPr.includes('Could not resolve'), missingPr);

    const checks = await run<GitPrCheckWithLog[]>('git.pr.checks', { number: 1, failedLogs: true }, id);
    const failed = checks.find((c) => c.name === 'test');
    check(
      'git pr: checks of a failing pull request (gh exits 1) come with the end of the failed log',
      checks.length === 3 &&
        checks[0].state === 'success' &&
        failed?.state === 'failure' &&
        (failed.log ?? '').includes('## Run npm test') &&
        (failed.log ?? '').includes('FAIL src/x.test.ts > adds') &&
        !(failed.log ?? '').includes('2026-10-20T') &&
        !(failed.log ?? '').includes('\u001b'),
      checks,
    );
    check('git pr: a failed check that is not an Actions job says where its log is', (checks.find((c) => c.name === 'external')?.logError ?? '').includes('Not a GitHub Actions job'), checks[2]);
    const plain = await run<GitPrCheckWithLog[]>('git.pr.checks', { number: 1 }, id);
    check('git pr: checks without failedLogs read no logs', plain.every((c) => c.log === undefined), plain);
    const pending = await run<GitPrCheckWithLog[]>('git.pr.checks', { number: 2 }, id);
    check('git pr: checks still running (gh exits 8) are pending, with no zero times', pending.length === 1 && pending[0].state === 'pending' && !pending[0].completedAt, pending);
    const none = await run<GitPrCheckWithLog[]>('git.pr.checks', { number: 3 }, id);
    check('git pr: a pull request with no checks has none', Array.isArray(none) && none.length === 0, none);

    const diff = await run<GitDiffFile[]>('git.pr.diff', { number: 1 }, id);
    check('git pr: diff gives per-file counts and patches', diff.length === 1 && diff[0].path === 'src/x.ts' && diff[0].additions === 2 && diff[0].deletions === 1 && (diff[0].patch ?? '').includes('+more'), diff);

    await run('git.pr.open', { number: 1 }, id);
    check('git pr: open hands the pull request to gh --web', (await fake.getState()).opened.join() === '1');

    // Refresh: the first call takes a baseline, a change is announced once.
    events.length = 0;
    const baseline = await run<{ changed: boolean }>('git.pr.refresh', { force: true }, id);
    const quiet = await run<{ changed: boolean }>('git.pr.refresh', { force: true }, id);
    await fake.update((s) => {
      s.prs[1].statusCheckRollup = [{ __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' }];
    });
    const limited = await run<{ changed: boolean }>('git.pr.refresh', {}, id);
    const moved = await run<{ changed: boolean }>('git.pr.refresh', { force: true }, id);
    check(
      'git pr: refresh announces a finished check run once, as git.changed prs, and at most every 30s unless forced',
      !baseline.changed && !quiet.changed && !limited.changed && moved.changed && events.filter((e) => e.reason === 'prs' && e.workspaceId === id).length === 1,
      { baseline, quiet, limited, moved, events },
    );

    // Writes: create from a pushed branch (on a fork), comment, checkout.
    await sh('checkout', '-q', '-b', 'feat/new');
    const unpushed = await failure(() => run('git.pr.create', { title: 'New' }, id));
    check('git pr: create from a branch that was never pushed says to push it', unpushed.includes('has not been pushed'), unpushed);
    const optionLike = await failure(() => run('git.pr.create', { title: 'New', labels: ['--web'] }, id));
    check('git pr: an option-like label is refused', optionLike.includes('INVALID_INPUT') || optionLike.includes('must not start with'), optionLike);
    const commaLabel = await failure(() => run('git.pr.create', { title: 'New', labels: ['needs review, urgent'] }, id));
    check('git pr: a label with a comma (which gh would split) is refused', commaLabel.includes('INVALID_INPUT') && commaLabel.includes('comma'), commaLabel);
    // git checkout -b x origin/main tracks origin/main: that says nothing about x being pushed.
    await sh('config', 'branch.feat/new.remote', 'origin');
    await sh('config', 'branch.feat/new.merge', 'refs/heads/main');
    const tracksBase = await failure(() => run('git.pr.create', { title: 'New', base: 'main' }, id));
    check('git pr: a branch whose upstream is the base itself counts as not pushed', tracksBase.includes('has not been pushed'), tracksBase);
    await sh('remote', 'add', 'fork', 'git@github.com:forker/quiver.git');
    await sh('config', 'branch.feat/new.remote', 'fork');
    await sh('config', 'branch.feat/new.merge', 'refs/heads/feat/new');
    events.length = 0;
    const created = await run<GitPullRequest>('git.pr.create', { title: '--draft is part of the title', body: 'Line one\n--label=x\n', draft: true, labels: ['enhancement'] }, id);
    const createCall = (await fake.calls()).find((c) => c.argv[0] === 'pr' && c.argv[1] === 'create');
    check(
      'git pr: create opens the pull request from the fork branch, title and body kept literal',
      created.number === 4 &&
        created.title === '--draft is part of the title' &&
        created.draft &&
        created.labels.join() === 'enhancement' &&
        Boolean(createCall?.argv.includes('--head=forker:feat/new')) &&
        createCall?.stdin === 'Line one\n--label=x\n' &&
        events.some((e) => e.reason === 'prs'),
      { created, createCall },
    );
    const commented = await run<{ url: string }>('git.pr.comment', { number: 1, body: 'Looks good' }, id);
    const afterComment = (await fake.getState()).prs[0].comments;
    check('git pr: comment adds the body and gives back its address', commented.url.endsWith('#issuecomment-2') && afterComment[1]?.body === 'Looks good', { commented, afterComment });

    events.length = 0;
    const checkedOut = await run<GitStatus>('git.pr.checkout', { number: 2 }, id);
    check('git pr: checkout switches to the pull request branch and announces it', checkedOut.branch === 'feat/2' && events.some((e) => e.reason === 'status') && events.some((e) => e.reason === 'branches'), { checkedOut, events });

    const calls = await fake.calls();
    const repoCalls = calls.filter((c) => c.argv[0] === 'pr' || c.argv[0] === 'run');
    check(
      'git pr: every gh call names the repository with --repo and runs in the repository root',
      repoCalls.length > 10 && repoCalls.every((c) => c.argv[c.argv.indexOf('--repo') + 1] === REPO) && repoCalls.every((c) => path.resolve(c.cwd).toLowerCase() === path.resolve(folder).toLowerCase()),
      repoCalls.filter((c) => c.argv[c.argv.indexOf('--repo') + 1] !== REPO).slice(0, 3),
    );

    // Agents: reads go through, writes are gated.
    const mcpUrl = `http://127.0.0.1:${mcpPort}/mcp?workspace=${encodeURIComponent(folder)}`;
    const rpc = async (name: string, args: unknown): Promise<RpcResult> => {
      const res = await fetch(mcpUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      });
      return (await res.json()) as RpcResult;
    };
    const agentList = await rpc('git_pr_list', {});
    check('git pr: agents can list pull requests', !agentList.result?.isError && (agentList.result?.content?.[0]?.text ?? '').includes('Theirs, review wanted'), agentList.result?.content?.[0]?.text?.slice(0, 200));
    const agentChecks = await rpc('git_pr_checks', { number: 1, failedLogs: true });
    check('git pr: agents can read checks with failed logs', !agentChecks.result?.isError && (agentChecks.result?.content?.[0]?.text ?? '').includes('Process completed with exit code 1'), agentChecks.result?.content?.[0]?.text?.slice(0, 200));
    const before = (await fake.calls()).length;
    for (const [tool, args] of [
      ['git_pr_create', { title: 'agent' }],
      ['git_pr_comment', { number: 1, body: 'agent' }],
      ['git_pr_checkout', { number: 1 }],
    ] as const) {
      const blocked = await rpc(tool, args);
      check(`git pr: ${tool} is gated for agents`, blocked.result?.isError === true && (blocked.result.content?.[0]?.text ?? '').includes('MUTATION_BLOCKED'), blocked.result?.content?.[0]?.text);
    }
    check('git pr: the gated calls never reached gh', (await fake.calls()).length === before);
    check('git pr: the refresh is plumbing, not an agent tool', !t.toolNames.includes('git_pr_refresh') && t.toolNames.includes('git_pr_status'), t.toolNames.filter((n) => n.startsWith('git_pr')));
  } catch (err) {
    await after();
    throw err;
  } finally {
    t.host.emit = emit;
    if (ws) await run('workspace.close', { id: ws.id }, null).catch(() => {});
    await fs.rm(folder, { recursive: true, force: true }).catch(() => {});
  }
  return { after };
};

export default section;
