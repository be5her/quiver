import type { GitBranch, GitCommit, GitDiffFile, GitFileChange, GitStatus } from './models/git';

// Parsers for the git CLI's output, pure functions with unit tests. The commands in the git module ask git for
// NUL-separated output (`-z`, `%x00`), so paths with spaces, quotes or newlines come through unquoted and intact.

/** `git status --porcelain=v2 --branch -z`. The operation in progress is not in this output; the caller adds it. */
export function parseStatusV2(out: string): GitStatus {
  const status: GitStatus = { branch: null, head: null, ahead: 0, behind: 0, files: [] };
  const entries = out.split('\0');
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;
    if (entry.startsWith('# ')) {
      const [key, ...rest] = entry.slice(2).split(' ');
      const value = rest.join(' ');
      if (key === 'branch.oid') status.head = value === '(initial)' ? null : value;
      else if (key === 'branch.head') status.branch = value === '(detached)' ? null : value;
      else if (key === 'branch.upstream') status.upstream = value;
      else if (key === 'branch.ab') {
        const m = /^\+(\d+) -(\d+)$/.exec(value);
        if (m) {
          status.ahead = Number(m[1]);
          status.behind = Number(m[2]);
        }
      }
      continue;
    }
    const kind = entry[0];
    if (kind === '?') {
      status.files.push({ path: entry.slice(2), index: '?', worktree: '?' });
      continue;
    }
    if (kind === '!') continue;
    // 1 XY sub mH mI mW hH hI path / 2 XY sub mH mI mW hH hI Xscore path\0origPath / u XY sub m1 m2 m3 mW h1 h2 h3 path
    const fieldsBeforePath = kind === '1' ? 8 : kind === '2' ? 9 : kind === 'u' ? 10 : -1;
    if (fieldsBeforePath < 0) continue;
    const parts = entry.split(' ');
    const xy = parts[1] ?? '..';
    const change: GitFileChange = { path: parts.slice(fieldsBeforePath).join(' '), index: xy[0], worktree: xy[1] };
    if (kind === '2') change.origPath = entries[++i];
    status.files.push(change);
  }
  return status;
}

/** The `--format` that `parseLog` reads: one record per commit, each starting with a record separator. */
export const GIT_LOG_FORMAT = '%x1e%H%x00%h%x00%P%x00%an%x00%ae%x00%aI%x00%s%x00%b%x00%D';

/** `git log --format=<GIT_LOG_FORMAT>`. */
export function parseLog(out: string): GitCommit[] {
  const commits: GitCommit[] = [];
  for (const record of out.split('\x1e')) {
    if (!record.trim()) continue;
    const [hash, shortHash, parents, author, email, date, subject, body, decorations] = record.split('\0');
    if (!hash) continue;
    commits.push({
      hash: hash.trim(),
      shortHash,
      parents: parents ? parents.split(' ').filter(Boolean) : [],
      author,
      email,
      date,
      subject,
      body: (body ?? '').trim(),
      refs: parseDecorations(decorations ?? ''),
    });
  }
  return commits;
}

/** `%D`: "HEAD -> main, origin/main, tag: v1" into ["main", "origin/main", "v1"]. A bare detached HEAD is left out. */
export function parseDecorations(d: string): string[] {
  return d
    .trim()
    .split(', ')
    .map((r) => r.replace(/^HEAD -> /, '').replace(/^tag: /, ''))
    .filter((r) => r && r !== 'HEAD');
}

/** The `--format` that `parseBranches` reads, for `git for-each-ref refs/heads refs/remotes`. */
export const GIT_BRANCH_FORMAT = '%(refname)%00%(refname:short)%00%(HEAD)%00%(upstream:short)%00%(upstream:track)%00%(objectname)%00%(contents:subject)%00%(committerdate:iso-strict)';

