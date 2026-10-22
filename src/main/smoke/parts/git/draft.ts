import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { GitPrDraft, WorkspaceInfo } from '@quiver/core';
import { runToEnd } from '@quiver/core/node';
import { writeFakeGh, type FakeGh, type FakeGhState } from '../../fake-gh';
import { until, type RpcResult, type SmokeSection } from '../../part';

// Git: a pull request description drafted from git alone (git.pr.draft), on a repository of its own with a bare clone
// as origin (whose HEAD names main) and a github.com remote for gh. A branch of two commits is drafted without gh, with
// gh listing the labels and with gh failing, with and without the repository's template, against a given base, with
// its patch under and over the cap; a merge from main stays out of the commits; a single commit gives its subject;
// agents may call it. The UI hook opens the new pull request form on that branch, which fills itself, and replaces a
// typed title only after asking. The folders, the fake gh and QUIVER_GH_PATH are cleaned up in the `after` hook.

const REPO = 'smoke/quiver';
const TEMPLATE = ['## What changed', '', '<!-- What, and why. -->', '', '## How it was verified', '', '- [ ] Tests', ''].join('\n');

function ghState(repoLabels?: string[]): FakeGhState {
  return { login: 'smoke-user', repo: REPO, defaultBranch: 'main', prs: [], checks: {}, jobLogs: {}, diffs: {}, opened: [], ...(repoLabels ? { repoLabels } : {}) };
}

