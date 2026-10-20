import type { GitDiffFile, GitPrCheck, GitPrCheckState, GitPullRequest, GitPullRequestDetail } from './models/git';
import { splitPatch } from './git-parse';

// Parsers for the GitHub CLI's --json output, its sign-in status, remote URLs and failed job logs. Pure functions
// with unit tests; `packages/modules/src/git/pr.ts` runs gh and hands them what it printed.

/** The `--json` fields of `gh pr list` and `gh pr view` that `parsePullRequest` reads. */
export const GH_PR_FIELDS = 'number,title,state,isDraft,author,headRefName,baseRefName,url,createdAt,updatedAt,reviewDecision,labels,statusCheckRollup';
/** The extra fields of `gh pr view` that `parsePullRequestDetail` reads. */
export const GH_PR_DETAIL_FIELDS = `${GH_PR_FIELDS},body,additions,deletions,files,reviews,comments`;
/** The `--json` fields of `gh pr checks` that `parseChecks` reads. */
export const GH_CHECK_FIELDS = 'name,state,bucket,link,startedAt,completedAt,workflow';

/** A failed check with the end of its job's log, from `git.pr.checks` with `failedLogs`. */
export interface GitPrCheckWithLog extends GitPrCheck {
  /** The last lines of the failed steps' log, step names as `## <step>` headings. */
  log?: string;
  /** Why the log could not be read, when it could not (a job still running, a check that is not an Actions job). */
  logError?: string;
}

type Json = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const arr = (v: unknown): Json[] => (Array.isArray(v) ? v.filter((x): x is Json => typeof x === 'object' && x !== null) : []);
const login = (v: unknown): string => (typeof v === 'object' && v !== null ? str((v as Json).login) : '') || 'ghost';
const optional = (v: unknown): string | undefined => str(v) || undefined;

// ---------- sign-in ----------

export interface GhAuth {
  authenticated: boolean;
  /** The active account on the host. */
  user?: string;
}

/**
 * `gh auth status --json hosts` (gh 2.60 and later), or the text older versions print, for one host. With several
 * accounts on a host, the active one is the user. The JSON never holds the token; the text is only read for its
 * "Logged in to <host> account <user>" (or older "as <user>") lines.
 */
export function parseAuthStatus(output: string, host: string): GhAuth {
  const trimmed = output.trim();
  if (trimmed.startsWith('{')) {
    try {
      const hosts = (JSON.parse(trimmed) as Json).hosts as Json | undefined;
      const accounts = arr(hosts?.[host]).filter((a) => a.state === 'success');
      const active = accounts.find((a) => a.active === true) ?? accounts[0];
      return active ? { authenticated: true, user: str(active.login) || undefined } : { authenticated: false };
    } catch {
      return { authenticated: false };
    }
  }
  const escaped = host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`Logged in to ${escaped}(?: account| as) (\\S+)[^\\n]*(?:\\n(?![^\\n]*Logged in to)[^\\n]*)*`, 'g');
  const blocks = [...output.replace(/\r\n/g, '\n').matchAll(re)];
  if (!blocks.length) return { authenticated: false };
  const active = blocks.find((b) => /Active account: true/.test(b[0])) ?? blocks[0];
  return { authenticated: true, user: active[1] };
}

// ---------- remotes ----------

export interface GitHubRepoRef {
  host: string;
  owner: string;
  name: string;
}

/**
 * The host, owner and name of a GitHub remote URL: `https://github.com/o/r(.git)`, `git@github.com:o/r.git`,
 * `ssh://git@github.com/o/r.git`, and `ssh.github.com` (SSH over port 443) as github.com. Null for anything else,
 * such as a local folder.
 */
