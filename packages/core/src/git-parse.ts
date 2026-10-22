import type { GitBranch, GitCommit, GitDiffFile, GitFileChange, GitStash, GitStatus, GitTag, GitWorktree } from './models/git';

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
export const GIT_BRANCH_FORMAT = '%(refname)%00%(refname:short)%00%(HEAD)%00%(upstream:short)%00%(upstream:track)%00%(objectname)%00%(contents:subject)%00%(committerdate:iso-strict)%00%(worktreepath)';

export interface BranchMergeInfo {
  /** Full ref names (`refs/heads/x`) from `git for-each-ref --merged=<base>`. */
  merged: ReadonlySet<string>;
  /** The default branch's name without a remote (`main`), when there is one; it and its remote copies are never "merged". */
  defaultBranch?: string;
}

/**
 * `git for-each-ref --format=<GIT_BRANCH_FORMAT>`. Symbolic remote heads (`origin/HEAD`) are left out. `gone` comes
 * from the tracking info; `merged` from `info`, leaving out the branch merged into and the current one, which would
 * otherwise be offered for clean-up.
 */
export function parseBranches(out: string, info: BranchMergeInfo = { merged: new Set() }): GitBranch[] {
  const branches: GitBranch[] = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [refname, name, head, upstream, track, objectname, subject, date, worktreePath] = line.replace(/\r$/, '').split('\0');
    const remote = refname.startsWith('refs/remotes/');
    if (remote && refname.endsWith('/HEAD')) continue;
    if (!remote && !refname.startsWith('refs/heads/')) continue;
    const ahead = /ahead (\d+)/.exec(track ?? '');
    const behind = /behind (\d+)/.exec(track ?? '');
    const isDefault = info.defaultBranch !== undefined && (remote ? name.slice(name.indexOf('/') + 1) === info.defaultBranch : name === info.defaultBranch);
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
      merged: info.merged.has(refname) && head !== '*' && !isDefault,
      gone: track === '[gone]',
      // The current branch is checked out here; only another worktree's is worth naming.
      ...(worktreePath && head !== '*' && !remote ? { worktreePath } : {}),
    });
  }
  return branches;
}

/** The `--format` that `parseTags` reads, for `git for-each-ref refs/tags`. `*objectname` is the commit an annotated tag points at. */
export const GIT_TAG_FORMAT = '%(refname:strip=2)%00%(objecttype)%00%(objectname)%00%(*objectname)%00%(contents:subject)%00%(creatordate:iso-strict)';

/** `git for-each-ref --format=<GIT_TAG_FORMAT> refs/tags`. */
export function parseTags(out: string): GitTag[] {
  const tags: GitTag[] = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [name, type, objectname, peeled, subject, date] = line.replace(/\r$/, '').split('\0');
    if (!name) continue;
    const annotated = type === 'tag';
    tags.push({ name, commit: annotated && peeled ? peeled : objectname, annotated, subject: subject ?? '', date: date ?? '' });
  }
  return tags;
}

/** The `--format` that `parseStashes` reads, for `git stash list`: one record per stash, each starting with a record separator. */
export const GIT_STASH_FORMAT = '%x1e%gd%x00%H%x00%gs%x00%cI';

