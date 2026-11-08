import { promises as fs } from 'node:fs';
import path from 'node:path';
import { findNode } from './fake-tsh';

/** One pull request as the fake keeps it: the fields of gh's --json, plus who was asked to review. */
export interface FakeGhPr {
  number: number;
  title: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  author: { login: string };
  headRefName: string;
  baseRefName: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  reviewDecision: string;
  labels: { name: string }[];
  statusCheckRollup: Record<string, unknown>[];
  body: string;
  additions: number;
  deletions: number;
  files: { path: string; additions: number; deletions: number }[];
  reviews: { author: { login: string }; state: string; submittedAt: string; body: string }[];
  comments: { author: { login: string }; createdAt: string; body: string }[];
  reviewRequested: string[];
  /** Whether the head branch is on another repository (a fork), and whose. */
  isCrossRepository: boolean;
  headRepositoryOwner: { login: string };
}

export interface FakeGhState {
  /** The signed-in account, or null when signed out. */
  login: string | null;
  /**
   * `owner/name` on github.com: the only repository the fake answers for. --repo (the argument of `repo view`) must
   * be `github.com/owner/name`, host included, so a call without it, or without the host, fails.
   */
  repo: string;
  /** What `gh repo view --json defaultBranchRef` gives. */
  defaultBranch: string;
  prs: FakeGhPr[];
  /** `gh pr checks --json` rows per pull request number. */
  checks: Record<string, Record<string, unknown>[]>;
  /** `gh run view --job <id> --log-failed` output per job id. */
  jobLogs: Record<string, string>;
  /** `gh pr diff` output per pull request number. */
  diffs: Record<string, string>;
  /** Pull requests opened with --web. */
  opened: number[];
  /** The repository's labels for `gh label list`; the command fails when this is not set. */
  repoLabels?: string[];
}

export interface FakeGhCall {
  argv: string[];
  cwd: string;
  /** What arrived on stdin, for --body-file -. */
  stdin: string | null;
}

export interface FakeGh {
  /** Value for QUIVER_GH_PATH: `"<node>" "<script>"`. */
  command: string;
  getState(): Promise<FakeGhState>;
  setState(state: FakeGhState): Promise<void>;
  update(fn: (state: FakeGhState) => void): Promise<void>;
  calls(): Promise<FakeGhCall[]>;
}

/**
 * A stand-in for the GitHub CLI, written as a Node script so the smoke can exercise pull requests without GitHub or
 * the user's own sign-in. It answers the subcommands Quiver runs (`auth status`, `pr list|view|checks|diff|checkout|
 * create|comment`, `run view --log-failed`, `repo view`, `label list`) from a JSON state file, exits like gh (4 when signed out, 1 or 8 from
 * `pr checks` for failed or pending checks), refuses any repository but its own, and logs every argv with its stdin.
 */
export async function writeFakeGh(dir: string, state: FakeGhState): Promise<FakeGh> {
  const stateFile = path.join(dir, 'fake-gh-state.json');
  const callsFile = path.join(dir, 'fake-gh-calls.jsonl');
  const script = path.join(dir, 'fake-gh.cjs');
  await fs.writeFile(script, FAKE_GH_SOURCE.replace('__STATE_FILE__', JSON.stringify(stateFile)).replace('__CALLS_FILE__', JSON.stringify(callsFile)), 'utf8');
  const getState = async () => JSON.parse(await fs.readFile(stateFile, 'utf8')) as FakeGhState;
  const setState = (s: FakeGhState) => fs.writeFile(stateFile, JSON.stringify(s), 'utf8');
  await setState(state);
  const quote = (p: string) => `"${p.replace(/\\/g, '/')}"`;
  return {
    command: `${quote(findNode())} ${quote(script)}`,
    getState,
    setState,
    update: async (fn) => {
      const s = await getState();
      fn(s);
      await setState(s);
    },
    calls: async () =>
      (await fs.readFile(callsFile, 'utf8').catch(() => ''))
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as FakeGhCall),
  };
}