export function parseRemoteRepo(url: string): GitHubRepoRef | null {
  const u = url.trim();
  let host: string;
  let repoPath: string;
  const scp = /^(?:[\w.-]+@)?([\w.-]+):(?!\/\/)(.+)$/.exec(u);
  if (/^(?:https?|ssh|git):\/\//i.test(u)) {
    try {
      const parsed = new URL(u);
      host = parsed.hostname;
      repoPath = parsed.pathname;
    } catch {
      return null;
    }
  } else if (scp && !/^[a-z]:[\\/]/i.test(u)) {
    host = scp[1];
    repoPath = scp[2];
  } else return null;
  const parts = repoPath
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.git$/, '')
    .split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  host = host.toLowerCase();
  if (host === 'ssh.github.com' || host === 'www.github.com') host = 'github.com';
  return { host, owner: parts[0], name: parts[1] };
}

/**
 * The remote whose repository pull requests belong to, as gh picks it: the one `gh repo set-default` marked
 * (`remote.<name>.gh-resolved`), then `upstream`, `github`, `origin`, then the first. Only remotes on one of
 * `hosts` count (github.com, plus any GitHub Enterprise host gh is signed in to).
 */
export function pickRemote(remotes: { name: string; url: string; resolved?: boolean }[], hosts: string[]): { remote: string; repo: GitHubRepoRef } | null {
  const candidates = remotes.flatMap((r) => {
    const repo = parseRemoteRepo(r.url);
    return repo && hosts.includes(repo.host) ? [{ ...r, repo }] : [];
  });
  const rank = (r: { name: string; resolved?: boolean }) => (r.resolved ? 0 : ['upstream', 'github', 'origin'].indexOf(r.name) + 1 || 4);
  const best = [...candidates].sort((a, b) => rank(a) - rank(b))[0];
  return best ? { remote: best.name, repo: best.repo } : null;
}

/** The `--repo` value gh takes: `owner/name` on github.com, `host/owner/name` elsewhere. */
export function repoArg(repo: GitHubRepoRef): string {
  return repo.host === 'github.com' ? `${repo.owner}/${repo.name}` : `${repo.host}/${repo.owner}/${repo.name}`;
}

// ---------- pull requests ----------

/** One `statusCheckRollup` entry: a CheckRun (Actions and apps) or a StatusContext (commit statuses). */
function rollupState(item: Json): GitPrCheckState {
  if (item.__typename === 'StatusContext' || ('context' in item && !('conclusion' in item))) {
    const state = str(item.state).toUpperCase();
    if (state === 'SUCCESS') return 'success';
    if (state === 'FAILURE' || state === 'ERROR') return 'failure';
    return 'pending';
  }
  if (str(item.status).toUpperCase() !== 'COMPLETED') return 'pending';
  return conclusionState(str(item.conclusion));
}

function conclusionState(conclusion: string): GitPrCheckState {
  switch (conclusion.toUpperCase()) {
    case 'SUCCESS':
      return 'success';
    case 'NEUTRAL':
      return 'neutral';
    case 'SKIPPED':
      return 'skipped';
    case '':
      return 'pending';
    default:
      // FAILURE, CANCELLED, TIMED_OUT, ACTION_REQUIRED, STARTUP_FAILURE, STALE: GitHub's roll-up counts them as failing.
      return 'failure';
  }
}

/** Count the checks; the overall state is failure when any failed, else pending when any is running, else success. */
export function rollupChecks(states: GitPrCheckState[]): GitPullRequest['checks'] {
  const passed = states.filter((s) => s === 'success').length;
  const failed = states.filter((s) => s === 'failure').length;
  const pending = states.filter((s) => s === 'pending').length;
  const state: GitPullRequest['checks']['state'] = !states.length ? 'none' : failed ? 'failure' : pending ? 'pending' : passed ? 'success' : states[0];
  return { state, passed, failed, pending };
}

const REVIEW_DECISIONS: Record<string, GitPullRequest['reviewDecision']> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes_requested',
  REVIEW_REQUIRED: 'review_required',
};

