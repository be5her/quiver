import { existsSync, watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import {
  GIT_BRANCH_FORMAT,
  GIT_LOG_FORMAT,
  QuiverError,
  attachPatches,
  detectOperation,
  parseBranches,
  parseDiffSummary,
  parseLog,
  parseStatusV2,
  splitPatch,
  type GitBranch,
  type GitCommit,
  type GitDiffFile,
  type GitStatus,
  type HostApi,
  type WorkspaceApi,
} from '@quiver/core';
import { runToEnd, whichSync, type RunToEndResult } from '@quiver/core/node';

// The git CLI, run in the workspace folder. Every call is a separate process with stdin closed and prompts turned
// off, so nothing waits on a terminal; output is parsed by @quiver/core's git-parse.

const READ_TIMEOUT_MS = 30_000;
const NETWORK_TIMEOUT_MS = 180_000;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
/** A single file's patch over this is left out and the file marked truncated. */
const MAX_PATCH_BYTES = 512 * 1024;
const WATCH_DEBOUNCE_MS = 250;

/** Settings for every call: no colour, paths unquoted, no optional locks so a status never fights the user's own git. */
const BASE_ARGS = ['-c', 'color.ui=false', '-c', 'core.quotepath=false'];
const ENV: Record<string, string> = { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_MERGE_AUTOEDIT: 'no' };
/**
 * For a network call an agent made: `GIT_TERMINAL_PROMPT=0` only stops terminal prompts, while Git Credential Manager
 * opens a window when it has nothing stored, which would leave the call hanging behind a dialog nobody asked for. A
 * call from the UI keeps the dialog, since that is how a first sign-in happens.
 */
const NON_INTERACTIVE_ENV: Record<string, string> = { GCM_INTERACTIVE: 'never' };

let gitPath: string | null = null;
/** When git was last looked for and not found. */
let gitMissedAt = 0;
/** How long a miss is remembered: the lookup walks PATH synchronously, and the status bar asks on every workspace switch. */
const GIT_MISS_MS = 10_000;

/**
 * The git program, or a clear error when it is not installed. Looked up again a few seconds after a miss, so
 * installing git needs no restart.
 */
function gitProgram(): string {
  if (!gitPath && Date.now() - gitMissedAt >= GIT_MISS_MS) {
    gitPath = whichSync('git');
    if (!gitPath) gitMissedAt = Date.now();
  }
  if (!gitPath) throw new QuiverError('NOT_FOUND', 'git was not found on PATH. Install git (https://git-scm.com) and try again.', { reason: 'no-git' });
  return gitPath;
}

interface GitRunOptions {
  input?: string;
  timeoutMs?: number;
  /** Give back a failed run instead of throwing, for callers that read the exit code. */
  allowFailure?: boolean;
  /** Added to the environment of this call. */
  env?: Record<string, string>;
}

/**
 * Run git in a folder. A non-zero exit throws with git's own message, unless `allowFailure`. Commands run in the
 * repository's root (`repoDirs().root`), so the paths git prints and the paths it is given mean the same thing.
 */
export async function git(cwd: string, args: string[], options: GitRunOptions = {}): Promise<RunToEndResult> {
  const result = await runToEnd(gitProgram(), [...BASE_ARGS, ...args], { cwd, env: { ...ENV, ...options.env }, input: options.input, timeoutMs: options.timeoutMs ?? READ_TIMEOUT_MS, maxBytes: MAX_OUTPUT_BYTES });
  if (result.error) {
    gitPath = null;
    throw new QuiverError('NOT_FOUND', `git could not be started: ${result.error}`, { reason: 'no-git' });
  }
  if (result.timedOut) throw new QuiverError('REQUEST_FAILED', `git ${args[0]} took longer than ${Math.round((options.timeoutMs ?? READ_TIMEOUT_MS) / 1000)}s and was stopped`);
  if (result.code !== 0 && !options.allowFailure) {
    const message = (result.stderr.trim() || result.stdout.trim() || `git ${args[0]} exited with code ${result.code}`).replace(/^(fatal|error): /, '');
    throw new QuiverError('REQUEST_FAILED', message, { exitCode: result.code });
  }
  return result;
}

interface RepoDirs {
  /** The folder holding HEAD and index; differs from `commonDir` in a linked worktree. */
  gitDir: string;
  /** The folder holding refs and packed-refs. */
  commonDir: string;
  /**
   * The top folder of the working tree, where every command runs. `status` and `diff` print paths relative to it
   * whatever the current folder, so `add`, `restore` and `log -- <path>` are run there too, and one path means the
   * same thing everywhere, also when the workspace is a subfolder of the repository.
   */
  root: string;
}

/** Where the repository keeps its files, or a clear error when the folder is not inside one. */
export async function repoDirs(cwd: string): Promise<RepoDirs> {
  const result = await git(cwd, ['rev-parse', '--absolute-git-dir', '--git-common-dir', '--show-toplevel'], { allowFailure: true });
  if (result.code !== 0) {
    const stderr = result.stderr.trim().replace(/^fatal: /, '');
    if (/not a git repository/i.test(stderr)) throw new QuiverError('NOT_FOUND', `${cwd} is not a git repository. Run git init there, or open the repository's folder.`, { reason: 'not-a-repo' });
    throw new QuiverError('REQUEST_FAILED', stderr || 'git rev-parse failed', { exitCode: result.code });
  }
  const [gitDir, common, top] = result.stdout.split(/\r?\n/);
  return { gitDir, commonDir: path.resolve(cwd, common || gitDir), root: top ? path.resolve(top) : cwd };
}

/** The repository root of a workspace folder, for commands that run git themselves. */
export async function repoRoot(cwd: string): Promise<string> {
  return (await repoDirs(cwd)).root;
}

/**
 * The repository's status. With `files: false` only the branch, HEAD, upstream and operation are wanted (the status
 * bar): `files` comes back empty, and git neither looks for untracked files nor goes into submodules, which is most
 * of what a status costs in a big repository.
 */
export async function status(cwd: string, options: { files?: boolean } = {}): Promise<GitStatus> {
  const dirs = await repoDirs(cwd);
  // Untracked folders are listed as one entry (`new/`), as git itself does: `all` would list every file of an
  // unignored node_modules on each status.
  const which = options.files === false ? ['--untracked-files=no', '--ignore-submodules=all'] : ['--untracked-files=normal'];
  const { stdout } = await git(dirs.root, ['status', '--porcelain=v2', '--branch', '-z', ...which]);
  const parsed = options.files === false ? { ...parseStatusV2(stdout), files: [] } : parseStatusV2(stdout);
  const operation = detectOperation((name) => existsSync(path.join(dirs.gitDir, name)));
  return operation ? { ...parsed, operation } : parsed;
}

export async function branches(cwd: string): Promise<GitBranch[]> {
  const root = await repoRoot(cwd);
  const { stdout } = await git(root, ['for-each-ref', `--format=${GIT_BRANCH_FORMAT}`, '--sort=-committerdate', 'refs/heads', 'refs/remotes']);
  return parseBranches(stdout);
}

export interface GitLogPage {
  commits: GitCommit[];
  /** True when there are older commits past this page. */
  hasMore: boolean;
}

export async function log(cwd: string, input: { ref?: string; path?: string; limit: number; skip: number }): Promise<GitLogPage> {
  const root = await repoRoot(cwd);
  // A branch with no commits yet has no history; git log would fail on it.
  if (!input.ref && (await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], { allowFailure: true })).code !== 0) return { commits: [], hasMore: false };
  // The `--` is always there, so a ref that is also a file name is not an ambiguous argument.
  const args = ['log', `--format=${GIT_LOG_FORMAT}`, `--skip=${input.skip}`, `--max-count=${input.limit + 1}`, input.ref ?? 'HEAD', '--'];
  if (input.path) args.push(input.path);
  const commits = parseLog((await git(root, args)).stdout);
  return { commits: commits.slice(0, input.limit), hasMore: commits.length > input.limit };
}

