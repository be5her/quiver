import path from 'node:path';
import {
  GH_CHECK_FIELDS,
  GH_PR_DETAIL_FIELDS,
  GH_PR_FIELDS,
  QuiverError,
  failedLogExcerpt,
  jobIdFromCheckUrl,
  parseAuthStatus,
  parseChecks,
  parseGhJson,
  parsePatchFiles,
  parsePullRequestDetail,
  parsePullRequest,
  parsePullRequestList,
  pickRemote,
  repoArg,
  tokenizeShell,
  type GhStatus,
  type GitDiffFile,
  type GitHubRepoRef,
  type GitPrCheckWithLog,
  type GitPullRequest,
  type GitPullRequestDetail,
} from '@quiver/core';
import { runToEnd, whichSync, type RunToEndResult } from '@quiver/core/node';
import * as local from './local';

// Pull requests through the GitHub CLI (`gh`), signed in as the user: Quiver never sees or stores a token. Every call
// runs in the repository root with prompts and update notices off, names the repository with --repo (picked from the
// configured remotes, as gh itself would), and asks for --json, which @quiver/core's gh-parse reads.

const READ_TIMEOUT_MS = 30_000;
const NETWORK_TIMEOUT_MS = 180_000;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_PATCH_BYTES = 512 * 1024;
/** At most this many failed jobs get their log read, one gh call each. */
const MAX_FAILED_LOGS = 5;
const FAILED_LOG_LINES = 60;

// Colour, a TTY or a pager forced from the user's environment would break the JSON and hang `pr diff`.
const ENV: Record<string, string> = {
  GH_PROMPT_DISABLED: '1',
  GH_NO_UPDATE_NOTIFIER: '1',
  GH_NO_EXTENSION_UPDATE_NOTIFIER: '1',
  GH_SPINNER_DISABLED: '1',
  NO_COLOR: '1',
  CLICOLOR_FORCE: '0',
  GH_FORCE_TTY: '',
  GH_PAGER: 'cat',
  GIT_TERMINAL_PROMPT: '0',
};
/** For a checkout an agent made: keep Git Credential Manager from opening a window nobody asked for (see local.ts). */
const NON_INTERACTIVE_ENV: Record<string, string> = { GCM_INTERACTIVE: 'never' };

/** Where the installer puts gh on Windows; a GUI app started before the install has the old PATH. */
const WINDOWS_DEFAULT = path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'GitHub CLI', 'gh.exe');

const INSTALL_HINT = 'Install the GitHub CLI (https://cli.github.com) and run "gh auth login" in a terminal.';

/**
 * The gh command line: `QUIVER_GH_PATH` when set (a path, or a quoted command line such as `"node" "fake-gh.cjs"`),
 * else gh on PATH, else the Windows installer's folder. Looked up on every call, so installing gh needs no restart.
 */
export function ghCommand(): string[] | null {
  const override = process.env.QUIVER_GH_PATH?.trim();
  if (override) {
    const asPath = whichSync(override);
    if (asPath) return [asPath];
    const [program, ...rest] = tokenizeShell(override);
    const resolved = program ? whichSync(program) : null;
    return resolved ? [resolved, ...rest] : null;
  }
  const found = whichSync('gh');
  if (found) return [found];
  return process.platform === 'win32' && whichSync(WINDOWS_DEFAULT) ? [WINDOWS_DEFAULT] : null;
}

function notInstalled(): QuiverError {
  const where = process.env.QUIVER_GH_PATH?.trim() ? ` at QUIVER_GH_PATH (${process.env.QUIVER_GH_PATH})` : ' on PATH';
  return new QuiverError('NOT_FOUND', `The GitHub CLI (gh) was not found${where}. ${INSTALL_HINT}`, { reason: 'no-gh' });
}

/** gh's own words for "sign in first": exit code 4, or an API that refused the token. */
function isAuthFailure(result: RunToEndResult): boolean {
  return result.code === 4 || /gh auth login|not logged in|authentication required|bad credentials|HTTP 401/i.test(result.stderr);
}