/** `git for-each-ref --format=<GIT_BRANCH_FORMAT>`. Symbolic remote heads (`origin/HEAD`) are left out. */
export function parseBranches(out: string): GitBranch[] {
  const branches: GitBranch[] = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [refname, name, head, upstream, track, objectname, subject, date] = line.replace(/\r$/, '').split('\0');
    const remote = refname.startsWith('refs/remotes/');
    if (remote && refname.endsWith('/HEAD')) continue;
    if (!remote && !refname.startsWith('refs/heads/')) continue;
    const ahead = /ahead (\d+)/.exec(track ?? '');
    const behind = /behind (\d+)/.exec(track ?? '');
    branches.push({
      name,
      current: head === '*',
      remote,
      ...(upstream ? { upstream } : {}),
      ahead: ahead ? Number(ahead[1]) : 0,
      behind: behind ? Number(behind[1]) : 0,
      head: objectname,
      subject: subject ?? '',
      date: date ?? '',
    });
  }
  return branches;
}

const DIFF_STATUS: Record<string, GitDiffFile['status']> = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'copied', T: 'type-changed' };

/**
 * `git diff --raw --numstat -z` (or `diff-tree`): the raw records name each file and its status, the numstat records
 * that follow give the line counts in the same order. Binary files have `-` counts.
 */
export function parseDiffSummary(out: string): GitDiffFile[] {
  const tokens = out.split('\0');
  const files: GitDiffFile[] = [];
  const counts: { additions: number; deletions: number; binary: boolean }[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i].replace(/^\n/, '');
    if (!token) continue;
    if (token.startsWith(':')) {
      // :100644 100644 <old> <new> R100, then the path, or the old and new paths for a rename or copy.
      const letter = token.split(' ')[4]?.[0] ?? 'M';
      const status = DIFF_STATUS[letter] ?? 'modified';
      if (letter === 'R' || letter === 'C') {
        const origPath = tokens[++i];
        files.push({ path: tokens[++i], origPath, status, additions: 0, deletions: 0, binary: false });
      } else files.push({ path: tokens[++i], status, additions: 0, deletions: 0, binary: false });
      continue;
    }
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(token);
    if (!m) continue;
    // A rename's numstat has an empty path and the two paths in the next tokens.
    if (m[3] === '') i += 2;
    const binary = m[1] === '-' && m[2] === '-';
    counts.push({ additions: binary ? 0 : Number(m[1]), deletions: binary ? 0 : Number(m[2]), binary });
  }
  return files.map((f, i) => ({ ...f, ...(counts[i] ?? {}) }));
}

/**
 * A whole `git diff` patch split into one chunk per file, each starting at its `diff --git` line (or `diff --cc` for
 * a file with merge conflicts, in its combined format), in git's order.
 */
export function splitPatch(patch: string): string[] {
  const chunks: string[] = [];
  let start = -1;
  const re = /^diff --(?:git|cc|combined) /gm;
  for (let m = re.exec(patch); m; m = re.exec(patch)) {
    if (start >= 0) chunks.push(patch.slice(start, m.index));
    start = m.index;
  }
  if (start >= 0) chunks.push(patch.slice(start));
  return chunks;
}

/**
 * Attach each file's patch from `splitPatch` to the summary, which lists the same files in the same order. A patch
 * over `maxPatchBytes` is left out and the file marked `truncated`; so is every file when the counts do not line up
 * (a patch cut short by the output limit), rather than pairing a file with another's patch.
 */
export function attachPatches(files: GitDiffFile[], chunks: string[], maxPatchBytes: number, patchCutShort = false): GitDiffFile[] {
  // The last chunk of a cut-short patch is incomplete; the ones before it are whole.
  const usable = patchCutShort ? chunks.length - 1 : chunks.length === files.length ? chunks.length : 0;
  return files.map((file, i) => {
    if (file.binary) return file;
    if (i >= usable || chunks[i].length > maxPatchBytes) return { ...file, truncated: true };
    return { ...file, patch: chunks[i] };
  });
}

/** The operation in progress, from the marker files git leaves in its directory. */
export function detectOperation(present: (name: string) => boolean): GitStatus['operation'] {
  if (present('rebase-merge') || present('rebase-apply')) return 'rebase';
  if (present('MERGE_HEAD')) return 'merge';
  if (present('CHERRY_PICK_HEAD')) return 'cherry-pick';
  if (present('REVERT_HEAD')) return 'revert';
  return undefined;
}
