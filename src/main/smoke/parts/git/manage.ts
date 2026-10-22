import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { GitBranch, GitCommit, GitDiffFile, GitFileContent, GitOperationResult, GitStash, GitStatus, GitTag, HostEvents, WorkspaceInfo } from '@quiver/core';
import { runToEnd } from '@quiver/core/node';
import { until, type RpcResult, type SmokeSection } from '../../part';

// Git: managing the local repository (branches, merge and rebase with their conflicts, cherry-pick, revert, reset,
// stashes, discard, tags and a file at a ref), in a repository of its own made in a temporary folder with a bare
// clone as its remote.

interface LogPage {
  commits: GitCommit[];
  hasMore: boolean;
}

const section: SmokeSection = async (t) => {
  const { check, run, mcpPort } = t;
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'quiver-smoke-git-manage-'));
  const bare = await fs.mkdtemp(path.join(os.tmpdir(), 'quiver-smoke-git-manage-remote-'));
  const sh = (...args: string[]) => runToEnd('git', args, { cwd: folder });
  const inBare = (...args: string[]) => runToEnd('git', args, { cwd: bare });
  const write = (name: string, content: string | Buffer) => fs.writeFile(path.join(folder, name), content);
  const read = (name: string) => fs.readFile(path.join(folder, name), 'utf8').catch(() => null);
  const exists = (name: string) => fs.stat(path.join(folder, name)).then(() => true, () => false);
  /** A call that should fail: its message and `details.reason`, both empty when it went through. */
  const failure = async (command: string, input: unknown) => {
    const out = await t.host.invoke(command, input, { caller: 'ui', workspaceId: ws?.id ?? null });
    if (out.ok) return { message: '', reason: undefined };
    return { message: out.error.message, reason: (out.error.details as { reason?: string } | undefined)?.reason };
  };
  const commit = async (file: string, content: string, message: string) => {
    await write(file, content);
    await sh('add', '--', file);
    await sh('commit', '-q', '-m', message);
    return (await sh('rev-parse', 'HEAD')).stdout.trim();
  };

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
    await write('.gitignore', '.quiver/\n*.log\n');
    await sh('add', '.gitignore');
    await commit('a.txt', 'base\n', 'Base');
    ws = await run<WorkspaceInfo>('workspace.open', { path: folder }, null);
    const id = ws.id;
    const st = () => run<GitStatus>('git.status', {}, id);
    const list = () => run<GitBranch[]>('git.branch.list', {}, id);
    const head = async () => (await sh('rev-parse', 'HEAD')).stdout.trim();

    // ---- Delete ----
    await sh('branch', 'merged-one');
    await sh('checkout', '-q', '-b', 'unmerged');
    await commit('u.txt', 'unmerged\n', 'Unmerged work');
    await sh('checkout', '-q', 'main');
    const before = await list();
    check(
      'git manage: branch.list marks a branch merged into the default branch (a local main, with no origin/HEAD), and neither main nor an unmerged one',
      before.find((b) => b.name === 'merged-one')?.merged === true && before.find((b) => b.name === 'unmerged')?.merged === false && before.find((b) => b.name === 'main')?.merged === false,
      before.map((b) => [b.name, b.merged]),
    );
    const current = await failure('git.branch.delete', { name: 'main' });
    check('git manage: delete refuses the current branch', current.reason === 'current-branch', current);
    const unmerged = await failure('git.branch.delete', { name: 'unmerged' });
    check('git manage: delete refuses an unmerged branch without force, and keeps it', unmerged.reason === 'not-merged' && (await list()).some((b) => b.name === 'unmerged'), unmerged);
    await run('git.branch.delete', { name: 'unmerged', force: true }, id);
    await run('git.branch.delete', { name: 'merged-one' }, id);
    const afterDelete = (await list()).map((b) => b.name);
    check('git manage: delete with force drops the unmerged branch, and a merged one goes without', !afterDelete.includes('unmerged') && !afterDelete.includes('merged-one'), afterDelete);
    // The default branch is no proof for itself: a local main with commits nothing else holds is never deleted without force.
    await sh('checkout', '-q', '-b', 'side');
    await sh('checkout', '-q', 'main');
    const mainOnly = await commit('m.txt', 'main only\n', 'Main only');
    await sh('checkout', '-q', 'side');
    const defaultItself = await failure('git.branch.delete', { name: 'main' });
    const mainKept = (await sh('rev-parse', '--verify', '--quiet', 'refs/heads/main')).stdout.trim() === mainOnly;
    await sh('checkout', '-q', 'main');
    await sh('branch', '-q', '-D', 'side');
    check('git manage: delete refuses the default branch itself when its commits are nowhere else, and keeps it', defaultItself.reason === 'not-merged' && mainKept, { defaultItself, mainKept });

    // ---- Rename and upstream, against a bare clone as origin ----
    await inBare('init', '-q', '--bare', '-b', 'main');
    await sh('remote', 'add', 'origin', bare);
    await sh('push', '-q', 'origin', 'main');
    await sh('fetch', '-q', 'origin');
    await sh('branch', 'old-name');
    await run('git.branch.rename', { from: 'old-name', to: 'new-name' }, id);
    const renamed = (await list()).map((b) => b.name);
    check('git manage: rename moves the branch to its new name', renamed.includes('new-name') && !renamed.includes('old-name'), renamed);
    await run('git.branch.setUpstream', { branch: 'new-name', upstream: 'origin/main' }, id);
    const tracked = (await list()).find((b) => b.name === 'new-name');
    await run('git.branch.setUpstream', { branch: 'new-name', upstream: null }, id);
    const untracked = (await list()).find((b) => b.name === 'new-name');
    check('git manage: setUpstream sets the upstream and null unsets it', tracked?.upstream === 'origin/main' && untracked?.upstream === undefined, { tracked, untracked });

    // A branch whose upstream was deleted on the remote is gone after a fetch that prunes.
    await sh('push', '-q', '-u', 'origin', 'main:gone-branch');
    await sh('branch', 'gone-branch', 'main');
    await sh('branch', '--set-upstream-to=origin/gone-branch', 'gone-branch');
    await inBare('branch', '-D', 'gone-branch');
    await run('git.fetch', { remote: 'origin' }, id);
    check('git manage: a branch whose upstream was pruned is listed as gone', (await list()).find((b) => b.name === 'gone-branch')?.gone === true, (await list()).find((b) => b.name === 'gone-branch'));

    // Delete on the remote: the branch goes there and from the remote-tracking branches; the default branch never does.
    await sh('push', '-q', 'origin', 'main:remote-only');
    await sh('fetch', '-q', 'origin');
    await run('git.branch.deleteRemote', { remote: 'origin', name: 'remote-only' }, id);
    const bareHeads = (await inBare('branch', '--list')).stdout;
    check('git manage: deleteRemote deletes the branch on the remote and its remote-tracking branch', !bareHeads.includes('remote-only') && !(await list()).some((b) => b.name === 'origin/remote-only'), bareHeads);
    const defaultRefused = await failure('git.branch.deleteRemote', { remote: 'origin', name: 'main' });
    const refspecRefused = await failure('git.branch.deleteRemote', { remote: 'origin', name: ':main' });
    const fullRefRefused = await failure('git.branch.deleteRemote', { remote: 'origin', name: 'refs/heads/main' });
    check(
      "git manage: deleteRemote refuses the remote's default branch, a refspec and a full ref name, and main stays",
      defaultRefused.reason === 'default-branch' && refspecRefused.message.includes('not a branch name') && fullRefRefused.message.includes('not a branch name') && (await inBare('branch', '--list')).stdout.includes('main'),
      { defaultRefused, refspecRefused, fullRefRefused },
    );

    // ---- Merge: stops on a conflict, abort, then continue ----
    await sh('checkout', '-q', '-b', 'side');
    await commit('a.txt', 'side\n', 'Side edit');
    await sh('checkout', '-q', 'main');
    await commit('a.txt', 'main\n', 'Main edit');
    const mainBefore = await head();
    const stopped = await run<GitOperationResult>('git.merge', { ref: 'side' }, id);
    check('git manage: a merge that conflicts succeeds, listing the conflict, with the merge in progress', JSON.stringify(stopped.conflicts) === '["a.txt"]' && stopped.status.operation === 'merge', { conflicts: stopped.conflicts, operation: stopped.status.operation });
    const busy = await failure('git.rebase', { onto: 'side' });
    const unresolved = await failure('git.operation.continue', {});
    const noSkip = await failure('git.operation.skip', {});
    check(
      'git manage: while a merge is in progress another operation, a continue with unresolved conflicts and a skip are refused',
      busy.reason === 'operation-in-progress' && unresolved.reason === 'unresolved' && noSkip.message.includes('cannot skip'),
      { busy, unresolved, noSkip },
    );
    const aborted = await run<GitOperationResult>('git.operation.abort', {}, id);
    check('git manage: abort ends the merge and puts the files back', aborted.status.operation === undefined && (await read('a.txt')) === 'main\n' && (await head()) === mainBefore, aborted.status);
    await run('git.merge', { ref: 'side', mode: 'no-ff' }, id);
    await write('a.txt', 'merged\n');
    await run('git.stage', { paths: ['a.txt'] }, id);
    const merged = await run<GitOperationResult>('git.operation.continue', {}, id);
    const mergeCommit = (await run<LogPage>('git.log', { limit: 1 }, id)).commits[0];
    check(
      "git manage: continue after resolving commits the merge with git's message, no editor",
      merged.conflicts.length === 0 && merged.status.operation === undefined && mergeCommit.parents.length === 2 && mergeCommit.subject === "Merge branch 'side'",
      { merged: merged.status, mergeCommit },
    );
    const noOperation = await failure('git.operation.continue', {});
    check('git manage: continue with nothing in progress says so', noOperation.reason === 'no-operation', noOperation);

    // ---- Rebase: stops, abort, then continue ----
    await sh('checkout', '-q', '-b', 'topic', 'HEAD~1');
    await commit('a.txt', 'topic\n', 'Topic edit');
    const topicBefore = await head();
    const rebaseStopped = await run<GitOperationResult>('git.rebase', { onto: 'main' }, id);
    check('git manage: a rebase that conflicts succeeds, listing the conflict, with the rebase in progress', rebaseStopped.conflicts.includes('a.txt') && rebaseStopped.status.operation === 'rebase', { conflicts: rebaseStopped.conflicts, operation: rebaseStopped.status.operation });
    const rebaseAborted = await run<GitOperationResult>('git.operation.abort', {}, id);
    check('git manage: abort ends the rebase on the branch as it was', rebaseAborted.status.operation === undefined && rebaseAborted.status.branch === 'topic' && (await head()) === topicBefore, rebaseAborted.status);
    await run('git.rebase', { onto: 'main' }, id);
    await write('a.txt', 'rebased\n');
    await run('git.stage', { paths: ['a.txt'] }, id);
    const rebased = await run<GitOperationResult>('git.operation.continue', {}, id);
    const rebasedLog = (await run<LogPage>('git.log', { limit: 2 }, id)).commits;
    check(
      'git manage: continue after resolving finishes the rebase, the commit replayed on main',
      rebased.status.operation === undefined && rebased.status.branch === 'topic' && rebasedLog[0]?.subject === 'Topic edit' && rebasedLog[1]?.hash === (await sh('rev-parse', 'main')).stdout.trim(),
      { status: rebased.status, log: rebasedLog.map((c) => c.subject) },
    );

    // ---- Cherry-pick, revert and reset ----
    await sh('checkout', '-q', 'main');
    await sh('checkout', '-q', '-b', 'picks');
    const picked = await commit('c.txt', 'picked\n', 'Add c');
    await sh('checkout', '-q', 'main');
    // main moves on first, or the picked commit would come out the same, hash and all, within the same second.
    await commit('d.txt', 'd\n', 'Add d');
    const cp = await run<GitOperationResult>('git.cherryPick', { commits: [picked] }, id);
    const top = (await run<LogPage>('git.log', { limit: 1 }, id)).commits[0];
    check('git manage: cherry-pick applies the commit on the current branch', cp.conflicts.length === 0 && top.subject === 'Add c' && top.hash !== picked && (await read('c.txt')) === 'picked\n', top);
    const pickedHere = top.hash;
    const rv = await run<GitOperationResult>('git.revert', { commit: 'HEAD' }, id);
    const reverted = (await run<LogPage>('git.log', { limit: 1 }, id)).commits[0];
    check('git manage: revert makes a commit undoing it', rv.conflicts.length === 0 && reverted.subject.startsWith('Revert "Add c"') && !(await exists('c.txt')), reverted.subject);
    const soft = await run<GitStatus>('git.reset', { ref: pickedHere, mode: 'soft' }, id);
    const mixed = await run<GitStatus>('git.reset', { ref: 'HEAD', mode: 'mixed' }, id);
    const hard = await run<GitStatus>('git.reset', { ref: 'HEAD', mode: 'hard' }, id);
    check(
      'git manage: reset soft keeps the change staged, mixed unstages it, hard discards it',
      soft.head === pickedHere &&
        soft.files.some((f) => f.path === 'c.txt' && f.index === 'D') &&
        mixed.files.some((f) => f.path === 'c.txt' && f.index === '.' && f.worktree === 'D') &&
        hard.files.length === 0 &&
        (await read('c.txt')) === 'picked\n',
      { soft: soft.files, mixed: mixed.files, hard: hard.files },
    );

    // ---- Stashes ----
    events.length = 0;
    await write('a.txt', 'stashed edit\n');
    const pushed = await run<GitStatus>('git.stash.push', { message: 'wip one' }, id);
    const one = await run<GitStash[]>('git.stash.list', {}, id);
    check(
      'git manage: stash push saves the change with its message and branch, and cleans the tree',
      pushed.files.length === 0 && one.length === 1 && one[0].index === 0 && one[0].message === 'wip one' && one[0].branch === 'main' && (await read('a.txt')) !== 'stashed edit\n',
      one,
    );
    check('git manage: stash push announces git.changed with reason stashes', await until(() => events.some((e) => e.workspaceId === id && e.reason === 'stashes'), 3000), events);
    await write('new.txt', 'untracked\n');
    const nothing = await failure('git.stash.push', {});
    await run('git.stash.push', { includeUntracked: true }, id);
    const two = await run<GitStash[]>('git.stash.list', {}, id);
    check(
      'git manage: stash push with only untracked files says nothing to stash, includeUntracked stashes them',
      nothing.reason === 'nothing-to-stash' && two.length === 2 && two[0].message.startsWith('WIP') && two[1].message === 'wip one' && !(await exists('new.txt')),
      { nothing, two },
    );
    const shown0 = await run<{ stash: GitStash; files: GitDiffFile[] }>('git.stash.show', { index: 0 }, id);
    const shown1 = await run<{ stash: GitStash; files: GitDiffFile[] }>('git.stash.show', { index: 1 }, id);
    check(
      'git manage: stash show gives each stash with its files, untracked ones as added',
      shown0.files.some((f) => f.path === 'new.txt' && f.status === 'added') && shown1.files.length === 1 && shown1.files[0].path === 'a.txt' && Boolean(shown1.files[0].patch?.includes('+stashed edit')),
      { shown0: shown0.files.map((f) => f.path), shown1: shown1.files.map((f) => f.path) },
    );
    const applied = await run<GitOperationResult>('git.stash.apply', { index: 1 }, id);
    check('git manage: stash apply brings the change back and keeps the stash', applied.conflicts.length === 0 && (await read('a.txt')) === 'stashed edit\n' && (await run<GitStash[]>('git.stash.list', {}, id)).length === 2);
    await run('git.reset', { ref: 'HEAD', mode: 'hard' }, id);
    await run('git.stash.apply', { index: 0, pop: true }, id);
    const afterPop = await run<GitStash[]>('git.stash.list', {}, id);
    check('git manage: stash pop applies the newest and drops it', (await read('new.txt')) === 'untracked\n' && afterPop.length === 1 && afterPop[0].message === 'wip one', afterPop);
    const moved = await failure('git.stash.drop', { index: 0, hash: 'deadbeef' });
    const movedApply = await failure('git.stash.apply', { index: 0, hash: 'deadbeef' });
    check(
      'git manage: stash drop and apply with a hash that is no longer at that index are refused, and the stash stays',
      moved.reason === 'stash-moved' && movedApply.reason === 'stash-moved' && (await run<GitStash[]>('git.stash.list', {}, id)).length === 1,
      { moved, movedApply },
    );
    const missing = await failure('git.stash.drop', { index: 5 });
    const dropped = await run<GitStash[]>('git.stash.drop', { index: 0 }, id);
    check('git manage: stash drop deletes it, and a missing index is NOT_FOUND', dropped.length === 0 && missing.message.includes('stash@{5}'), { dropped, missing });
    // Paths are file names, never globs: stashing `p[1].txt` leaves `p1.txt` alone.
    await write('p[1].txt', 'p\n');
    await write('p1.txt', 'p\n');
    await sh('add', '--', 'p[1].txt', 'p1.txt');
    await sh('commit', '-q', '-m', 'Bracket names');
    await write('p[1].txt', 'p edited\n');
    await write('p1.txt', 'p1 edited\n');
    await run('git.stash.push', { paths: ['p[1].txt'] }, id);
    const byPath = await run<{ stash: GitStash; files: GitDiffFile[] }>('git.stash.show', { index: 0 }, id);
    check(
      'git manage: stash push with paths stashes the file named like a glob alone',
      byPath.files.map((f) => f.path).join() === 'p[1].txt' && (await read('p[1].txt')) === 'p\n' && (await read('p1.txt')) === 'p1 edited\n',
      byPath.files.map((f) => f.path),
    );
    await run('git.stash.drop', { index: 0 }, id);
    await run('git.reset', { ref: 'HEAD', mode: 'hard' }, id);

    // ---- Discard ----
    await write('a.txt', 'edited\n');
    await fs.mkdir(path.join(folder, 'newdir'));
    await write('newdir/x.txt', 'x\n');
    await write('keep.log', 'ignored\n');
    const committedA = (await sh('show', 'HEAD:a.txt')).stdout;
    await run('git.discard', { paths: ['a.txt', 'new.txt'] }, id);
    check('git manage: discard restores a tracked file and deletes an untracked one', (await read('a.txt')) === committedA && !(await exists('new.txt')) && (await exists('newdir/x.txt')));
    const inside = await failure('git.discard', { paths: ['newdir/x.txt'] });
    const ignored = await failure('git.discard', { paths: ['keep.log'] });
    check(
      'git manage: discard never deletes a file inside an untracked folder entry nor an ignored one',
      inside.message.length > 0 && ignored.message.length > 0 && (await exists('newdir/x.txt')) && (await exists('keep.log')),
      { inside, ignored },
    );
    await run('git.discard', { paths: ['newdir/'] }, id);
    check('git manage: discard of an untracked folder entry deletes the folder', !(await exists('newdir')));
    // A path is a file name, never a glob: `n[x].txt` would otherwise take an untracked `nx.txt` with it.
    await write('n[x].txt', 'brackets\n');
    await write('nx.txt', 'sibling\n');
    await run('git.discard', { paths: ['n[x].txt'] }, id);
    check('git manage: discard of a file named like a glob deletes that file alone', !(await exists('n[x].txt')) && (await exists('nx.txt')));
    await fs.rm(path.join(folder, 'nx.txt'));
    await write('a.txt', 'staged\n');
    await run('git.stage', { paths: ['a.txt'] }, id);
    await write('a.txt', 'staged and more\n');
    await run('git.discard', { paths: ['a.txt'] }, id);
    const keptStaged = await read('a.txt');
    const backToHead = await run<GitStatus>('git.discard', { paths: ['a.txt'], staged: true }, id);
    check(
      'git manage: discard goes back to the index, and with staged back to HEAD',
      keptStaged === 'staged\n' && (await read('a.txt')) === committedA && !backToHead.files.some((f) => f.path === 'a.txt'),
      { keptStaged, files: backToHead.files },
    );
    await fs.rm(path.join(folder, 'keep.log'));

    // ---- Tags ----
    await run<GitTag>('git.tag.create', { name: 'v1' }, id);
    const annotated = await run<GitTag>('git.tag.create', { name: 'v2', ref: 'HEAD~1', message: 'Release two\n\nNotes.' }, id);
    const tagList = await run<GitTag[]>('git.tag.list', {}, id);
    const v1 = tagList.find((tg) => tg.name === 'v1');
    check(
      'git manage: tag create makes a lightweight and an annotated tag, and tag list gives both with their commits',
      v1?.annotated === false && v1.commit === (await head()) && annotated.annotated && annotated.subject === 'Release two' && annotated.commit === (await sh('rev-parse', 'HEAD~1')).stdout.trim(),
      tagList,
    );
    await run('git.tag.push', { remote: 'origin', name: 'v2' }, id);
    check('git manage: tag push sends the one tag to the remote', (await inBare('tag', '--list')).stdout.trim() === 'v2', (await inBare('tag', '--list')).stdout);
    const tagsLeft = await run<GitTag[]>('git.tag.delete', { name: 'v1' }, id);
    check('git manage: tag delete removes it', tagsLeft.map((tg) => tg.name).join() === 'v2', tagsLeft);

    // ---- A file at a ref ----
    await write('bin.dat', Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02]));
    await write('big.txt', 'x'.repeat(2 * 1024 * 1024 + 10));
    await sh('add', 'bin.dat', 'big.txt');
    await sh('commit', '-q', '-m', 'Binary and big');
    await write('a.txt', 'in the index\n');
    await run('git.stage', { paths: ['a.txt'] }, id);
    const atHead = await run<GitFileContent>('git.file.show', { ref: 'HEAD', path: 'a.txt' }, id);
    const inIndex = await run<GitFileContent>('git.file.show', { index: true, path: 'a.txt' }, id);
    const atTag = await run<GitFileContent>('git.file.show', { ref: 'v2', path: 'a.txt' }, id);
    check(
      'git manage: file.show reads a file at HEAD, at a tag and in the index',
      atHead.content === committedA && inIndex.content === 'in the index\n' && typeof atTag.content === 'string' && atHead.ref === 'HEAD' && inIndex.ref === undefined,
      { atHead, inIndex, atTag },
    );
    const binary = await run<GitFileContent>('git.file.show', { ref: 'HEAD', path: 'bin.dat' }, id);
    const big = await run<GitFileContent>('git.file.show', { ref: 'HEAD', path: 'big.txt' }, id);
    check('git manage: file.show gives no content for a binary file nor one over 2 MB', binary.binary && binary.content === undefined && binary.size === 5 && big.tooLarge && big.content === undefined, { binary, big: { ...big } });
    const notThere = await failure('git.file.show', { ref: 'HEAD', path: 'nope.txt' });
    const colon = await failure('git.file.show', { ref: 'HEAD:a.txt', path: 'a.txt' });
    const both = await failure('git.file.show', { ref: 'HEAD', index: true, path: 'a.txt' });
    check('git manage: file.show refuses a missing file, a ref with a colon and both a ref and the index', notThere.message.includes('not in HEAD') && colon.message.includes('not a ref') && both.message.length > 0, { notThere, colon, both });
    await run('git.reset', { ref: 'HEAD', mode: 'hard' }, id);

    // ---- Option-like input ----
    const optionLike = await Promise.all(
      (
        [
          ['git.branch.delete', { name: '-D' }],
          ['git.merge', { ref: '--upload-pack=calc' }],
          ['git.rebase', { onto: '--exec=calc' }],
          ['git.tag.create', { name: '--sort=x' }],
          ['git.discard', { paths: ['--', 'a.txt'] }],
          ['git.cherryPick', { commits: ['--strategy-option=x'] }],
          ['git.branch.setUpstream', { upstream: '+x:main' }],
        ] as const
      ).map(([command, input]) => failure(command, input)),
    );
    check('git manage: option-like names, refs and paths are refused', optionLike.every((r) => r.message.length > 0) && (await st()).files.length === 0, optionLike);

    // ---- Agents ----
    const mcpUrl = `http://127.0.0.1:${mcpPort}/mcp?workspace=${encodeURIComponent(folder)}`;
    const rpc = async (name: string, args: unknown): Promise<RpcResult> => {
      const res = await fetch(mcpUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      });
      return (await res.json()) as RpcResult;
    };
    await run('git.stash.push', { message: 'for agents' }, id).catch(() => undefined);
    await write('a.txt', 'agent visible\n');
    await run('git.stash.push', { message: 'for agents' }, id);
    for (const [tool, args] of [
      ['git_stash_list', {}],
      ['git_stash_show', { index: 0 }],
      ['git_tag_list', {}],
      ['git_file_show', { ref: 'HEAD', path: 'a.txt' }],
    ] as const) {
      const allowed = await rpc(tool, args);
      check(`git manage: agents can call ${tool}`, allowed.result?.isError !== true && Boolean(allowed.result?.content?.[0]?.text), allowed.result?.content?.[0]?.text?.slice(0, 200));
    }
    const headBefore = await head();
    const gated: [string, unknown][] = [
      ['git_branch_delete', { name: 'side', force: true }],
      ['git_branch_deleteRemote', { remote: 'origin', name: 'gone-branch' }],
      ['git_branch_rename', { from: 'side', to: 'agent-side' }],
      ['git_branch_setUpstream', { branch: 'side', upstream: 'origin/main' }],
      ['git_merge', { ref: 'side' }],
      ['git_rebase', { onto: 'side' }],
      ['git_operation_continue', {}],
      ['git_operation_abort', {}],
      ['git_operation_skip', {}],
      ['git_cherryPick', { commits: [picked] }],
      ['git_revert', { commit: 'HEAD' }],
      ['git_reset', { ref: 'HEAD~1', mode: 'hard' }],
      ['git_stash_push', { includeUntracked: true }],
      ['git_stash_apply', { index: 0 }],
      ['git_stash_drop', { index: 0 }],
      ['git_discard', { paths: ['a.txt'] }],
      ['git_tag_create', { name: 'agent-tag' }],
      ['git_tag_delete', { name: 'v2' }],
      ['git_tag_push', { remote: 'origin', name: 'v2' }],
    ];
    const blocked: string[] = [];
    for (const [tool, args] of gated) {
      const res = await rpc(tool, args);
      if (!(res.result?.isError === true && (res.result.content?.[0]?.text ?? '').includes('MUTATION_BLOCKED'))) blocked.push(`${tool}: ${res.result?.content?.[0]?.text?.slice(0, 120) ?? JSON.stringify(res.error)}`);
    }
    const names = (await list()).map((b) => b.name);
    check(
      'git manage: every write is gated for agents and none of them changed anything',
      blocked.length === 0 && (await head()) === headBefore && names.includes('side') && !names.includes('agent-side') && (await run<GitStash[]>('git.stash.list', {}, id)).length >= 1 && (await run<GitTag[]>('git.tag.list', {}, id)).length === 1,
      blocked,
    );
  } finally {
    t.host.emit = emit;
    if (ws) await run('workspace.close', { id: ws.id }, null).catch(() => {});
    await run('workspace.forgetRecent', { path: folder }, null).catch(() => {});
    await fs.rm(folder, { recursive: true, force: true }).catch(() => {});
    await fs.rm(bare, { recursive: true, force: true }).catch(() => {});
  }
};

export default section;