/** One pull request from `gh pr list` or `gh pr view` with `GH_PR_FIELDS`. */
export function parsePullRequest(raw: Json): GitPullRequest {
  const state = str(raw.state).toUpperCase();
  const reviewDecision = REVIEW_DECISIONS[str(raw.reviewDecision).toUpperCase()];
  return {
    number: num(raw.number),
    title: str(raw.title),
    state: state === 'MERGED' ? 'merged' : state === 'CLOSED' ? 'closed' : 'open',
    draft: raw.isDraft === true,
    author: login(raw.author),
    headRefName: str(raw.headRefName),
    baseRefName: str(raw.baseRefName),
    url: str(raw.url),
    createdAt: str(raw.createdAt),
    updatedAt: str(raw.updatedAt),
    ...(reviewDecision ? { reviewDecision } : {}),
    labels: arr(raw.labels).map((l) => str(l.name)).filter(Boolean),
    checks: rollupChecks(arr(raw.statusCheckRollup).map(rollupState)),
  };
}

/** Parse gh's JSON output; a clear error rather than a SyntaxError when gh printed something else. */
export function parseGhJson(out: string): unknown {
  try {
    return JSON.parse(out.replace(/^\uFEFF/, ''));
  } catch {
    throw new Error(`gh printed something other than JSON: ${out.trim().slice(0, 200) || '(nothing)'}`);
  }
}

export function parsePullRequestList(out: string): GitPullRequest[] {
  const list = parseGhJson(out);
  return arr(list).map(parsePullRequest);
}

/** `gh pr view <n> --json GH_PR_DETAIL_FIELDS`. */
export function parsePullRequestDetail(out: string): GitPullRequestDetail {
  const raw = (parseGhJson(out) ?? {}) as Json;
  return {
    ...parsePullRequest(raw),
    body: str(raw.body),
    additions: num(raw.additions),
    deletions: num(raw.deletions),
    files: arr(raw.files).map((f) => ({ path: str(f.path), additions: num(f.additions), deletions: num(f.deletions) })),
    reviews: arr(raw.reviews).map((r) => ({ author: login(r.author), state: str(r.state), submittedAt: str(r.submittedAt), body: str(r.body) })),
    comments: arr(raw.comments).map((c) => ({ author: login(c.author), createdAt: str(c.createdAt), body: str(c.body) })),
  };
}

const BUCKETS: Record<string, GitPrCheckState> = { pass: 'success', fail: 'failure', pending: 'pending', skipping: 'skipped', cancel: 'failure' };

/** `gh pr checks <n> --json GH_CHECK_FIELDS`. gh's `bucket` already sorts each check's state into pass, fail, pending, skipping or cancel. */
export function parseChecks(out: string): GitPrCheck[] {
  return arr(parseGhJson(out)).map((c) => {
    const bucket = BUCKETS[str(c.bucket)];
    const state = bucket ?? (str(c.state).toUpperCase() === 'NEUTRAL' ? 'neutral' : conclusionState(str(c.state)));
    const completedAt = optional(c.completedAt);
    return {
      name: str(c.name),
      ...(optional(c.workflow) ? { workflow: str(c.workflow) } : {}),
      state,
      ...(optional(c.link) ? { url: str(c.link) } : {}),
      // An unstarted check has a zero time, 0001-01-01T00:00:00Z.
      ...(optional(c.startedAt) && !str(c.startedAt).startsWith('0001') ? { startedAt: str(c.startedAt) } : {}),
      ...(completedAt && !completedAt.startsWith('0001') ? { completedAt } : {}),
    };
  });
}

