import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { GitConflict, GitOperationResult, GitStatus, HostEvents, WorkspaceInfo } from '@quiver/core';
import { runToEnd } from '@quiver/core/node';
import { until, type RpcResult, type SmokeSection } from '../../part';

// Git: the conflict editor's commands (git.conflict.get and git.conflict.resolve) on a merge that stops on a text, a
// binary and a deleted-by-them conflict and on a rebase whose labels swap, in a repository of its own in a temporary
// folder; then, with screenshots, the Conflicts tab on a repository opened as another workspace.

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
        JSON.stringify(rebased.labels) === JSON.stringify({ ours: 'main', theirs: `${topicLine} (from topic)` }),
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
        await shot('33a-git-conflict-editor-light');
        await js(`document.documentElement.classList.add('dark')`);
        await wait(150);
        await shot('33b-git-conflict-editor-dark');
        await js(`document.documentElement.classList.remove('dark')`);
        await click('[data-testid=git-conflict-next]');
        await wait(100);
        const stepped = ((await state()) as { counter: string } | null)?.counter;
        check('git conflict ui: Next moves the counter to the second conflict', stepped === 'Conflict 2 of 2', stepped);

        // Accept incoming on both; Mark resolved then saves and stages the file.
        await js(`${tab}?.querySelector('[data-testid=conflict-actions][data-index="0"] [data-choice=theirs]')?.click()`);
        await wait(100);
        await js(`${tab}?.querySelector('[data-testid=conflict-actions][data-index="0"] [data-choice=theirs]')?.click()`);
        const ready = await waitFor(`${tab}?.querySelector('[data-testid=git-conflict-mark-resolved]')?.disabled === false`, 3000);
        const afterAccept = await state();
        await shot('33c-git-conflict-accepted-light');
        await click('[data-testid=git-conflict-tab][data-path="conf.txt"] [data-testid=git-conflict-mark-resolved]');
        const resolvedView = await waitFor(`${tab}?.getAttribute('data-view') === 'resolved' && Boolean(${tab}?.querySelector('[data-testid=git-conflict-continue]'))`, 6000);
        const onDisk = await fs.readFile(path.join(ui, 'conf.txt'), 'utf8');
        const status = await run<GitStatus>('git.status', {}, uiWs.id);
        check(
          'git conflict ui: Accept incoming on each conflict enables Mark resolved, which writes and stages the file and points at Continue',
          ready && resolvedView && onDisk === 'head\nfirst theirs\nm1\nm2\nm3\nm4\nsecond theirs\ntail\n' && status.files.every((f) => f.index !== 'U' && f.worktree !== 'U') && status.operation === 'merge',
          { afterAccept, onDisk, files: status.files },
        );
        await shot('33d-git-conflict-resolved-light');
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