/** `git stash list --format=<GIT_STASH_FORMAT>`. The reflog subject is "On <branch>: <message>", or "WIP on <branch>: <commit>" when no message was given. */
export function parseStashes(out: string): GitStash[] {
  const stashes: GitStash[] = [];
  for (const record of out.split('\x1e')) {
    if (!record.trim()) continue;
    const [selector, hash, subject = '', date = ''] = record.replace(/\r?\n$/, '').split('\0');
    const index = /@\{(\d+)\}$/.exec(selector ?? '');
    if (!index || !hash) continue;
    const m = /^(WIP on|On) (.+?): (.*)$/s.exec(subject);
    const branch = m && m[2] !== '(no branch)' ? m[2] : undefined;
    const message = m ? (m[1] === 'WIP on' ? `WIP ${m[3]}` : m[3]) : subject;
    stashes.push({ index: Number(index[1]), hash, message, ...(branch ? { branch } : {}), date: date.trim() });
  }
  return stashes;
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

/** Unmerged entries: git's XY pairs for a conflict (UU, AA, DD, AU, UA, DU, UD). */
export function isUnmerged(f: Pick<GitFileChange, 'index' | 'worktree'>): boolean {
  return f.index === 'U' || f.worktree === 'U' || (f.index === 'A' && f.worktree === 'A') || (f.index === 'D' && f.worktree === 'D');
}

/** The paths of a status left with conflicts. */
export function conflictedPaths(files: GitFileChange[]): string[] {
  return files.filter(isUnmerged).map((f) => f.path);
}

export type GitOperation = NonNullable<GitStatus['operation']>;
export type GitOperationAction = 'continue' | 'abort' | 'skip';

/** The git command line that continues, aborts or skips the operation in progress; null for a merge's skip, which git has not got. */
export function operationArgs(operation: GitOperation, action: GitOperationAction): string[] | null {
  if (operation === 'merge' && action === 'skip') return null;
  return [operation, `--${action}`];
}

/**
 * Which of the paths to discard go to `git restore` and which to `git clean`: only a path the status lists as
 * untracked is deleted (with `-d` for a folder entry, `new/`); every other path is restored, which never deletes a
 * file git does not track. With `staged` (back to HEAD), a staged rename's old path is restored too: the new path
 * alone would go, and the old one stay deleted.
 */
export function planDiscard(files: GitFileChange[], paths: string[], staged = false): { restore: string[]; clean: string[]; cleanDirs: boolean } {
  const untracked = new Set(files.filter((f) => f.index === '?').map((f) => f.path));
  const clean = paths.filter((p) => untracked.has(p));
  const restore = paths.filter((p) => !untracked.has(p));
  if (staged) {
    for (const f of files) if (f.origPath && restore.includes(f.path) && !restore.includes(f.origPath)) restore.push(f.origPath);
  }
  return { restore, clean, cleanDirs: clean.some((p) => p.endsWith('/')) };
}

/**
 * The operation in progress, from the marker files git leaves in its directory. A cherry-pick or revert of several
 * commits keeps `sequencer/` until the last one, also after the one it stopped on was committed by hand, which
 * removes CHERRY_PICK_HEAD; its todo list (`read`) says which of the two it is.
 */
export function detectOperation(present: (name: string) => boolean, read?: (name: string) => string): GitStatus['operation'] {
  if (present('rebase-merge') || present('rebase-apply')) return 'rebase';
  if (present('MERGE_HEAD')) return 'merge';
  if (present('CHERRY_PICK_HEAD')) return 'cherry-pick';
  if (present('REVERT_HEAD')) return 'revert';
  if (present('sequencer')) {
    let todo = '';
    try {
      todo = read?.('sequencer/todo') ?? '';
    } catch {
      // Gone between the two looks: the operation just finished.
      return undefined;
    }
    return /^\s*(revert|r)\s/m.test(todo) && !/^\s*(pick|p)\s/m.test(todo) ? 'revert' : 'cherry-pick';
  }
  return undefined;
}

// ---------- worktrees ----------

/**
 * A folder as a key to compare: forward slashes, no trailing slash, and lower case for a Windows path (a drive letter
 * or a UNC path), where `C:\Repo` and `c:/repo` are one folder. Git prints forward slashes on Windows too.
 */
export function worktreePathKey(p: string): string {
  let key = p.replace(/\\/g, '/');
  if (key.length > 1) key = key.replace(/\/+$/, '');
  return /^[a-zA-Z]:/.test(key) || key.startsWith('//') ? key.toLowerCase() : key;
}

export function sameWorktreePath(a: string, b: string): boolean {
  return worktreePathKey(a) === worktreePathKey(b);
}

/** True when `child` is `parent` or a folder somewhere inside it. */
export function isSameOrInside(child: string, parent: string): boolean {
  const c = worktreePathKey(child);
  const p = worktreePathKey(parent);
  return c === p || c.startsWith(p.endsWith('/') ? p : `${p}/`);
}

/**
 * `git worktree list --porcelain -z`: one record per worktree, its attributes NUL-terminated and the record ended by
 * an empty one. The main worktree comes first; `currentPath`, the top of the worktree the workspace is in, marks
 * `current`. Before the first commit HEAD is all zeros, given as null.
 */
export function parseWorktreeList(out: string, currentPath?: string): GitWorktree[] {
  const list: Omit<GitWorktree, 'main' | 'current'>[] = [];
  let wt: Omit<GitWorktree, 'main' | 'current'> | null = null;
  for (const token of out.split('\0')) {
    if (!token.trim()) {
      if (wt) list.push(wt);
      wt = null;
      continue;
    }
    const space = token.indexOf(' ');
    const key = space < 0 ? token : token.slice(0, space);
    const value = space < 0 ? '' : token.slice(space + 1);
    if (key === 'worktree') {
      if (wt) list.push(wt);
      wt = { path: value, head: null, branch: null, detached: false, bare: false, locked: false, prunable: false };
      continue;
    }
    if (!wt) continue;
    if (key === 'HEAD') wt.head = /^0+$/.test(value) ? null : value;
    else if (key === 'branch') wt.branch = value.replace(/^refs\/heads\//, '');
    else if (key === 'detached') wt.detached = true;
    else if (key === 'bare') wt.bare = true;
    else if (key === 'locked') {
      wt.locked = true;
      if (value) wt.lockReason = value;
    } else if (key === 'prunable') {
      wt.prunable = true;
      if (value) wt.prunableReason = value;
    }
  }
  if (wt) list.push(wt);
  return list.map((w, i) => ({ ...w, main: i === 0, current: currentPath !== undefined && sameWorktreePath(w.path, currentPath) }));
}

/** A branch name as one folder name: `/` and the characters Windows refuses in a file name become `-`. */
export function worktreeFolderName(branch: string): string {
  return branch.replace(/[\\/<>:"|?*\x00-\x1f]+/g, '-').replace(/^-+|-+$/g, '') || 'worktree';
}

/**
 * Where a new worktree goes by default: `<folder holding the main worktree>/<its name>.worktrees/<branch, / as ->`,
 * so worktrees sit together beside the repository rather than inside it. Written with the main path's separator.
 */
export function defaultWorktreePath(mainPath: string, branch: string): string {
  const sep = mainPath.includes('\\') ? '\\' : '/';
  const trimmed = mainPath.length > 1 ? mainPath.replace(/[\\/]+$/, '') : mainPath;
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  const parent = cut >= 0 ? trimmed.slice(0, cut) : '.';
  return [parent, `${trimmed.slice(cut + 1)}.worktrees`, worktreeFolderName(branch)].join(sep);
}

/**
 * The branch and worktree in git's refusal to check out or delete a branch checked out in another worktree:
 * "'x' is already checked out at '<path>'" (newer git: "is already used by worktree at"), and "cannot delete branch
 * 'x' used by worktree at '<path>'" (older git: "checked out at"). Null for any other message.
 */
export function worktreeRefusal(message: string): { branch: string; path: string } | null {
  const m = /'([^']+)' is already (?:checked out|used by worktree) at '([^']+)'/.exec(message) ?? /branch '([^']+)' (?:used by worktree|checked out) at '([^']+)'/i.exec(message);
  return m ? { branch: m[1], path: m[2] } : null;
}
