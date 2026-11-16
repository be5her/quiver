import { promises as fs } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { GhStatus, GitAccountInfo, GitPullRequest, RunnerOutputChunk, RunnerTask, WorkspaceInfo } from '@quiver/core';
import { runToEnd } from '@quiver/core/node';
import { writeFakeGh, type FakeGhState } from '../../fake-gh';
import { findNode } from '../../fake-tsh';
import type { SmokeSection } from '../../part';

// Git: the GitHub account a workspace works as. Against the fake gh (fake-gh.ts), signed in to two accounts, and an
// HTTP remote that always asks for a sign-in, whose credential helper writes down the github.com username git's
// configuration names for it (what Git Credential Manager signs in with): so the checks see which account git and gh
// were given, by Quiver's calls and by a Runner task, and that git run outside Quiver in the same repository is given none.

const REPO = 'smoke/accounts';

function initialState(): FakeGhState {
  const now = '2026-11-01T10:00:00Z';
  const pr = (number: number, author: string) => ({
    number,
    title: `PR by ${author}`,
    state: 'OPEN' as const,
    isDraft: false,
    author: { login: author },
    headRefName: `feat/${number}`,
    baseRefName: 'main',
    url: `https://github.com/${REPO}/pull/${number}`,
    createdAt: now,
    updatedAt: now,
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
  });
  return { login: 'smoke-work', others: ['smoke-home'], repo: REPO, defaultBranch: 'main', prs: [pr(1, 'smoke-work'), pr(2, 'smoke-home')], checks: {}, jobLogs: {}, diffs: {}, opened: [] };
}

/**
 * A credential helper that writes down the github.com username git's configuration gives it ("none" without one),
 * asked of git from inside the helper as any helper would see it, and the GH_TOKEN it was started with ("notoken"),
 * which is what gh as a credential helper answers with; it answers with a password.
 */
const HELPER = String.raw`
const fs = require('fs');
const { spawnSync } = require('child_process');
const action = process.argv[process.argv.length - 1];
if (action !== 'get') process.exit(0);
fs.readFileSync(0, 'utf8');
const user = spawnSync('git', ['config', '--get', 'credential.https://github.com.username'], { encoding: 'utf8' }).stdout.trim() || 'none';
fs.appendFileSync(__CRED_LOG__, user + ' ' + (process.env.GH_TOKEN || 'notoken') + '\n');
process.stdout.write('username=smoke\npassword=smoke\n');
`;