/** One commit; `root` is the repository root from `repoDirs`. */
export async function commitInfo(root: string, ref: string): Promise<GitCommit> {
  const [commit] = parseLog((await git(root, ['log', '-1', `--format=${GIT_LOG_FORMAT}`, ref, '--'])).stdout);
  if (!commit) throw new QuiverError('NOT_FOUND', `No commit ${ref}`);
  return commit;
}

/** The arguments after `git diff` for a comparison; paths go after `--`. */
function diffRange(input: { staged: boolean; from?: string; to?: string }): string[] {
  if (input.to && !input.from) throw new QuiverError('INVALID_INPUT', 'A diff with "to" needs "from" too');
  if (input.from && input.to) return [input.from, input.to];
  return [...(input.staged ? ['--cached'] : []), ...(input.from ? [input.from] : [])];
}

async function diffFiles(cwd: string, range: string[], filePath: string | undefined, statOnly: boolean): Promise<GitDiffFile[]> {
  const tail = filePath ? ['--', filePath] : ['--'];
  // `u` leaves out the unmerged records: a conflicted file would otherwise be listed twice (unmerged, then its working
  // change) against one combined patch, and the summary and the patch would no longer pair up.
  const common = ['--no-ext-diff', '--no-textconv', '-M', '--diff-filter=u'];
  const summary = parseDiffSummary((await git(cwd, ['diff', ...common, '--raw', '--numstat', '-z', ...range, ...tail])).stdout);
  if (statOnly || !summary.length) return summary;
  const patch = await git(cwd, ['diff', ...common, '--patch', ...range, ...tail]);
  return attachPatches(summary, splitPatch(patch.stdout), MAX_PATCH_BYTES, patch.truncated);
}

export async function diff(cwd: string, input: { staged: boolean; from?: string; to?: string; path?: string; statOnly: boolean }): Promise<GitDiffFile[]> {
  const range = diffRange(input);
  return diffFiles(await repoRoot(cwd), range, input.path, input.statOnly);
}

async function emptyTree(cwd: string): Promise<string> {
  return (await git(cwd, ['hash-object', '-t', 'tree', '--stdin'], { input: '' })).stdout.trim();
}