/** The Actions job id in a check's link (`…/actions/runs/<run>/job/<job>`), for `gh run view --job <job> --log-failed`. */
export function jobIdFromCheckUrl(url: string | undefined): string | null {
  return /\/actions\/runs\/\d+\/job(?:s)?\/(\d+)/.exec(url ?? '')?.[1] ?? null;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const TIMESTAMP = /^\uFEFF?\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z ?/;

/**
 * The last `maxLines` lines of `gh run view --log-failed`, whose lines are `<job>\t<step>\t<timestamp> <text>`:
 * colours, timestamps and the job column are dropped, and each step starts with a `## <step>` heading. Lines past
 * `maxChars` are cut so one minified line cannot fill the excerpt.
 */
export function failedLogExcerpt(log: string, maxLines = 60, maxChars = 400): string {
  const rows = log
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      const [, step, text] = /^[^\t]*\t([^\t]*)\t(.*)$/.exec(line) ?? [null, '', line];
      return { step, text: text.replace(ANSI, '').replace(TIMESTAMP, '').replace(/^##\[(?:group|endgroup)\]/, '') };
    });
  while (rows.length && !rows[rows.length - 1].text.trim()) rows.pop();
  const tail = rows.slice(-maxLines);
  const out: string[] = [];
  let step: string | null = null;
  for (const row of tail) {
    if (row.step !== step) {
      step = row.step;
      if (step) out.push(`## ${step}`);
    }
    out.push(row.text.length > maxChars ? `${row.text.slice(0, maxChars)}…` : row.text);
  }
  return out.join('\n');
}

// ---------- diffs ----------

function unquotePath(p: string): string {
  if (!p.startsWith('"')) return p;
  try {
    return JSON.parse(p.replace(/\\([0-7]{3})/g, (_m, o: string) => `\\u00${parseInt(o, 8).toString(16).padStart(2, '0')}`)) as string;
  } catch {
    return p.slice(1, -1);
  }
}

/** One file's chunk of a unified diff: its paths, status and line counts read from the headers and hunks. */
function patchFile(chunk: string): GitDiffFile {
  const lines = chunk.split(/\r?\n/);
  const head = /^diff --git (?:"?a\/(.+?)"?) (?:"?b\/(.+?)"?)$/.exec(lines[0]) ?? [];
  let path = unquotePath(head[2] ?? '');
  let origPath: string | undefined;
  let status: GitDiffFile['status'] = 'modified';
  let additions = 0;
  let deletions = 0;
  let binary = false;
  let inHunk = false;
  for (const line of lines.slice(1)) {
    if (inHunk) {
      if (line.startsWith('+')) additions++;
      else if (line.startsWith('-')) deletions++;
      continue;
    }
    if (line.startsWith('@@')) inHunk = true;
    else if (line.startsWith('new file mode')) status = 'added';
    else if (line.startsWith('deleted file mode')) status = 'deleted';
    else if (line.startsWith('rename from ')) {
      status = 'renamed';
      origPath = unquotePath(line.slice('rename from '.length));
    } else if (line.startsWith('rename to ')) path = unquotePath(line.slice('rename to '.length));
    else if (line.startsWith('copy from ')) {
      status = 'copied';
      origPath = unquotePath(line.slice('copy from '.length));
    } else if (line.startsWith('copy to ')) path = unquotePath(line.slice('copy to '.length));
    else if (line.startsWith('Binary files') || line === 'GIT binary patch') binary = true;
    else if (line.startsWith('+++ ') && !line.startsWith('+++ /dev/null')) path = unquotePath(line.slice(4).replace(/^"?b\//, '').replace(/"$/, '')) || path;
  }
  return { path, ...(origPath ? { origPath } : {}), status, additions, deletions, binary };
}

/**
 * A pull request's unified diff (`gh pr diff`) as per-file entries with their patches. A patch over `maxPatchBytes`
 * is left out and the file marked `truncated`; with `cutShort` (the output hit its cap) the last file is too.
 */
export function parsePatchFiles(patch: string, maxPatchBytes: number, cutShort = false): GitDiffFile[] {
  const chunks = splitPatch(patch);
  return chunks.map((chunk, i) => {
    const file = patchFile(chunk);
    if (file.binary) return file;
    if ((cutShort && i === chunks.length - 1) || chunk.length > maxPatchBytes) return { ...file, truncated: true };
    return { ...file, patch: chunk };
  });
}