const section: SmokeSection = async (t) => {
  const { check, run, rpc } = t;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'quiver-smoke-account-'));
  const folder = path.join(dir, 'repo');
  await fs.mkdir(folder);
  const fake = await writeFakeGh(dir, initialState());
  const previousGh = process.env.QUIVER_GH_PATH;
  const credLog = path.join(dir, 'cred.log');
  const helper = path.join(dir, 'helper.cjs');
  await fs.writeFile(helper, HELPER.replace('__CRED_LOG__', JSON.stringify(credLog)));

  // A remote that asks every request to sign in, so git asks its credential helper.
  const server = http.createServer((_req, res) => {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="smoke"' }).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  const sh = (...args: string[]) => runToEnd('git', args, { cwd: folder, env: { GIT_TERMINAL_PROMPT: '0' } });
  const used = async () => (await fs.readFile(credLog, 'utf8').catch(() => '')).split('\n').filter(Boolean);
  const failure = (fn: () => Promise<unknown>) =>
    fn().then(
      () => '',
      (err: Error & { code?: string }) => `${err.code ?? ''} ${err.message}`,
    );
  const after = async () => {
    if (previousGh === undefined) delete process.env.QUIVER_GH_PATH;
    else process.env.QUIVER_GH_PATH = previousGh;
    server.close();
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  };

  let ws: WorkspaceInfo | undefined;
  try {
    await sh('init', '-q', '-b', 'main');
    await sh('config', 'user.name', 'Smoke');
    await sh('config', 'user.email', 'smoke@quiver.test');
    await sh('commit', '-q', '--allow-empty', '-m', 'first');
    // The pull requests' repository is on github.com; fetches go to the local remote that asks for a sign-in. Only the
    // helper below answers: the empty value drops the helpers of the machine (Git Credential Manager) for this repository.
    await sh('remote', 'add', 'origin', `https://github.com/${REPO}.git`);
    await sh('config', 'remote.origin.pushurl', `http://127.0.0.1:${port}/accounts.git`);
    await sh('remote', 'add', 'asks', `http://127.0.0.1:${port}/accounts.git`);
    await sh('config', '--add', 'credential.helper', '');
    // git adds the action (get, store, erase) after what the value says.
    await sh('config', '--add', 'credential.helper', `!"${findNode().replace(/\\/g, '/')}" "${helper.replace(/\\/g, '/')}"`);
    process.env.QUIVER_GH_PATH = fake.command;
    ws = await run<WorkspaceInfo>('workspace.open', { path: folder }, null);
    const id = ws.id;

    // Nothing chosen: gh's active account, and git is given no username.
    const none = await run<GitAccountInfo>('git.account.get', {}, id);
    check(
      'git account: none chosen at first, with the accounts gh is signed in to and its active one marked',
      none.account === null && none.accounts.map((a) => `${a.login}:${a.active}`).join() === 'smoke-work:true,smoke-home:false' && !none.message,
      none,
    );
    const before = await run<GhStatus>('git.pr.status', {}, id);
    check("git account: without one, gh works as its active account and gets no token", before.user === 'smoke-work' && (await fake.calls()).every((c) => !c.token && !c.gitUser), before);

    // Choosing one gh is not signed in to is refused; the name is matched as GitHub does, without case.
    const unknown = await failure(() => run('git.account.set', { account: 'nobody' }, id));
    check('git account: an account gh is not signed in to is refused, naming the ones it is', unknown.includes('INVALID_INPUT') && unknown.includes('nobody') && unknown.includes('smoke-work, smoke-home'), unknown);
    const badName = await failure(() => run('git.account.set', { account: 'a\nb' }, id));
    check('git account: a value that is not a GitHub login is refused', badName.includes('INVALID_INPUT'), badName);
    const chosen = await run<GitAccountInfo>('git.account.set', { account: 'Smoke-Home' }, id);
    const kept = await t.host.workspaces.get(id)!.getState<unknown>('git.githubAccount', null);
    check('git account: the choice is kept per machine, spelled as gh spells it', chosen.account === 'smoke-home' && kept === 'smoke-home', { chosen, kept });

    // gh runs as the chosen account, with its token for that call only.
    const callsBefore = (await fake.calls()).length;
    const as = await run<GhStatus>('git.pr.status', {}, id);
    const mine = await run<GitPullRequest[]>('git.pr.list', { filter: 'mine' }, id);
    const ghCalls = (await fake.calls()).slice(callsBefore);
    const tokenRead = ghCalls.filter((c) => c.argv.slice(0, 2).join(' ') === 'auth token');
    const asAccount = ghCalls.filter((c) => c.argv.slice(0, 2).join(' ') !== 'auth token');
    check('git account: gh is signed in as the chosen account', as.user === 'smoke-home' && mine.map((p) => p.number).join() === '2', { as, mine });
    check(
      "git account: gh gets the account's token and git's credential username; the token is read from gh once, without either",
      tokenRead.length === 1 && tokenRead[0].argv.includes('smoke-home') && !tokenRead[0].token && asAccount.length >= 2 && asAccount.every((c) => c.token === 'fake-token-smoke-home' && c.gitUser === 'smoke-home'),
      ghCalls,
    );

    // git runs as the chosen account: its credential helper is handed the username, on a fetch and a push.
    await fs.rm(credLog, { force: true });
    await failure(() => run('git.fetch', { remote: 'asks' }, id));
    await failure(() => run('git.push', { remote: 'origin', setUpstream: true }, id));
    const quiverUsed = await used();
    // The same repository outside Quiver: no username, the machine's own behaviour.
    await fs.rm(credLog, { force: true });
    await sh('fetch', 'asks');
    const outsideUsed = await used();
    const config = (await sh('config', '--get-regexp', 'username')).stdout.trim();
    check(
      'git account: fetch and push are signed in as the chosen account, with its token for gh as a credential helper, through their own environment only',
      quiverUsed.length >= 2 && quiverUsed.every((u) => u === 'smoke-home fake-token-smoke-home') && outsideUsed.length >= 1 && outsideUsed.every((u) => u === 'none notoken') && !config,
      { quiverUsed, outsideUsed, config },
    );

    // A Runner task started in the workspace gets the same account, for the git and gh it runs.
    const node = `"${process.execPath}"`;
    await t.host.workspaces.get(id)!.store.put('runner', {
      id: 'smoke-account',
      name: 'smoke-account',
      cwd: '',
      autoRestart: false,
      source: 'saved',
      env: [{ id: 'n', key: 'ELECTRON_RUN_AS_NODE', value: '1', enabled: true }],
      command: `${node} -e "const e=process.env,n=Number(e.GIT_CONFIG_COUNT)-1;console.log('token='+e.GH_TOKEN+' ok='+(e.GH_TOKEN==='fake-token-smoke-home')+' git='+e['GIT_CONFIG_VALUE_'+n])"`,
    } satisfies RunnerTask);
    await run('runner.proc.start', { taskId: 'smoke-account' }, id);
    await run('runner.proc.wait', { taskId: 'smoke-account', pattern: 'token=', timeoutMs: 15_000 }, id);
    const taskOut = (await run<RunnerOutputChunk>('runner.proc.output', { taskId: 'smoke-account', after: 0, limit: 50 }, id)).lines.map((l) => l.text).join('\n');
    check(
      'git account: a Runner task gets the account for its git and gh, and says so, while the token never shows in its output',
      taskOut.includes('token=*** ok=true git=smoke-home') && taskOut.includes('GitHub account smoke-home') && !taskOut.includes('fake-token-smoke-home'),
      taskOut,
    );

    // Agents read the account and cannot change it.
    const agentGet = await rpc('tools/call', { name: 'git_account_get', arguments: {} });
    const agentSet = await rpc('tools/call', { name: 'git_account_set', arguments: { account: 'smoke-work' } });
    check(
      'git account: agents can read it, and changing it is a mutation they are refused',
      agentGet.result?.isError !== true && agentSet.result?.isError === true && (agentSet.result.content?.[0]?.text ?? '').includes('MUTATION_BLOCKED'),
      { get: agentGet.result?.content?.[0]?.text?.slice(0, 200), set: agentSet.result?.content?.[0]?.text?.slice(0, 200) },
    );

    // The account signed out of gh: said so by name, not passed off as another account's answer.
    await fake.update((s) => {
      s.others = [];
    });
    const gone = await run<GitAccountInfo>('git.account.get', {}, id);
    const goneList = await failure(() => run('git.pr.list', {}, id));
    const goneStatus = await run<GhStatus>('git.pr.status', {}, id);
    check(
      'git account: an account signed out of gh is named in what to do, and gh is not run as another',
      gone.account === 'smoke-home' && (gone.message ?? '').includes('smoke-home') && goneList.includes('AUTH_REQUIRED') && goneList.includes('smoke-home') && !goneStatus.authenticated && (goneStatus.message ?? '').includes('smoke-home'),
      { gone, goneList, goneStatus },
    );

    // Back to gh's active account.
    await fake.update((s) => {
      s.others = ['smoke-home'];
    });
    const cleared = await run<GitAccountInfo>('git.account.set', { account: null }, id);
    const callsCleared = (await fake.calls()).length;
    const back = await run<GhStatus>('git.pr.status', {}, id);
    check(
      "git account: cleared, gh works as its active account again with no token given",
      cleared.account === null && back.user === 'smoke-work' && (await fake.calls()).slice(callsCleared).every((c) => !c.token && !c.gitUser),
      back,
    );
  } catch (err) {
    check('git account: section ran to the end', false, (err as Error).stack);
  } finally {
    if (ws) await run('workspace.close', { id: ws.id }, null).catch(() => {});
  }
  return { after };
};

export default section;
