import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { GitBranch, GitCommit, GitDiffFile, GitStatus, HostEvents, WorkspaceInfo } from '@quiver/core';
import { runToEnd } from '@quiver/core/node';
import { until, type RpcResult, type SmokeSection } from '../../part';

// Git: the local repository through the git CLI, in a repository of its own made in a temporary folder.

interface LogPage {
  commits: GitCommit[];
  hasMore: boolean;
}

const section: SmokeSection = async (t) => {
  const { check, run, mcpPort } = t;
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'quiver-smoke-git-'));
  const sh = (...args: string[]) => runToEnd('git', args, { cwd: folder });
  const failure = (fn: () => Promise<unknown>) =>
    fn().then(
      () => '',
      (err: Error) => err.message,
    );

  // Every git.changed the host sends while this section runs.
  const events: HostEvents['git.changed'][] = [];
  const emit = t.host.emit;
  t.host.emit = ((event, payload) => {
    if (event === 'git.changed') events.push(payload as HostEvents['git.changed']);
    emit.call(t.host, event, payload);
  }) as typeof t.host.emit;

  let ws: WorkspaceInfo | undefined;
  try {
    ws = await run<WorkspaceInfo>('workspace.open', { path: folder }, null);
    const notRepo = await failure(() => run('git.status', {}, ws!.id));
    check('git: a folder that is not a repository says so', notRepo.includes('is not a git repository'), notRepo);

    await sh('init', '-q', '-b', 'main');
    await sh('config', 'user.name', 'Smoke');
    await sh('config', 'user.email', 'smoke@quiver.test');
    await sh('config', 'core.autocrlf', 'false');
    await fs.writeFile(path.join(folder, 'notes file.txt'), 'one\ntwo\n');
    await fs.writeFile(path.join(folder, 'other.txt'), 'other\n');

    const fresh = await run<GitStatus>('git.status', {}, ws.id);
    check(
      'git: status of a new repository shows the branch with no commits and the untracked files',
      fresh.branch === 'main' && fresh.head === null && fresh.files.some((f) => f.path === 'notes file.txt' && f.index === '?'),
      fresh,
    );
    check('git: log of a branch with no commits is empty', (await run<LogPage>('git.log', {}, ws.id)).commits.length === 0);

    const staged = await run<GitStatus>('git.stage', { paths: ['notes file.txt', 'other.txt'] }, ws.id);
    check('git: stage adds the files to the index', staged.files.filter((f) => f.index === 'A').length === 2, staged.files);
    const stagedDiff = await run<GitDiffFile[]>('git.diff', { staged: true }, ws.id);
    check(
      'git: staged diff shows the added file with its patch',
      stagedDiff.some((f) => f.path === 'notes file.txt' && f.status === 'added' && f.additions === 2 && f.patch?.includes('+two')),
      stagedDiff,
    );
    const unstaged = await run<GitStatus>('git.unstage', { paths: ['other.txt'] }, ws.id);
    check('git: unstage before the first commit takes the file out of the index', unstaged.files.some((f) => f.path === 'other.txt' && f.index === '?'), unstaged.files);

    await run('git.stage', { paths: ['other.txt'] }, ws.id);
    const first = await run<GitCommit>('git.commit', { message: 'First commit\n\nWith a body.' }, ws.id);
    check('git: commit records the staged files with the message', first.subject === 'First commit' && first.body === 'With a body.' && first.parents.length === 0, first);
    const nothing = await failure(() => run('git.commit', { message: 'again' }, ws!.id));
    check("git: commit with nothing staged fails with git's reason", /nothing (added )?to commit|no changes added/i.test(nothing), nothing);

    await fs.writeFile(path.join(folder, 'notes file.txt'), 'one\nTWO\nthree\n');
    const working = await run<GitDiffFile[]>('git.diff', {}, ws.id);
    check(
      'git: working diff shows the edit with line counts and patch',
      working.length === 1 && working[0].status === 'modified' && working[0].additions === 2 && working[0].deletions === 1 && Boolean(working[0].patch?.includes('-two')),
      working,
    );
    const statOnly = await run<GitDiffFile[]>('git.diff', { statOnly: true }, ws.id);
    check('git: statOnly diff leaves the patch out', statOnly.length === 1 && statOnly[0].patch === undefined);

    const created = await run<GitStatus>('git.branch.create', { name: 'feat/x' }, ws.id);
    check('git: branch.create switches to the new branch', created.branch === 'feat/x', created.branch);
    await run('git.stage', { paths: ['notes file.txt'] }, ws.id);
    const second = await run<GitCommit>('git.commit', { message: 'Edit notes' }, ws.id);
    const branches = await run<GitBranch[]>('git.branch.list', {}, ws.id);
    check(
      'git: branch.list has both branches, the new one current',
      branches.some((b) => b.name === 'feat/x' && b.current && b.head === second.hash) && branches.some((b) => b.name === 'main' && !b.current && b.head === first.hash),
      branches,
    );

    const back = await run<GitStatus>('git.checkout', { ref: 'main' }, ws.id);
    const content = await fs.readFile(path.join(folder, 'notes file.txt'), 'utf8');
    check('git: checkout switches the branch and the files', back.branch === 'main' && back.head === first.hash && content === 'one\ntwo\n', { branch: back.branch, content });

    const between = await run<GitDiffFile[]>('git.diff', { from: 'main', to: 'feat/x' }, ws.id);
    check('git: diff between two refs', between.length === 1 && between[0].path === 'notes file.txt' && Boolean(between[0].patch?.includes('+three')), between);
    const shown = await run<{ commit: GitCommit; files: GitDiffFile[] }>('git.show', { ref: 'feat/x' }, ws.id);
    check('git: show gives the commit and its changes', shown.commit.hash === second.hash && shown.files.length === 1 && shown.files[0].additions === 2, shown.commit.subject);
    const root = await run<{ commit: GitCommit; files: GitDiffFile[] }>('git.show', { ref: first.hash }, ws.id);
    check('git: show of the root commit lists its files as added', root.files.length === 2 && root.files.every((f) => f.status === 'added'), root.files.map((f) => f.path));

    const page = await run<LogPage>('git.log', { ref: 'feat/x', limit: 1 }, ws.id);
    const next = await run<LogPage>('git.log', { ref: 'feat/x', limit: 1, skip: 1 }, ws.id);
    check(
      'git: log pages newest first',
      page.commits[0]?.hash === second.hash && page.hasMore && next.commits[0]?.hash === first.hash && !next.hasMore && page.commits[0].refs.includes('feat/x'),
      { page, next },
    );
    const byPath = await run<LogPage>('git.log', { ref: 'feat/x', path: 'other.txt' }, ws.id);
    check('git: log by path only lists commits touching it', byPath.commits.length === 1 && byPath.commits[0].hash === first.hash, byPath.commits.map((c) => c.subject));

    // A change made outside Quiver reaches the view through the watcher.
    events.length = 0;
    await sh('checkout', '-q', 'feat/x');
    const watched = await until(() => events.some((e) => e.workspaceId === ws!.id && e.reason === 'status') && events.some((e) => e.reason === 'branches'), 5000);
    check('git: a checkout in a terminal emits git.changed for status and branches', watched, events);

    const optionLike = await failure(() => run('git.log', { ref: '--output=pwned.txt' }, ws!.id));
    check('git: a ref that looks like an option is refused', optionLike.length > 0 && !(await fs.stat(path.join(folder, 'pwned.txt')).catch(() => null)), optionLike);

    // Agents: reads go through, anything that changes the repository is refused until mutations are allowed.
    const mcpUrl = `http://127.0.0.1:${mcpPort}/mcp?workspace=${encodeURIComponent(folder)}`;
    const rpc = async (name: string, args: unknown): Promise<RpcResult> => {
      const res = await fetch(mcpUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      });
      return (await res.json()) as RpcResult;
    };
    const agentStatus = await rpc('git_status', {});
    const agentStatusText = agentStatus.result?.content?.[0]?.text ?? '';
    check('git: agents can read the status', !agentStatus.result?.isError && (JSON.parse(agentStatusText || '{}') as GitStatus).branch === 'feat/x', agentStatusText.slice(0, 200));
    const agentDiff = await rpc('git_diff', { from: 'main', to: 'feat/x' });
    check('git: agents can read a diff', !agentDiff.result?.isError, agentDiff.result?.content?.[0]?.text?.slice(0, 200));
    for (const [tool, args] of [
      ['git_commit', { message: 'agent' }],
      ['git_checkout', { ref: 'main' }],
      ['git_stage', { paths: ['.'] }],
      ['git_push', {}],
    ] as const) {
      const blocked = await rpc(tool, args);
      check(`git: ${tool} is gated for agents`, blocked.result?.isError === true && (blocked.result.content?.[0]?.text ?? '').includes('MUTATION_BLOCKED'), blocked.result?.content?.[0]?.text);
    }
    check('git: the gated calls changed nothing', (await run<GitStatus>('git.status', {}, ws.id)).branch === 'feat/x');
  } finally {
    t.host.emit = emit;
    if (ws) await run('workspace.close', { id: ws.id }, null).catch(() => {});
    await fs.rm(folder, { recursive: true, force: true }).catch(() => {});
  }
};

export default section;