const FAKE_GH_SOURCE = String.raw`
const fs = require('fs');
const { spawnSync } = require('child_process');
const STATE_FILE = __STATE_FILE__;
const CALLS_FILE = __CALLS_FILE__;
const argv = process.argv.slice(2);

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}
const stdin = argv.includes('--body-file') ? readStdin() : null;
fs.appendFileSync(CALLS_FILE, JSON.stringify({ argv, cwd: process.cwd(), stdin }) + '\n');

const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
const save = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state));
function fail(message, code) {
  process.stderr.write(message + '\n');
  process.exit(code === undefined ? 1 : code);
}
/** --name value or --name=value. */
function flag(name) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--' + name) return argv[i + 1];
    if (argv[i].startsWith('--' + name + '=')) return argv[i].slice(name.length + 3);
  }
  return undefined;
}
const has = (name) => argv.includes('--' + name);
function all(name) {
  return argv.filter((a) => a.startsWith('--' + name + '=')).map((a) => a.slice(name.length + 3));
}
function pick(obj, fields) {
  const out = {};
  for (const f of fields.split(',')) if (f in obj) out[f] = obj[f];
  return out;
}
function prOf(n) {
  const pr = state.prs.find((p) => p.number === Number(n));
  if (!pr) fail('GraphQL: Could not resolve to a PullRequest with the number of ' + n + '. (repository.pullRequest)');
  return pr;
}

const [cmd, sub] = argv;
if (cmd === '--version') {
  process.stdout.write('gh version 2.100.0 (fake)\n');
  process.exit(0);
}
if (cmd === 'auth' && sub === 'status') {
  const host = flag('hostname') || 'github.com';
  const accounts = state.login ? [{ state: 'success', active: true, host, login: state.login, tokenSource: 'keyring', scopes: 'repo', gitProtocol: 'https' }] : [];
  if (has('json')) process.stdout.write(JSON.stringify({ hosts: accounts.length ? { [host]: accounts } : {} }) + '\n');
  else if (accounts.length) process.stdout.write(host + '\n  ✓ Logged in to ' + host + ' account ' + state.login + ' (keyring)\n  - Active account: true\n');
  else process.stderr.write('You are not logged into any GitHub hosts. To log in, run: gh auth login\n');
  process.exit(accounts.length ? 0 : 1);
}
if (!state.login) fail('To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.', 4);
const repoGiven = cmd === 'repo' ? argv[2] : flag('repo');
if (repoGiven !== 'github.com/' + state.repo) fail('GraphQL: Could not resolve to a Repository with the name \'' + repoGiven + '\'. (repository)');

if (cmd === 'repo' && sub === 'view') {
  process.stdout.write(JSON.stringify(pick({ defaultBranchRef: { name: state.defaultBranch } }, flag('json'))) + '\n');
  process.exit(0);
}

if (cmd === 'label' && sub === 'list') {
  if (!state.repoLabels) fail('HTTP 502: Bad Gateway (https://api.github.com/graphql)');
  process.stdout.write(JSON.stringify(state.repoLabels.map((name) => pick({ name, color: 'ededed', description: '' }, flag('json')))) + '\n');
  process.exit(0);
}
if (cmd === 'pr' && sub === 'list') {
  const wanted = { open: ['OPEN'], closed: ['CLOSED', 'MERGED'], merged: ['MERGED'], all: ['OPEN', 'CLOSED', 'MERGED'] }[flag('state') || 'open'];
  let list = state.prs.filter((p) => wanted.includes(p.state));
  if (flag('author') === '@me') list = list.filter((p) => p.author.login === state.login);
  if (flag('search') === 'review-requested:@me') list = list.filter((p) => p.reviewRequested.includes(state.login));
  list = list.sort((a, b) => b.number - a.number).slice(0, Number(flag('limit') || 30));
  process.stdout.write(JSON.stringify(list.map((p) => pick(p, flag('json')))) + '\n');
  process.exit(0);
}
if (cmd === 'pr' && sub === 'view') {
  const pr = prOf(argv[2]);
  if (has('web')) {
    state.opened.push(pr.number);
    save();
    process.stderr.write('Opening ' + pr.url.replace('https://', '') + ' in your browser.\n');
    process.exit(0);
  }
  process.stdout.write(JSON.stringify(pick(pr, flag('json'))) + '\n');
  process.exit(0);
}
if (cmd === 'pr' && sub === 'checks') {
  const pr = prOf(argv[2]);
  const rows = state.checks[pr.number] || [];
  if (!rows.length) fail("no checks reported on the '" + pr.headRefName + "' branch");
  process.stdout.write(JSON.stringify(rows.map((r) => pick(r, flag('json')))) + '\n');
  process.exit(rows.some((r) => r.bucket === 'fail') ? 1 : rows.some((r) => r.bucket === 'pending') ? 8 : 0);
}
if (cmd === 'run' && sub === 'view') {
  const log = state.jobLogs[flag('job')];
  if (log === undefined || !has('log-failed')) fail('job ' + flag('job') + ' is still in progress; logs will be available when it is complete');
  process.stdout.write(log);
  process.exit(0);
}
if (cmd === 'pr' && sub === 'diff') {
  const pr = prOf(argv[2]);
  process.stdout.write(state.diffs[pr.number] || '');
  process.exit(0);
}
if (cmd === 'pr' && sub === 'checkout') {
  const pr = prOf(argv[2]);
  const git = (...args) => spawnSync('git', args, { encoding: 'utf8' });
  const exists = git('rev-parse', '--verify', '--quiet', 'refs/heads/' + pr.headRefName).status === 0;
  const result = exists ? git('checkout', pr.headRefName) : git('checkout', '-b', pr.headRefName);
  if (result.status !== 0) fail(result.stderr.trim());
  process.stderr.write(result.stderr);
  process.exit(0);
}
if (cmd === 'pr' && sub === 'create') {
  const number = Math.max(0, ...state.prs.map((p) => p.number)) + 1;
  const now = new Date().toISOString();
  const head = flag('head');
  const pr = {
    number, title: flag('title'), state: 'OPEN', isDraft: has('draft'), author: { login: state.login },
    headRefName: head.includes(':') ? head.split(':')[1] : head, baseRefName: flag('base') || 'main',
    url: 'https://github.com/' + state.repo + '/pull/' + number, createdAt: now, updatedAt: now, reviewDecision: '',
    labels: all('label').map((name) => ({ name })), statusCheckRollup: [], body: stdin || '', additions: 0, deletions: 0,
    files: [], reviews: [], comments: [], reviewRequested: [],
    isCrossRepository: head.includes(':'), headRepositoryOwner: { login: head.includes(':') ? head.split(':')[0] : state.repo.split('/')[0] },
  };
  state.prs.push(pr);
  save();
  process.stdout.write('\nCreating pull request for ' + head + ' into ' + pr.baseRefName + ' in ' + state.repo + '\n\n' + pr.url + '\n');
  process.exit(0);
}
if (cmd === 'pr' && sub === 'comment') {
  const pr = prOf(argv[2]);
  pr.comments.push({ author: { login: state.login }, createdAt: new Date().toISOString(), body: stdin || '' });
  pr.updatedAt = new Date().toISOString();
  save();
  process.stdout.write(pr.url + '#issuecomment-' + pr.comments.length + '\n');
  process.exit(0);
}
fail('fake gh: unknown command ' + argv.join(' '));
`;