interface GhRunOptions {
  input?: string;
  timeoutMs?: number;
  maxBytes?: number;
  allowFailure?: boolean;
  env?: Record<string, string>;
}

/** Run gh in a folder. A non-zero exit throws: AUTH_REQUIRED when gh is signed out, REQUEST_FAILED with gh's message otherwise. */
export async function gh(cwd: string, args: string[], options: GhRunOptions = {}): Promise<RunToEndResult> {
  const argv = ghCommand();
  if (!argv) throw notInstalled();
  const [program, ...fixed] = argv;
  const timeoutMs = options.timeoutMs ?? READ_TIMEOUT_MS;
  const result = await runToEnd(program, [...fixed, ...args], { cwd, env: { ...ENV, ...options.env }, input: options.input, timeoutMs, maxBytes: options.maxBytes ?? MAX_OUTPUT_BYTES });
  if (result.error) throw new QuiverError('NOT_FOUND', `gh could not be started: ${result.error}. ${INSTALL_HINT}`, { reason: 'no-gh' });
  if (result.timedOut) throw new QuiverError('REQUEST_FAILED', `gh ${args.slice(0, 2).join(' ')} took longer than ${Math.round(timeoutMs / 1000)}s and was stopped`);
  // Output over the cap kills gh, so its exit code says nothing; the caller gets what arrived, marked truncated.
  if (result.code !== 0 && !result.truncated && !options.allowFailure) throw failure(result, args);
  return result;
}

function failure(result: RunToEndResult, args: string[]): QuiverError {
  const message = result.stderr.trim() || result.stdout.trim() || `gh ${args.slice(0, 2).join(' ')} exited with code ${result.code}`;
  if (isAuthFailure(result)) return new QuiverError('AUTH_REQUIRED', `gh is not signed in: ${message.split(/\r?\n/)[0]}. Run "gh auth login" in a terminal.`, { reason: 'gh-signed-out' });
  return new QuiverError('REQUEST_FAILED', message.replace(/^(?:error|fatal|X): /i, ''), { exitCode: result.code });
}

// ---------- the repository ----------

interface PrRepo {
  /** The repository root, where gh runs. */
  root: string;
  remote: string;
  repo: GitHubRepoRef;
  /** The --repo value. */
  arg: string;
}

/**
 * Hosts gh is signed in to, for GitHub Enterprise remotes. Only asked when no remote is on github.com, and kept once
 * gh names any, since `gh auth status` goes over the network; while it names none it is asked again next time.
 */
let signedInHosts: string[] = [];

async function knownHosts(root: string): Promise<string[]> {
  if (!signedInHosts.length) {
    const result = await gh(root, ['auth', 'status', '--json', 'hosts'], { allowFailure: true }).catch(() => null);
    try {
      if (result?.stdout.trim().startsWith('{')) signedInHosts = Object.keys((parseGhJson(result.stdout) as { hosts?: Record<string, unknown> }).hosts ?? {});
    } catch {
      // Older gh without --json: Enterprise remotes then need GH_HOST.
    }
  }
  return ['github.com', ...(process.env.GH_HOST ? [process.env.GH_HOST] : []), ...signedInHosts];
}

/** The repository's remotes with their URLs, and which one `gh repo set-default` marked. */
async function remotes(root: string): Promise<{ name: string; url: string; resolved: boolean }[]> {
  const out = (await local.git(root, ['config', '--get-regexp', '^remote\\..+\\.(url|gh-resolved)$'], { allowFailure: true })).stdout;
  const byName = new Map<string, { name: string; url: string; resolved: boolean }>();
  for (const line of out.split(/\r?\n/)) {
    const m = /^remote\.(.+)\.(url|gh-resolved) (.*)$/.exec(line);
    if (!m) continue;
    const entry = byName.get(m[1]) ?? { name: m[1], url: '', resolved: false };
    if (m[2] === 'url') entry.url ||= m[3];
    else entry.resolved = m[3] === 'base';
    byName.set(m[1], entry);
  }
  return [...byName.values()].filter((r) => r.url);
}