const section: SmokeSection = async (t) => {
  const { check, run, mcpPort } = t;
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'quiver-smoke-draft-'));
  const bare = await fs.mkdtemp(path.join(os.tmpdir(), 'quiver-smoke-draft-origin-'));
  const ghDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quiver-smoke-draft-gh-'));
  const previousGh = process.env.QUIVER_GH_PATH;
  const restoreGh = () => {
    if (previousGh === undefined) delete process.env.QUIVER_GH_PATH;
    else process.env.QUIVER_GH_PATH = previousGh;
  };
  const after = async () => {
    restoreGh();
    for (const dir of [folder, bare, ghDir]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  };
  const sh = (...args: string[]) => runToEnd('git', args, { cwd: folder });
  const failure = (fn: () => Promise<unknown>) =>
    fn().then(
      () => '',
      (err: Error & { code?: string }) => `${err.code ?? ''} ${err.message}`,
    );
  const write = async (rel: string, text: string) => {
    await fs.mkdir(path.dirname(path.join(folder, rel)), { recursive: true });
    await fs.writeFile(path.join(folder, rel), text);
  };

  const fake: FakeGh = await writeFakeGh(ghDir, ghState(['bug', 'Enhancement', 'documentation']));
  let ws: WorkspaceInfo | undefined;
  try {
    await runToEnd('git', ['init', '-q', '--bare', '-b', 'main', bare], { cwd: os.tmpdir() });
    await sh('init', '-q', '-b', 'main');
    await sh('config', 'user.name', 'Smoke');
    await sh('config', 'user.email', 'smoke@quiver.test');
    await sh('config', 'core.autocrlf', 'false');
    await write('.gitignore', '.quiver/\n');
    await write('readme.txt', 'hi\n');
    await sh('add', '.');
    await sh('commit', '-q', '-m', 'First commit');
    await sh('remote', 'add', 'origin', bare);
    await sh('push', '-q', 'origin', 'main');
    await sh('remote', 'set-head', 'origin', 'main');
    // gh's repository; never fetched, so it has no remote-tracking branches.
    await sh('remote', 'add', 'hub', `https://github.com/${REPO}.git`);

    // A branch of two commits that was never pushed.
    await sh('checkout', '-q', '-b', 'feat/pr-draft');
    await write('src/parser.ts', 'export const parse = () => 1;\n');
    await write('readme.txt', 'hi\nthere\n');
    await sh('add', '.');
    await sh('commit', '-q', '-m', 'Add the parser', '-m', 'It reads porcelain.\n\nCo-Authored-By: Someone <someone@quiver.test>');
    await write('docs/parser.md', '# Parser\n');
    await sh('add', '.');
    await sh('commit', '-q', '-m', 'Document the parser');

    ws = await run<WorkspaceInfo>('workspace.open', { path: folder }, null);
    const id = ws.id;

    // Without gh at all.
    process.env.QUIVER_GH_PATH = path.join(ghDir, 'no-such-gh.exe');
    const plain = await run<GitPrDraft>('git.pr.draft', {}, id);
    check(
      'git draft: a branch never pushed is drafted without gh against origin/main: readable branch title, commits oldest first, files',
      plain.head === 'feat/pr-draft' &&
        plain.base === 'main' &&
        plain.baseRef === 'origin/main' &&
        plain.title === 'Pr draft' &&
        plain.commits.map((c) => c.subject).join('|') === 'Add the parser|Document the parser' &&
        plain.files.map((f) => `${f.path}:${f.status}:${f.additions}`).join() === 'docs/parser.md:added:1,readme.txt:modified:1,src/parser.ts:added:1' &&
        JSON.stringify(plain.stats) === JSON.stringify({ commits: 2, files: 3, additions: 3, deletions: 0 }) &&
        plain.labels.length === 0 &&
        plain.template === null &&
        plain.patch === undefined,
      plain,
    );
    check(
      'git draft: without a template the body has Summary (bodies indented, trailers dropped) and Changes grouped by folder',
      plain.body.startsWith('## Summary\n\n- Add the parser\n  It reads porcelain.\n- Document the parser\n\n## Changes\n\n') &&
        plain.body.includes('**docs/** (1 file, +1 −0)\n- `docs/parser.md` (new) +1 −0') &&
        plain.body.includes('**Top level** (1 file, +1 −0)\n- `readme.txt` +1 −0') &&
        !plain.body.includes('Co-Authored-By'),
      plain.body,
    );

    // gh listing the labels: the branch prefix's label is kept in the repository's spelling. A failing gh only loses them.
    process.env.QUIVER_GH_PATH = fake.command;
    const labelled = await run<GitPrDraft>('git.pr.draft', {}, id);
    const labelCall = (await fake.calls()).find((c) => c.argv[0] === 'label' && c.argv[1] === 'list');
    check('git draft: labels come from the branch prefix, kept only as gh lists them', labelled.labels.join() === 'Enhancement' && labelCall?.argv.includes(`github.com/${REPO}`) === true, { labels: labelled.labels, labelCall });
    await fake.update((s) => {
      delete s.repoLabels;
    });
    const ghFailing = await run<GitPrDraft>('git.pr.draft', {}, id);
    check('git draft: a failing gh leaves the labels empty and the draft whole', ghFailing.labels.length === 0 && ghFailing.title === 'Pr draft' && ghFailing.commits.length === 2, ghFailing.labels);

    // The repository's template, its sections filled and the rest kept; then the first file of the template folder.
    await write('.github/pull_request_template.md', TEMPLATE);
    const templated = await run<GitPrDraft>('git.pr.draft', {}, id);
    check(
      "git draft: the repository's template is filled under What changed, its hint and other sections kept",
      templated.template === TEMPLATE &&
        templated.templatePath === '.github/pull_request_template.md' &&
        templated.body === ['## What changed', '', '<!-- What, and why. -->', '', '- Add the parser', '  It reads porcelain.', '- Document the parser', '', '## How it was verified', '', '- [ ] Tests', ''].join('\n'),
      templated.body,
    );
    await fs.rm(path.join(folder, '.github/pull_request_template.md'));
    await write('.github/PULL_REQUEST_TEMPLATE/b-other.md', '## Other\n');
    await write('.github/PULL_REQUEST_TEMPLATE/a-feature.md', '## Summary\n\n## Files\n');
    const fromFolder = await run<GitPrDraft>('git.pr.draft', {}, id);
    check(
      'git draft: without a template file, the first one in .github/PULL_REQUEST_TEMPLATE/ is used, with its files section filled',
      fromFolder.templatePath === '.github/PULL_REQUEST_TEMPLATE/a-feature.md' && fromFolder.body.startsWith('## Summary\n\n- Add the parser') && fromFolder.body.includes('## Files\n\n**docs/**'),
      fromFolder.body,
    );
    await fs.rm(path.join(folder, '.github'), { recursive: true, force: true });

    // A base given: as a branch, as a remote-tracking branch, and refused when it is no ref or option-like.
    const onMain = await run<GitPrDraft>('git.pr.draft', { base: 'main' }, id);
    const onOrigin = await run<GitPrDraft>('git.pr.draft', { base: 'origin/main' }, id);
    check('git draft: a given base is named as a pull request names it', onMain.base === 'main' && onMain.baseRef === 'main' && onOrigin.base === 'main' && onOrigin.baseRef === 'origin/main' && onMain.mergeBase === plain.mergeBase, { onMain: [onMain.base, onMain.baseRef], onOrigin: [onOrigin.base, onOrigin.baseRef] });
    const noRef = await failure(() => run('git.pr.draft', { base: 'no-such-branch' }, id));
    const range = await failure(() => run('git.pr.draft', { base: 'main..HEAD' }, id));
    const optionLike = await failure(() => run('git.pr.draft', { base: '--output=draft-leak.txt' }, id));
    const leaked = await fs.stat(path.join(folder, 'draft-leak.txt')).then(() => true, () => false);
    check(
      'git draft: a base that is no ref, a range or option-like is refused',
      noRef.includes('INVALID_INPUT') && noRef.includes('is not a branch, tag or commit') && range.includes('INVALID_INPUT') && optionLike.includes('INVALID_INPUT') && !leaked,
      { noRef, range, optionLike, leaked },
    );

    // Without a base given, a remote gh would open the pull request on comes first with its own main, even when
    // origin has a HEAD (a fork's origin, an upstream fetched without its HEAD).
    await sh('remote', 'add', 'upstream', 'https://example.invalid/upstream.git');
    await sh('update-ref', 'refs/remotes/upstream/main', 'main');
    const onUpstream = await run<GitPrDraft>('git.pr.draft', {}, id).catch((err: Error) => ({ error: err.message }) as unknown as GitPrDraft);
    await sh('remote', 'remove', 'upstream');
    check('git draft: the default base is the first remote in the order gh picks with a main, before origin/HEAD', onUpstream.baseRef === 'upstream/main' && onUpstream.base === 'main', onUpstream);

    // A detached HEAD: named by its short hash, titled by the first commit, no labels from a branch prefix.
    await sh('checkout', '-q', '--detach', 'feat/pr-draft');
    const detached = await run<GitPrDraft>('git.pr.draft', {}, id).catch((err: Error) => ({ error: err.message }) as unknown as GitPrDraft);
    await sh('checkout', '-q', 'feat/pr-draft');
    check('git draft: a detached HEAD is drafted under its short hash with the first subject as the title', /^[0-9a-f]{7}$/.test(detached.head ?? '') && detached.title === 'Add the parser' && detached.labels?.length === 0 && detached.stats?.commits === 2, detached);

    // A template reached through a linked folder that leads out of the repository is not read.
    const outside = path.join(ghDir, 'outside');
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, 'pull_request_template.md'), '## Summary\n\nOUTSIDE-SECRET\n');
    const linked = await fs.symlink(outside, path.join(folder, '.github'), 'junction').then(
      () => true,
      () => false,
    );
    if (linked) {
      const escaped = await run<GitPrDraft>('git.pr.draft', {}, id).finally(() => fs.unlink(path.join(folder, '.github')).catch(() => {}));
      check('git draft: a template behind a linked .github folder outside the repository is not read', escaped.template === null && !escaped.body.includes('OUTSIDE-SECRET'), { template: escaped.template, templatePath: escaped.templatePath });
    }

    // The patch: whole under the cap, cut at a line end over it.
    const withPatch = await run<GitPrDraft>('git.pr.draft', { includePatch: true }, id);
    check('git draft: includePatch gives the base...HEAD diff', withPatch.patch?.truncated === false && withPatch.patch.text.includes('+++ b/src/parser.ts') && withPatch.patch.text.includes('+there'), withPatch.patch);
    await sh('checkout', '-q', '-b', 'feat/big', 'main');
    await write('big.txt', Array.from({ length: 40_000 }, (_, i) => `line ${i}`).join('\n') + '\n');
    await sh('add', 'big.txt');
    await sh('commit', '-q', '-m', 'Add a big file');
    const big = await run<GitPrDraft>('git.pr.draft', { includePatch: true }, id);
    const bytes = Buffer.byteLength(big.patch?.text ?? '');
    check('git draft: a patch over 200 KB is cut at a line end and marked truncated', big.patch?.truncated === true && bytes <= 200 * 1024 && bytes > 150 * 1024 && big.patch.text.endsWith('\n'), { truncated: big.patch?.truncated, bytes });
    check('git draft: a single commit gives its subject as the title', big.title === 'Add a big file' && big.stats.commits === 1, big.title);

    // A merge of main into the branch is neither listed nor counted.
    await sh('checkout', '-q', 'main');
    await write('main.txt', 'main moved\n');
    await sh('add', 'main.txt');
    await sh('commit', '-q', '-m', 'Main moves on');
    await sh('push', '-q', 'origin', 'main');
    await sh('checkout', '-q', 'feat/pr-draft');
    await sh('merge', '-q', '--no-ff', '-m', 'Merge main into feat/pr-draft', 'main');
    const merged = await run<GitPrDraft>('git.pr.draft', {}, id);
    check(
      'git draft: a merge from the base is left out of the commits, and its files out of the changes',
      merged.commits.map((c) => c.subject).join('|') === 'Add the parser|Document the parser' && merged.stats.commits === 2 && !merged.files.some((f) => f.path === 'main.txt'),
      { commits: merged.commits.map((c) => c.subject), files: merged.files.map((f) => f.path) },
    );

    // Agents may call it: it is a read.
    const rpc = async (name: string, args: unknown): Promise<RpcResult> => {
      const res = await fetch(`http://127.0.0.1:${mcpPort}/mcp?workspace=${encodeURIComponent(folder)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      });
      return (await res.json()) as RpcResult;
    };
    const agent = await rpc('git_pr_draft', { includePatch: true });
    const agentText = agent.result?.content?.[0]?.text ?? '';
    check('git draft: agents may draft (not gated)', t.toolNames.includes('git_pr_draft') && !agent.result?.isError && agentText.includes('Pr draft') && agentText.includes('diff --git'), agentText.slice(0, 200));

    // The UI hook works on this branch with the template and the labels back.
    await write('.github/pull_request_template.md', TEMPLATE);
    await fake.update((s) => {
      s.repoLabels = ['bug', 'enhancement'];
    });
  } catch (err) {
    await after();
    throw err;
  } finally {
    restoreGh();
    if (ws) await run('workspace.close', { id: ws.id }, null).catch(() => {});
  }

  return {
    after,
    ui: async ({ js, wait, shot }) => {
      const setInput = `(el, value) => { const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); }`;
      const visible = (selector: string) => `[...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.offsetParent !== null)`;
      const click = (selector: string) => js(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el?.click(); return Boolean(el); })()`);
      const waitFor = (code: string, ms = 4000) => until(async () => Boolean(await js(code)), ms);
      const value = (testid: string) => js(`${visible(`[data-testid=${testid}]`)}?.value ?? null`);
      const dialogButton = (label: string) => js(`(() => { const b = [...document.querySelectorAll('.fixed.inset-0 button')].find((e) => e.textContent.trim() === ${JSON.stringify(label)}); b?.click(); return Boolean(b); })()`);
      let uiWs: WorkspaceInfo | undefined;
      process.env.QUIVER_GH_PATH = fake.command;
      try {
        uiWs = await run<WorkspaceInfo>('workspace.open', { path: folder }, null);
        await waitFor(`Boolean(document.querySelector('[data-testid=workspace-tab][data-drag-id="${uiWs.id}"]'))`);
        await click(`[data-testid=workspace-tab][data-drag-id="${uiWs.id}"]`);
        await wait(300);
        await js(`document.documentElement.classList.remove('dark')`);
        await click('[data-testid=activity-item][data-drag-id=git]');
        await waitFor(`document.querySelector('[data-testid=git-current-branch]')?.textContent.trim() === 'feat/pr-draft' && Boolean(document.querySelector('[data-testid=git-open-prs]'))`, 6000);
        await click('[data-testid=git-open-prs]');
        await waitFor(`Boolean(${visible('[data-testid=git-pr-new]')})`, 8000);
        await js(`${visible('[data-testid=git-pr-new]')}?.click()`);

        // Opening the form on a branch with commits fills it from the draft.
        const filled = await waitFor(`${visible('[data-testid=git-pr-title]')}?.value === 'Pr draft' && ${visible('[data-testid=git-pr-labels]')}?.value === 'enhancement'`, 8000);
        const form = (await js(
          `(() => { const s = ${visible('[data-testid=git-pr-draft-summary]')}; return { title: ${visible('[data-testid=git-pr-title]')}?.value, body: ${visible('[data-testid=git-pr-body]')}?.value, base: ${visible('[data-testid=git-pr-base]')}?.value, labels: ${visible('[data-testid=git-pr-labels]')}?.value, commits: s?.getAttribute('data-commits'), files: s?.getAttribute('data-files'), rows: [...(s?.querySelectorAll('[data-testid=git-pr-draft-commit]') ?? [])].map((r) => r.querySelector('.truncate')?.textContent.trim()) }; })()`,
        )) as { title: string; body: string; base: string; labels: string; commits: string; files: string; rows: string[] };
        check(
          'git draft ui: the new pull request form fills itself from the branch: title, template body, base, label and a summary of commits and files',
          filled &&
            form.title === 'Pr draft' &&
            form.body.startsWith('## What changed\n\n<!-- What, and why. -->\n\n- Add the parser') &&
            form.body.includes('## How it was verified') &&
            form.base === 'main' &&
            form.labels === 'enhancement' &&
            form.commits === '2' &&
            form.files === '3' &&
            JSON.stringify(form.rows) === JSON.stringify(['Add the parser', 'Document the parser']),
          form,
        );
        await shot('32pd-git-pr-draft-light');

        // A title the user typed is replaced only after asking: No keeps it, Replace puts the draft's back.
        await js(`(() => { const set = ${setInput}; set(${visible('[data-testid=git-pr-title]')}, 'My own title'); })()`);
        await wait(100);
        await js(`${visible('[data-testid=git-pr-draft-fill]')}?.click()`);
        const asked = await waitFor(`document.querySelector('.fixed.inset-0 h2')?.textContent.trim() === 'Replace the title you wrote?'`, 4000);
        await js(`document.documentElement.classList.add('dark')`);
        await wait(150);
        await shot('32pe-git-pr-draft-replace-dark');
        await js(`document.documentElement.classList.remove('dark')`);
        await dialogButton('Cancel');
        // The first dialog has to be gone, or the second wait below finds it and Replace clicks a closing dialog.
        await waitFor(`!document.querySelector('.fixed.inset-0 h2')`, 4000);
        await wait(200);
        const kept = await value('git-pr-title');
        await js(`${visible('[data-testid=git-pr-draft-fill]')}?.click()`);
        await waitFor(`Boolean(document.querySelector('.fixed.inset-0 h2'))`, 4000);
        await dialogButton('Replace');
        const replaced = await waitFor(`${visible('[data-testid=git-pr-title]')}?.value === 'Pr draft'`, 4000);
        check('git draft ui: Draft from changes asks before replacing a typed title, and keeps it when told no', asked && kept === 'My own title' && replaced, { asked, kept, replaced });
        // The base the form filled in (`main`) is not passed back: the draft still compares with origin/main.
        const against = (await js(`${visible('[data-testid=git-pr-draft-summary]')}?.textContent.replace(/\\s+/g, ' ') ?? ''`)) as string;
        check('git draft ui: drafting again keeps comparing with the remote default branch, not the local base the form filled in', against.includes('against origin/main'), against);
      } finally {
        await js(`[...document.querySelectorAll('.fixed.inset-0 button')].find((b) => b.textContent.trim() === 'Cancel')?.click()`).catch(() => {});
        restoreGh();
        await click(`[data-testid=workspace-tab][data-drag-id="${t.ws.id}"]`);
        await wait(200);
        if (uiWs) await run('workspace.close', { id: uiWs.id }, null).catch(() => {});
      }
    },
  };
};

export default section;
