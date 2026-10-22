import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { GitConflict, GitOperationResult, GitStatus, HostEvents, WorkspaceInfo } from '@quiver/core';
import { runToEnd } from '@quiver/core/node';
import { until, type RpcResult, type SmokeSection } from '../../part';

// Git: the conflict editor's commands (git.conflict.get and git.conflict.resolve) on a merge that stops on a text, a
// binary and a deleted-by-them conflict, on a rebase whose labels swap, a cherry-pick with longer markers, a revert, a
// stash apply and a rename on both sides, in a repository of its own in a temporary folder; then, with screenshots, the
// Conflicts tab on a repository opened as another workspace.

const section: SmokeSection = async (t) => {
  const { check, run, mcpPort } = t;
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'quiver-smoke-git-conflict-'));
  const sh = (...args: string[]) => runToEnd('git', args, { cwd: folder });
  const write = (name: string, content: string | Buffer) => fs.writeFile(path.join(folder, name), content);
  const read = (name: string) => fs.readFile(path.join(folder, name), 'utf8').catch(() => null);
  const commitAll = async (message: string) => {
    await sh('add', '--all');
    await sh('commit', '-q', '-m', message);
    return (await sh('rev-parse', 'HEAD')).stdout.trim();
  };
  let ws: WorkspaceInfo | undefined;
  const failure = async (command: string, input: unknown) => {
    const out = await t.host.invoke(command, input, { caller: 'ui', workspaceId: ws?.id ?? null });
    if (out.ok) return { message: '', reason: undefined };
    return { message: out.error.message, reason: (out.error.details as { reason?: string } | undefined)?.reason };
  };
  const events: HostEvents['git.changed'][] = [];
  const emit = t.host.emit;
  t.host.emit = ((event, payload) => {
    if (event === 'git.changed') events.push(payload as HostEvents['git.changed']);
    emit.call(t.host, event, payload);
  }) as typeof t.host.emit;

  try {
    await sh('init', '-q', '-b', 'main');
    await sh('config', 'user.name', 'Smoke');
    await sh('config', 'user.email', 'smoke@quiver.test');
    await sh('config', 'core.autocrlf', 'false');
    await sh('config', 'merge.conflictStyle', 'merge');
    await write('.gitignore', '.quiver/\n');
    await write('a.txt', 'one\ntwo\nthree\n');
    await write('b.txt', 'b\n');
    await write('bin.dat', Buffer.from([0, 1, 2]));
    await write('clean.txt', 'clean\n');
    await commitAll('Base');
    await sh('checkout', '-q', '-b', 'side');
    await write('a.txt', 'one\ntwo side\nthree\n');
    await fs.rm(path.join(folder, 'b.txt'));
    await write('bin.dat', Buffer.from([0, 1, 3]));
    await commitAll('Side edit');
    await sh('checkout', '-q', '-b', 'topic', 'main');
    await write('a.txt', 'one\ntwo topic\nthree\n');
    const topic = await commitAll('Topic edit');
    await sh('checkout', '-q', 'main');
    await write('a.txt', 'one\ntwo main\nthree\n');
    await write('b.txt', 'b main\n');
    await write('bin.dat', Buffer.from([0, 1, 4]));
    await commitAll('Main edit');

    ws = await run<WorkspaceInfo>('workspace.open', { path: folder }, null);
    const id = ws.id;
    const st = () => run<GitStatus>('git.status', {}, id);
    const get = (p: string) => run<GitConflict>('git.conflict.get', { path: p }, id);
    const unmerged = async (p: string) => (await st()).files.some((f) => f.path === p && (f.index === 'U' || f.worktree === 'U'));

    // ---- A merge: a text conflict, a binary one and a file the other side deleted ----
    const merged = await run<GitOperationResult>('git.merge', { ref: 'side' }, id);
    check('git conflict: the merge stops on the text, binary and deleted-by-them conflicts', JSON.stringify([...merged.conflicts].sort()) === '["a.txt","b.txt","bin.dat"]', merged.conflicts);
    const text = await get('a.txt');
    check(
      'git conflict: get gives the kind, the three stages, the file with its markers and the labels of a merge (ours the current branch, theirs the branch merged)',
      text.kind === 'both-modified' &&
        text.operation === 'merge' &&
        text.ours === 'one\ntwo main\nthree\n' &&
        text.theirs === 'one\ntwo side\nthree\n' &&
        text.base === 'one\ntwo\nthree\n' &&
        Boolean(text.working?.includes('<<<<<<< HEAD\ntwo main\n=======\ntwo side\n>>>>>>> side\n')) &&
        JSON.stringify(text.labels) === JSON.stringify({ ours: 'main', theirs: 'side' }) &&
        !text.binary &&
        !text.tooLarge,
      text,
    );
    const hashOf = async (ref: string) => (await sh('rev-parse', ref)).stdout.trim();
    check(
      'git conflict: get gives the commits the sides come from, to blame them at: HEAD and the branch merged',
      text.commits.ours === (await hashOf('main')) && text.commits.theirs === (await hashOf('side')),
      text.commits,
    );
    const deleted = await get('b.txt');
    check('git conflict: a file the other side deleted is deleted-by-them, with no theirs', deleted.kind === 'deleted-by-them' && deleted.ours === 'b main\n' && deleted.theirs === null && deleted.base === 'b\n' && deleted.working === 'b main\n', deleted);
    const binary = await get('bin.dat');
    check('git conflict: a binary conflict comes back without contents', binary.kind === 'both-modified' && binary.binary && binary.ours === null && binary.theirs === null && binary.working === null, binary);
    const notConflicted = await failure('git.conflict.get', { path: 'clean.txt' });
    const outside = await failure('git.conflict.get', { path: '../outside.txt' });
    const optionLike = await failure('git.conflict.get', { path: '--output=x' });
    check(
      'git conflict: get refuses a path with no conflict, one outside the repository and an option-like one',
      notConflicted.reason === 'not-unmerged' && outside.reason === 'outside-repository' && optionLike.message.length > 0,
      { notConflicted, outside, optionLike },
    );

    // Resolving with content: refused while markers remain, written and staged once they are gone.
    const withMarkers = await failure('git.conflict.resolve', { path: 'a.txt', content: text.working });
    const both = await failure('git.conflict.resolve', { path: 'a.txt', content: 'x\n', take: 'ours' });
    const neither = await failure('git.conflict.resolve', { path: 'a.txt' });
    check(
      'git conflict: resolve refuses content that still has markers, and both or neither of content and take, leaving the conflict',
      withMarkers.reason === 'markers' && both.message.includes('not both') && neither.message.includes('not both') && (await unmerged('a.txt')),
      { withMarkers, both, neither },
    );
    events.length = 0;
    const afterText = await run<GitStatus>('git.conflict.resolve', { path: 'a.txt', content: 'one\ntwo main and side\nthree\n' }, id);
    const announced = await until(() => events.some((e) => e.workspaceId === id && e.reason === 'status'), 3000);
    check(
      'git conflict: resolve with content writes the file, stages it, gives back the status and announces it',
      (await read('a.txt')) === 'one\ntwo main and side\nthree\n' && afterText.files.some((f) => f.path === 'a.txt' && f.index === 'M' && f.worktree === '.') && announced,
      { files: afterText.files, announced },
    );
    const again = await failure('git.conflict.resolve', { path: 'a.txt', take: 'ours' });
    check('git conflict: a resolved path is refused as not conflicted', again.reason === 'not-unmerged', again);
    await run('git.conflict.resolve', { path: 'bin.dat', take: 'ours' }, id);
    const bin = await fs.readFile(path.join(folder, 'bin.dat'));
    check('git conflict: take ours checks out our side of a binary file and stages it', bin.equals(Buffer.from([0, 1, 4])) && !(await unmerged('bin.dat')), [...bin]);
    await run('git.conflict.resolve', { path: 'b.txt', take: 'delete' }, id);
    const afterDelete = await st();
    check(
      'git conflict: delete removes a file the other side deleted and stages the deletion',
      (await read('b.txt')) === null && afterDelete.files.some((f) => f.path === 'b.txt' && f.index === 'D'),
      afterDelete.files,
    );
    const finished = await run<GitOperationResult>('git.operation.continue', {}, id);
    check('git conflict: with every conflict resolved the merge continues', finished.status.operation === undefined && finished.conflicts.length === 0, finished.status);

    // ---- A rebase: ours and theirs swap ----
    await sh('checkout', '-q', 'topic');
    const topicLine = (await sh('log', '-1', '--format=%h %s', topic)).stdout.trim();
    await run<GitOperationResult>('git.rebase', { onto: 'main' }, id);
    const rebased = await get('a.txt');
    check(
      'git conflict: in a rebase ours is the branch rebased onto and theirs the commit replayed, labels and stages alike',
      rebased.operation === 'rebase' &&
        rebased.ours === 'one\ntwo main and side\nthree\n' &&
        rebased.theirs === 'one\ntwo topic\nthree\n' &&
        JSON.stringify(rebased.labels) === JSON.stringify({ ours: 'main', theirs: `${topicLine} (from topic)` }) &&
        rebased.commits.ours === (await hashOf('main')) &&
        rebased.commits.theirs === topic,
      rebased,
    );

    // Agents read conflicts; resolving is gated and leaves the conflict as it was.
    const mcpUrl = `http://127.0.0.1:${mcpPort}/mcp?workspace=${encodeURIComponent(folder)}`;
    const rpc = async (name: string, args: unknown): Promise<RpcResult> => {
      const res = await fetch(mcpUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      });
      return (await res.json()) as RpcResult;
    };
    const agentGet = await rpc('git_conflict_get', { path: 'a.txt' });
    const agentResolve = await rpc('git_conflict_resolve', { path: 'a.txt', take: 'theirs' });
    check(
      'git conflict: agents can call git_conflict_get, while git_conflict_resolve is gated and changes nothing',
      agentGet.result?.isError !== true &&
        Boolean(agentGet.result?.content?.[0]?.text?.includes('both-modified')) &&
        agentResolve.result?.isError === true &&
        (agentResolve.result.content?.[0]?.text ?? '').includes('MUTATION_BLOCKED') &&
        (await unmerged('a.txt')),
      { agentGet: agentGet.result?.content?.[0]?.text?.slice(0, 120), agentResolve: agentResolve.result?.content?.[0]?.text?.slice(0, 160) },
    );

    // allowMarkers writes the file as it is, markers and all.
    await run('git.conflict.resolve', { path: 'a.txt', content: rebased.working, allowMarkers: true }, id);
    check('git conflict: allowMarkers writes content with its markers and stages it', (await read('a.txt')) === rebased.working && !(await unmerged('a.txt')));
    await run('git.operation.abort', {}, id);
    await run<GitOperationResult>('git.rebase', { onto: 'main' }, id);
    await run('git.conflict.resolve', { path: 'a.txt', take: 'theirs' }, id);
    const tookTheirs = await read('a.txt');
    const replayed = await run<GitOperationResult>('git.operation.continue', {}, id);
    check('git conflict: take theirs in a rebase keeps the replayed commit\'s side, and the rebase continues', tookTheirs === 'one\ntwo topic\nthree\n' && replayed.status.operation === undefined && replayed.status.branch === 'topic', { tookTheirs, status: replayed.status });

    // ---- A cherry-pick, with the markers lengthened by the conflict-marker-size attribute ----
    const short = async (ref: string) => (await sh('log', '-1', '--format=%h %s', ref)).stdout.trim();
    await sh('checkout', '-q', '-b', 'pick', 'main');
    await write('a.txt', 'one\ntwo pick\nthree\n');
    await commitAll('Pick edit');
    await fs.mkdir(path.join(folder, '.git', 'info'), { recursive: true });
    await fs.writeFile(path.join(folder, '.git', 'info', 'attributes'), 'a.txt conflict-marker-size=10\n');
    await sh('cherry-pick', 'topic');
    const picked = await get('a.txt');
    const pickedCommits = picked.commits.ours === (await hashOf('pick')) && picked.commits.theirs === (await hashOf('topic'));
    const pickedMarkers = await failure('git.conflict.resolve', { path: 'a.txt', content: picked.working });
    const leftover = await failure('git.conflict.resolve', { path: 'a.txt', content: 'one\ntwo pick\n>>>>>>>>>> topic\nthree\n' });
    const sevenWide = 'one\n<<<<<<< not a marker at this size\nthree\n';
    await run('git.conflict.resolve', { path: 'a.txt', content: sevenWide }, id);
    check(
      'git conflict: a cherry-pick labels ours the current branch and theirs the picked commit (CHERRY_PICK_HEAD, to blame), and markers are as long as conflict-marker-size says',
      picked.operation === 'cherry-pick' &&
        JSON.stringify(picked.labels) === JSON.stringify({ ours: 'pick', theirs: await short('topic') }) &&
        pickedCommits &&
        picked.markerSize === 10 &&
        Boolean(picked.working?.includes('<<<<<<<<<< HEAD\n')) &&
        pickedMarkers.reason === 'markers' &&
        leftover.reason === 'markers' &&
        leftover.message.includes('line 3') &&
        (await read('a.txt')) === sevenWide &&
        !(await unmerged('a.txt')),
      { labels: picked.labels, commits: picked.commits, markerSize: picked.markerSize, pickedMarkers, leftover },
    );
    await sh('cherry-pick', '--abort');
    await fs.rm(path.join(folder, '.git', 'info', 'attributes'), { force: true });

    // ---- A revert: theirs is the revert of the commit ----
    await write('a.txt', 'one\ntwo pick again\nthree\n');
    await commitAll('Pick again');
    await sh('revert', '--no-edit', 'HEAD~1');
    const reverting = await get('a.txt');
    check(
      'git conflict: a revert labels ours the current branch and theirs the revert of the commit, with no incoming commit to blame',
      reverting.operation === 'revert' && JSON.stringify(reverting.labels) === JSON.stringify({ ours: 'pick', theirs: `revert of ${await short('HEAD~1')}` }) && reverting.commits.theirs === undefined && reverting.commits.ours === (await hashOf('HEAD')),
      { labels: reverting.labels, commits: reverting.commits },
    );
    await run('git.conflict.resolve', { path: 'a.txt', take: 'base' }, id);
    check('git conflict: take base writes the common ancestor (in a revert, the reverted commit) and stages it', (await read('a.txt')) === 'one\ntwo pick\nthree\n' && !(await unmerged('a.txt')));
    await sh('revert', '--abort');

    // ---- A stash apply leaves conflicts and no operation; they resolve all the same ----
    await write('a.txt', 'one\ntwo stashed\nthree\n');
    await sh('stash', 'push', '-q');
    await write('a.txt', 'one\ntwo committed\nthree\n');
    await commitAll('Committed over the stash');
    await sh('stash', 'apply');
    const stashed = await get('a.txt');
    await run('git.conflict.resolve', { path: 'a.txt', take: 'theirs' }, id);
    check(
      'git conflict: a stash apply conflict has no operation and no incoming commit to blame, and take theirs resolves it with the stash\'s side',
      stashed.operation === undefined &&
        JSON.stringify(stashed.labels) === JSON.stringify({ ours: 'pick', theirs: 'the incoming changes' }) &&
        stashed.commits.ours === (await hashOf('HEAD')) &&
        stashed.commits.theirs === undefined &&
        (await read('a.txt')) === 'one\ntwo stashed\nthree\n' &&
        !(await unmerged('a.txt')),
      { operation: stashed.operation, labels: stashed.labels, commits: stashed.commits },
    );
    await sh('reset', '-q', '--hard');
    await sh('stash', 'drop', '-q');

    // ---- Both sides rename one file: both-deleted, added-by-us and added-by-them ----
    await write('r.txt', 'renamed on both sides\nwith a few lines\nso git sees renames\n');
    await commitAll('Add r');
    await sh('checkout', '-q', '-b', 'rename-theirs');
    await sh('mv', 'r.txt', 'r-theirs.txt');
    await commitAll('Rename theirs');
    await sh('checkout', '-q', 'pick');
    await sh('mv', 'r.txt', 'r-ours.txt');
    await commitAll('Rename ours');
    await sh('merge', 'rename-theirs');
    const [dd, au, ua] = await Promise.all([get('r.txt'), get('r-ours.txt'), get('r-theirs.txt')]);
    check(
      'git conflict: a rename on both sides gives both-deleted (base only), added-by-us (ours only) and added-by-them (theirs only)',
      dd.kind === 'both-deleted' && dd.base !== null && dd.ours === null && dd.theirs === null && dd.working === null &&
        au.kind === 'added-by-us' && au.ours !== null && au.theirs === null && au.base === null &&
        ua.kind === 'added-by-them' && ua.theirs !== null && ua.ours === null && ua.base === null,
      { dd: dd.kind, au: au.kind, ua: ua.kind },
    );
    const noBase = await failure('git.conflict.resolve', { path: 'r-ours.txt', take: 'base' });
    await run('git.conflict.resolve', { path: 'r.txt', take: 'delete' }, id);
    await run('git.conflict.resolve', { path: 'r-ours.txt', take: 'ours' }, id);
    await run('git.conflict.resolve', { path: 'r-theirs.txt', take: 'ours' }, id);
    const renamed = await st();
    check(
      'git conflict: delete, keep and take of a side with no file resolve them; base is refused when there is none',
      noBase.reason === 'no-base' &&
        !renamed.files.some((f) => f.index === 'U' || f.worktree === 'U' || (f.index === 'D' && f.worktree === 'D') || (f.index === 'A' && f.worktree === 'A')) &&
        (await read('r-ours.txt')) !== null &&
        (await read('r-theirs.txt')) === null &&
        (await read('r.txt')) === null,
      renamed.files,
    );
    await sh('merge', '--abort');
  } finally {
    t.host.emit = emit;
    if (ws) await run('workspace.close', { id: ws.id }, null).catch(() => {});
    await run('workspace.forgetRecent', { path: folder }, null).catch(() => {});
    await fs.rm(folder, { recursive: true, force: true }).catch(() => {});
  }

  return {
    ui: async ({ js, wait, shot }) => {
      const ui = await fs.mkdtemp(path.join(os.tmpdir(), 'quiver-smoke-git-conflict-ui-'));
      const git = (...args: string[]) => runToEnd('git', args, { cwd: ui });
      const visible = (selector: string) => `[...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.offsetParent !== null)`;
      const click = (selector: string) => js(`(() => { const el = ${visible(selector)}; el?.click(); return Boolean(el); })()`);
      const waitFor = (code: string, ms = 5000) => until(async () => Boolean(await js(code)), ms);
      const tab = visible('[data-testid=git-conflict-tab][data-path="conf.txt"]');
      let uiWs: WorkspaceInfo | undefined;
      try {
        await git('init', '-q', '-b', 'main');
        await git('config', 'user.name', 'Smoke');
        await git('config', 'user.email', 'smoke@quiver.test');
        await git('config', 'core.autocrlf', 'false');
        await git('config', 'merge.conflictStyle', 'merge');
        await fs.writeFile(path.join(ui, '.gitignore'), '.quiver/\n');
        await fs.writeFile(path.join(ui, 'conf.txt'), 'head\nfirst\nm1\nm2\nm3\nm4\nsecond\ntail\n');
        await git('add', '.');
        await git('commit', '-q', '-m', 'Base');
        await git('checkout', '-q', '-b', 'side');
        await fs.writeFile(path.join(ui, 'conf.txt'), 'head\nfirst theirs\nm1\nm2\nm3\nm4\nsecond theirs\ntail\n');
        await git('commit', '-q', '-am', 'Theirs');
        await git('checkout', '-q', 'main');

        uiWs = await run<WorkspaceInfo>('workspace.open', { path: ui }, null);
        await waitFor(`Boolean(document.querySelector('[data-testid=workspace-tab][data-drag-id="${uiWs.id}"]'))`);
        await click(`[data-testid=workspace-tab][data-drag-id="${uiWs.id}"]`);
        await wait(300);
        await js(`document.documentElement.classList.remove('dark')`);
        await click('[data-testid=activity-item][data-drag-id=git]');
        await waitFor(`document.querySelector('[data-testid=git-current-branch]')?.textContent.trim() === 'main'`);

        // A working diff left open on the file turns into the "Open conflict editor" note once the merge conflicts.
        await fs.writeFile(path.join(ui, 'conf.txt'), 'head\nfirst ours\nm1\nm2\nm3\nm4\nsecond ours\ntail\n');
        await click('[data-testid=git-refresh]');
        await waitFor(`Boolean(document.querySelector('[data-testid=git-file][data-group=unstaged][data-path="conf.txt"]'))`);
        await click('[data-testid=git-file][data-group=unstaged][data-path="conf.txt"]');
        await waitFor(`Boolean(${visible('[data-testid=git-diff-tab][data-path="conf.txt"]')})`);
        await git('commit', '-q', '-am', 'Ours');
        await run('git.merge', { ref: 'side' }, uiWs.id);
        const note = await waitFor(`Boolean(${visible('[data-testid=git-diff-tab][data-path="conf.txt"] [data-testid=git-patch-note][data-conflict=true] [data-testid=git-conflict-open]')})`, 6000);
        await click('[data-testid=git-diff-tab][data-path="conf.txt"] [data-testid=git-conflict-open]');
        const fromDiff = await waitFor(`${tab}?.getAttribute('data-view') === 'text'`, 6000);
        check('git conflict ui: a conflicted file\'s diff offers the conflict editor, which opens on it', note && fromDiff, { note, fromDiff });

        // From the sidebar's conflict row too; the editor shows both conflicts with the sides labelled.
        await click('[data-testid=git-open-history]');
        await wait(200);
        await click('[data-testid=git-file][data-group=conflicts][data-path="conf.txt"]');
        const opened = await waitFor(`${tab}?.getAttribute('data-view') === 'text' && (${tab}?.querySelectorAll('[data-testid=conflict-actions]').length ?? 0) === 2`, 6000);
        const state = () =>
          js(
            `(() => { const t = ${tab}; if (!t) return null; const l = t.querySelector('[data-testid=git-conflict-labels]'); return { counter: t.querySelector('[data-testid=git-conflict-counter]')?.textContent.trim(), ours: l?.getAttribute('data-ours'), theirs: l?.getAttribute('data-theirs'), bars: t.querySelectorAll('[data-testid=conflict-actions]').length, oursLines: [...t.querySelectorAll('.cm-conflict-ours')].map((e) => e.textContent), theirsLines: [...t.querySelectorAll('.cm-conflict-theirs')].map((e) => e.textContent), resolvable: t.querySelector('[data-testid=git-conflict-mark-resolved]')?.disabled === false }; })()`,
          );
        const first = await state();
        check(
          'git conflict ui: a conflict row opens the editor with each conflict highlighted and labelled, Mark resolved waiting',
          opened && JSON.stringify(first) === JSON.stringify({ counter: 'Conflict 1 of 2', ours: 'main', theirs: 'side', bars: 2, oursLines: ['first ours', 'second ours'], theirsLines: ['first theirs', 'second theirs'], resolvable: false }),
          first,
        );
        await shot('32ca-git-conflict-editor-light');
        await js(`document.documentElement.classList.add('dark')`);
        await wait(150);
        await shot('32cb-git-conflict-editor-dark');
        await js(`document.documentElement.classList.remove('dark')`);
        await click('[data-testid=git-conflict-next]');
        await wait(100);
        const stepped = ((await state()) as { counter: string } | null)?.counter;
        check('git conflict ui: Next moves the counter to the second conflict', stepped === 'Conflict 2 of 2', stepped);

        // Blame incoming opens the file's blame at the commit merged in; the conflict tab is left as it was.
        const sideHash = (await git('rev-parse', 'side')).stdout.trim();
        const blameButtons = await js(`(() => { const t = ${tab}; return { ours: t?.querySelector('[data-testid=git-conflict-blame-ours]')?.getAttribute('data-ref') ?? null, theirs: t?.querySelector('[data-testid=git-conflict-blame-theirs]')?.getAttribute('data-ref') ?? null }; })()`);
        await click('[data-testid=git-conflict-tab][data-path="conf.txt"] [data-testid=git-conflict-blame-theirs]');
        const blameTab = visible(`[data-testid=git-blame-tab][data-path="conf.txt"][data-ref="${sideHash}"]`);
        const blamed = await waitFor(`${blameTab}?.getAttribute('data-loaded') === 'true' && Boolean(${blameTab}?.querySelector('.cm-content')?.textContent.includes('second theirs'))`, 6000);
        await click('[data-testid=tab][data-title="conf.txt (conflict)"]');
        const backOnConflict = await waitFor(`${tab}?.getAttribute('data-view') === 'text'`, 3000);
        check(
          'git conflict ui: Blame incoming opens the blame of the file at the commit merged in, and the conflict tab stays as it was',
          (blameButtons as { theirs: string | null }).theirs === sideHash && Boolean((blameButtons as { ours: string | null }).ours) && blamed && backOnConflict,
          { blameButtons, sideHash, blamed, backOnConflict },
        );

        // Edits made here survive a reload of the same file and mark the tab unsaved; a change on disk is pointed out
        // rather than dropping them, and Use the file on disk takes it.
        const dirtyDot = `Boolean([...document.querySelectorAll('[data-testid=tab][data-title="conf.txt (conflict)"]')].find((e) => e.offsetParent !== null)?.querySelector('.bg-warning'))`;
        await js(`${tab}?.querySelector('[data-testid=conflict-actions][data-index="0"] [data-choice=ours]')?.click()`);
        await js(`[...${tab}?.querySelectorAll('button') ?? []].find((b) => b.textContent.trim() === 'Refresh')?.click()`);
        await wait(400);
        const kept = await state();
        const markedDirty = await js(dirtyDot);
        const original = await fs.readFile(path.join(ui, 'conf.txt'), 'utf8');
        await fs.writeFile(path.join(ui, 'conf.txt'), original.replace('tail\n', 'tail edited\n'));
        await js(`[...${tab}?.querySelectorAll('button') ?? []].find((b) => b.textContent.trim() === 'Refresh')?.click()`);
        const noted = await waitFor(`Boolean(${tab}?.querySelector('[data-testid=git-conflict-changed-on-disk]'))`, 3000);
        const stillKept = await state();
        await shot('32cc-git-conflict-changed-on-disk-light');
        await click('[data-testid=git-conflict-tab][data-path="conf.txt"] [data-testid=git-conflict-use-disk]');
        const tookDisk = await waitFor(`${tab}?.querySelectorAll('[data-testid=conflict-actions]').length === 2 && !${tab}?.querySelector('[data-testid=git-conflict-changed-on-disk]')`, 3000);
        await fs.writeFile(path.join(ui, 'conf.txt'), original);
        await js(`[...${tab}?.querySelectorAll('button') ?? []].find((b) => b.textContent.trim() === 'Refresh')?.click()`);
        const backToDisk = await waitFor(`!${tab}?.querySelector('.cm-content')?.textContent.includes('tail edited')`, 3000);
        const clean = !(await js(dirtyDot));
        check(
          'git conflict ui: an edit survives a reload and marks the tab unsaved; a change on disk is noted, and Use the file on disk takes it',
          (kept as { counter: string } | null)?.counter === 'Conflict 1 of 1' && Boolean(markedDirty) && noted && (stillKept as { counter: string } | null)?.counter === 'Conflict 1 of 1' && tookDisk && backToDisk && clean,
          { kept, markedDirty, noted, stillKept, tookDisk, backToDisk, clean },
        );

        // Accept incoming on both; Mark resolved then saves and stages the file.
        await js(`${tab}?.querySelector('[data-testid=conflict-actions][data-index="0"] [data-choice=theirs]')?.click()`);
        await wait(100);
        await js(`${tab}?.querySelector('[data-testid=conflict-actions][data-index="0"] [data-choice=theirs]')?.click()`);
        const ready = await waitFor(`${tab}?.querySelector('[data-testid=git-conflict-mark-resolved]')?.disabled === false`, 3000);
        const afterAccept = await state();
        await shot('32cd-git-conflict-accepted-light');
        await click('[data-testid=git-conflict-tab][data-path="conf.txt"] [data-testid=git-conflict-mark-resolved]');
        const resolvedView = await waitFor(`${tab}?.getAttribute('data-view') === 'resolved' && Boolean(${tab}?.querySelector('[data-testid=git-conflict-continue]'))`, 6000);
        const onDisk = await fs.readFile(path.join(ui, 'conf.txt'), 'utf8');
        const status = await run<GitStatus>('git.status', {}, uiWs.id);
        check(
          'git conflict ui: Accept incoming on each conflict enables Mark resolved, which writes and stages the file and points at Continue',
          ready && resolvedView && onDisk === 'head\nfirst theirs\nm1\nm2\nm3\nm4\nsecond theirs\ntail\n' && status.files.every((f) => f.index !== 'U' && f.worktree !== 'U') && status.operation === 'merge',
          { afterAccept, onDisk, files: status.files },
        );
        await shot('32ce-git-conflict-resolved-light');
        await click('[data-testid=git-conflict-tab][data-path="conf.txt"] [data-testid=git-conflict-continue]');
        const continued = await until(async () => (await run<GitStatus>('git.status', {}, uiWs!.id)).operation === undefined, 6000);
        check('git conflict ui: Continue from the tab finishes the merge', continued);
      } finally {
        await js(`[...document.querySelectorAll('.fixed.inset-0 button')].find((b) => b.textContent.trim() === 'Cancel')?.click()`).catch(() => {});
        await click(`[data-testid=workspace-tab][data-drag-id="${t.ws.id}"]`);
        await wait(200);
        if (uiWs) await run('workspace.close', { id: uiWs.id }, null).catch(() => {});
        await run('workspace.forgetRecent', { path: ui }, null).catch(() => {});
        await fs.rm(ui, { recursive: true, force: true }).catch(() => {});
      }
    },
  };
};

export default section;