/**
 * The GitHub repository a workspace's pull requests belong to, from its configured remotes only: gh is always handed
 * `--repo`, so it never guesses, and no input can point it at another repository.
 */
export async function prRepo(cwd: string): Promise<PrRepo> {
  // A missing gh is the first thing to fix, whatever the remotes are.
  if (!ghCommand()) throw notInstalled();
  const root = await local.repoRoot(cwd);
  const list = await remotes(root);
  let picked = pickRemote(list, ['github.com', ...(process.env.GH_HOST ? [process.env.GH_HOST] : [])]);
  if (!picked && list.length) picked = pickRemote(list, await knownHosts(root));
  if (!picked) {
    // Without the user part of the URL: remotes often carry a token there (https://oauth2:<token>@host/…).
    const named = list.map((r) => `${r.name}: ${withoutCredentials(r.url)}`).join(', ');
    throw new QuiverError('NOT_FOUND', named ? `No remote of this repository is on GitHub (${named}).` : 'This repository has no remote on GitHub. Add one with git remote add origin <url>.', { reason: 'not-github' });
  }
  return { root, remote: picked.remote, repo: picked.repo, arg: repoArg(picked.repo) };
}

/** A remote URL without the user and password of `scheme://user:pass@host/…`. */
export function withoutCredentials(url: string): string {
  return url.replace(/^([a-z][\w+.-]*:\/\/)[^@/]*@/i, '$1');
}

// ---------- reads ----------

/** Whether gh can be used here, with a message saying what to do when it cannot. Never throws for a missing piece. */
export async function status(cwd: string): Promise<GhStatus> {
  if (!ghCommand()) return { installed: false, authenticated: false, message: notInstalled().message };
  let repo: PrRepo | undefined;
  let repoProblem: string | undefined;
  try {
    repo = await prRepo(cwd);
  } catch (err) {
    repoProblem = (err as Error).message;
  }
  const host = repo?.repo.host ?? 'github.com';
  const runCwd = repo?.root ?? cwd;
  let result = await gh(runCwd, ['auth', 'status', '--hostname', host, '--json', 'hosts'], { allowFailure: true });
  // gh before 2.60 has no --json here; it prints the same facts as text, on stderr in older versions.
  if (/unknown flag/i.test(result.stderr)) result = await gh(runCwd, ['auth', 'status', '--hostname', host], { allowFailure: true });
  const auth = parseAuthStatus(result.stdout.trim().startsWith('{') ? result.stdout : `${result.stdout}\n${result.stderr}`, host);
  const message = !auth.authenticated ? `gh is not signed in to ${host}. Run "gh auth login" in a terminal.` : repoProblem;
  return { installed: true, authenticated: auth.authenticated, ...(auth.user ? { user: auth.user } : {}), ...(repo ? { repo: repo.arg } : {}), ...(message ? { message } : {}) };
}

export async function list(cwd: string, input: { filter: 'mine' | 'review-requested' | 'all'; state: 'open' | 'closed' | 'merged' | 'all'; limit: number }): Promise<GitPullRequest[]> {
  const repo = await prRepo(cwd);
  const filter = input.filter === 'mine' ? ['--author', '@me'] : input.filter === 'review-requested' ? ['--search', 'review-requested:@me'] : [];
  const { stdout } = await gh(repo.root, ['pr', 'list', '--repo', repo.arg, '--state', input.state, '--limit', String(input.limit), ...filter, '--json', GH_PR_FIELDS]);
  return parsePullRequestList(stdout);
}

export async function get(cwd: string, number: number): Promise<GitPullRequestDetail> {
  const repo = await prRepo(cwd);
  return parsePullRequestDetail((await gh(repo.root, ['pr', 'view', String(number), '--repo', repo.arg, '--json', GH_PR_DETAIL_FIELDS])).stdout);
}