export interface GitShowResult {
  commit: GitCommit;
  /** Against the first parent; a root commit against the empty tree. */
  files: GitDiffFile[];
}

export async function show(cwd: string, ref: string, statOnly: boolean): Promise<GitShowResult> {
  const root = await repoRoot(cwd);
  const commit = await commitInfo(root, ref);
  const base = commit.parents[0] ?? (await emptyTree(root));
  return { commit, files: await diffFiles(root, [base, commit.hash], undefined, statOnly) };
}

/** What a command that talks to a remote printed; git writes its progress to stderr. */
export interface GitRemoteResult {
  output: string;
  status: GitStatus;
}

/**
 * The remote as one of the repository's configured remotes, or a clear error. Git also takes a URL or a folder here
 * (`git fetch https://…`, `git fetch ../other`), which would let a read-only fetch pull any repository the user's
 * credentials or disk can reach into FETCH_HEAD for `git.log` and `git.show` to read.
 */
export async function requireRemote(cwd: string, remote: string): Promise<string> {
  const names = (await git(cwd, ['remote'])).stdout.split(/\r?\n/).filter(Boolean);
  if (names.includes(remote)) return remote;
  throw new QuiverError('INVALID_INPUT', names.length ? `${remote} is not a remote of this repository (${names.join(', ')})` : `${remote} is not a remote of this repository, which has none`);
}

/**
 * A branch as a plain name, or a clear error. Git reads the branch argument of push and pull as a refspec, where
 * `:main` deletes the remote branch, `+x:main` forces it (past `forceWithLease`), `main:other` writes another local
 * ref and `^` or `*` select refs by pattern; none of that is what a "branch" input promises.
 */
export function requireBranchName(name: string): string {
  if (/[:^*\s]/.test(name) || name.startsWith('+')) throw new QuiverError('INVALID_INPUT', `${name} is not a branch name: give the branch alone, not a refspec`);
  return name;
}

/**
 * Run a fetch, pull or push; `remote`, when the caller named one, must be a configured remote (see `requireRemote`).
 * `interactive` false keeps credential helpers from opening a window (a call made by an agent).
 */
export async function remoteOp(cwd: string, args: string[], remote: string | undefined, interactive: boolean): Promise<GitRemoteResult> {
  const root = await repoRoot(cwd);
  if (remote !== undefined) await requireRemote(root, remote);
  const result = await git(root, args, { timeoutMs: NETWORK_TIMEOUT_MS, env: interactive ? undefined : NON_INTERACTIVE_ENV });
  return { output: [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n'), status: await status(root) };
}

// ---------- watcher ----------

const watchers = new Map<string, { close(): void }>();

/**
 * Watch the repository's HEAD, index and refs and emit `git.changed`, debounced: `status` when HEAD or the index
 * moved, `branches` when HEAD or a ref did. Edits to working files are not watched; the view refreshes those itself.
 * A folder that is not a repository (yet) gets no watcher; the next git command there tries again.
 */
export async function ensureWatcher(ws: WorkspaceApi, host: HostApi): Promise<void> {
  if (watchers.has(ws.id)) return;
  let dirs: RepoDirs;
  try {
    dirs = await repoDirs(ws.path);
  } catch {
    return;
  }
  if (watchers.has(ws.id)) return;
  const pending = new Set<'status' | 'branches'>();
  let timer: NodeJS.Timeout | undefined;
  const fire = (...reasons: ('status' | 'branches')[]) => {
    for (const r of reasons) pending.add(r);
    clearTimeout(timer);
    timer = setTimeout(() => {
      for (const reason of pending) host.emit('git.changed', { workspaceId: ws.id, reason });
      pending.clear();
    }, WATCH_DEBOUNCE_MS);
  };
  const open: FSWatcher[] = [];
  const add = (dir: string, recursive: boolean, onName: (name: string) => void) => {
    try {
      const w = watch(dir, { recursive, persistent: false }, (_event, name) => onName(String(name ?? '').replace(/\\/g, '/')));
      w.on('error', () => w.close());
      open.push(w);
    } catch {
      // A folder that cannot be watched (gone, or no permission) only loses the live refresh.
    }
  };
  add(dirs.gitDir, false, (name) => {
    if (name.endsWith('.lock')) return;
    if (name === 'HEAD' || name === 'MERGE_HEAD' || name === 'ORIG_HEAD') fire('status', 'branches');
    else if (name === 'index') fire('status');
    else if (name === 'packed-refs' && dirs.commonDir === dirs.gitDir) fire('branches');
  });
  if (dirs.commonDir !== dirs.gitDir) add(dirs.commonDir, false, (name) => name === 'packed-refs' && fire('branches'));
  add(path.join(dirs.commonDir, 'refs'), true, (name) => {
    if (!name.endsWith('.lock')) fire('branches');
  });
  watchers.set(ws.id, {
    close: () => {
      clearTimeout(timer);
      for (const w of open) w.close();
    },
  });
}

export function stopWatcher(workspaceId: string): void {
  watchers.get(workspaceId)?.close();
  watchers.delete(workspaceId);
}