export async function checks(cwd: string, number: number, failedLogs: boolean): Promise<GitPrCheckWithLog[]> {
  const repo = await prRepo(cwd);
  // gh pr checks exits 1 when a check failed and 8 while some are pending, with the JSON still on stdout.
  const args = ['pr', 'checks', String(number), '--repo', repo.arg, '--json', GH_CHECK_FIELDS];
  const result = await gh(repo.root, args, { allowFailure: true });
  if (!result.stdout.trim().startsWith('[')) {
    if (result.code === 0 || /no checks reported/i.test(result.stderr)) return [];
    throw failure(result, args);
  }
  const list: GitPrCheckWithLog[] = parseChecks(result.stdout);
  if (!failedLogs) return list;
  const failed = list.filter((c) => c.state === 'failure').slice(0, MAX_FAILED_LOGS);
  await Promise.all(
    failed.map(async (check) => {
      const job = jobIdFromCheckUrl(check.url);
      if (!job) {
        check.logError = 'Not a GitHub Actions job; its log is on the check page.';
        return;
      }
      try {
        // The log runs to megabytes; it is read whole up to the cap and its end kept, where the failure is.
        const run = await gh(repo.root, ['run', 'view', '--job', job, '--log-failed', '--repo', repo.arg], { timeoutMs: 60_000 });
        check.log = failedLogExcerpt(run.stdout, FAILED_LOG_LINES);
      } catch (err) {
        check.logError = (err as Error).message;
      }
    }),
  );
  return list;
}

export async function diff(cwd: string, number: number): Promise<GitDiffFile[]> {
  const repo = await prRepo(cwd);
  const result = await gh(repo.root, ['pr', 'diff', String(number), '--repo', repo.arg, '--color', 'never']);
  return parsePatchFiles(result.stdout, MAX_PATCH_BYTES, result.truncated);
}

/** Open the pull request's page in the browser; gh does the opening, with the user's $BROWSER or the system default. */
export async function open(cwd: string, number: number): Promise<void> {
  const repo = await prRepo(cwd);
  await gh(repo.root, ['pr', 'view', String(number), '--repo', repo.arg, '--web']);
}

/**
 * A cheap fingerprint of the open pull requests (number, last update, check states): what the 60-second refresh
 * compares to decide whether the view needs to reload. Check runs finishing do not change `updatedAt`, so they are in it.
 */
export async function fingerprint(cwd: string): Promise<string> {
  const repo = await prRepo(cwd);
  const { stdout } = await gh(repo.root, ['pr', 'list', '--repo', repo.arg, '--state', 'open', '--limit', '100', '--json', 'number,updatedAt,statusCheckRollup']);
  const prs = parsePullRequestList(stdout);
  return JSON.stringify(prs.map((p) => [p.number, p.updatedAt, p.checks]));
}

// ---------- writes ----------

/** Check out a pull request's branch (gh fetches it, from a fork too); fails rather than overwrite local changes. */
export async function checkout(cwd: string, number: number, interactive: boolean): Promise<string> {
  const repo = await prRepo(cwd);
  await gh(repo.root, ['pr', 'checkout', String(number), '--repo', repo.arg], { timeoutMs: NETWORK_TIMEOUT_MS, env: interactive ? undefined : NON_INTERACTIVE_ENV });
  return repo.root;
}

/** The pull request number in a URL gh printed (`…/pull/<n>`). */
function numberFromUrl(out: string): number {
  const n = /\/pull\/(\d+)/.exec(out)?.[1];
  if (!n) throw new QuiverError('REQUEST_FAILED', `gh did not print the pull request's address: ${out.trim().slice(0, 200)}`);
  return Number(n);
}

/**
 * Open a pull request from the current branch, which must be pushed: its upstream says which repository the head is
 * in, so a branch on a fork is given to gh as `owner:branch`. The title and labels go as `--flag=value` and the body on
 * stdin, so none of them can be read as an option.
 */
export async function create(cwd: string, input: { title: string; body: string; base?: string; draft: boolean; labels: string[] }): Promise<GitPullRequest> {
  const repo = await prRepo(cwd);
  const branch = (await local.status(repo.root)).branch;
  if (!branch) throw new QuiverError('INVALID_INPUT', 'HEAD is detached; switch to the branch the pull request is for');
  const config = async (key: string) => (await local.git(repo.root, ['config', '--get', `branch.${branch}.${key}`], { allowFailure: true })).stdout.trim();
  const notPushed = new QuiverError('INVALID_INPUT', `${branch} has not been pushed. Push it first (git.push with setUpstream), then create the pull request.`);
  const upstreamRemote = await config('remote');
  const pushedTo = (await remotes(repo.root)).find((r) => r.name === upstreamRemote);
  // A branch made from origin/main tracks origin/main, and "." tracks a local branch: neither says the branch was pushed.
  const remoteBranch = /^refs\/heads\/(.+)$/.exec(await config('merge'))?.[1];
  if (!pushedTo || !remoteBranch) throw notPushed;
  // Tracking a branch of another name is fine (local fix -> origin/feature/fix), unless it is the base itself.
  const remoteHead = (await local.git(repo.root, ['symbolic-ref', '--short', '--quiet', `refs/remotes/${pushedTo.name}/HEAD`], { allowFailure: true })).stdout.trim();
  const base = input.base ?? remoteHead.slice(pushedTo.name.length + 1);
  if (remoteBranch !== branch && remoteBranch === base) throw notPushed;
  // gh opens the pull request from what is on the remote; commits not pushed yet would be missing from it.
  const upstreamRef = `refs/remotes/${pushedTo.name}/${remoteBranch}`;
  if ((await local.git(repo.root, ['rev-parse', '--verify', '--quiet', upstreamRef], { allowFailure: true })).stdout.trim()) {
    const ahead = Number((await local.git(repo.root, ['rev-list', '--count', `${upstreamRef}..HEAD`], { allowFailure: true })).stdout.trim() || 0);
    if (ahead > 0) throw new QuiverError('INVALID_INPUT', `${branch} has ${ahead} commit${ahead === 1 ? '' : 's'} not pushed to ${pushedTo.name}/${remoteBranch}. Push first, then create the pull request.`);
  }
  const headRepo = pickRemote([pushedTo], [repo.repo.host])?.repo;
  const head = headRepo && headRepo.owner.toLowerCase() !== repo.repo.owner.toLowerCase() ? `${headRepo.owner}:${remoteBranch}` : remoteBranch;
  const args = ['pr', 'create', '--repo', repo.arg, `--head=${head}`, `--title=${input.title}`, '--body-file', '-'];
  if (input.base) args.push(`--base=${input.base}`);
  if (input.draft) args.push('--draft');
  for (const label of input.labels) args.push(`--label=${label}`);
  const { stdout } = await gh(repo.root, args, { input: input.body, timeoutMs: NETWORK_TIMEOUT_MS });
  const number = numberFromUrl(stdout);
  const view = await gh(repo.root, ['pr', 'view', String(number), '--repo', repo.arg, '--json', GH_PR_FIELDS]);
  return parsePullRequest((parseGhJson(view.stdout) ?? {}) as Record<string, unknown>);
}

/** Add a comment to a pull request's conversation; gives back the comment's address. The body goes on stdin. */
export async function comment(cwd: string, number: number, body: string): Promise<{ url: string }> {
  const repo = await prRepo(cwd);
  const { stdout } = await gh(repo.root, ['pr', 'comment', String(number), '--repo', repo.arg, '--body-file', '-'], { input: body, timeoutMs: NETWORK_TIMEOUT_MS });
  return { url: stdout.trim().split(/\r?\n/).pop() ?? '' };
}
