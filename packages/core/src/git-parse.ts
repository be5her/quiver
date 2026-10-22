import type { GitBranch, GitCommit, GitConflictKind, GitDiffFile, GitFileChange, GitStash, GitStatus, GitTag } from './models/git';

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
    const [refname, name, head, upstream, track, objectname, subject, date] = line.replace(/\r$/, '').split('\0');
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

// ---------- Conflicts ----------

const CONFLICT_KINDS: Record<string, GitConflictKind> = {
  UU: 'both-modified',
  AA: 'both-added',
  DD: 'both-deleted',
  AU: 'added-by-us',
  UA: 'added-by-them',
  DU: 'deleted-by-us',
  UD: 'deleted-by-them',
};

/** What a conflicted path is, from its status codes; null for a path that is not unmerged. */
export function conflictKind(f: Pick<GitFileChange, 'index' | 'worktree'>): GitConflictKind | null {
  return CONFLICT_KINDS[`${f.index}${f.worktree}`] ?? null;
}

/** One index entry of `git ls-files -u -z`: stage 1 is the common ancestor, 2 ours, 3 theirs. */
export interface UnmergedEntry {
  mode: string;
  object: string;
  stage: 1 | 2 | 3;
  path: string;
}

/** `git ls-files -u -z`: `<mode> <object> <stage>\t<path>` records, NUL-terminated. */
export function parseUnmergedEntries(out: string): UnmergedEntry[] {
  const entries: UnmergedEntry[] = [];
  for (const record of out.split('\0')) {
    const m = /^(\d+) ([0-9a-f]+) ([123])\t(.*)$/s.exec(record.replace(/^\n/, ''));
    if (m) entries.push({ mode: m[1], object: m[2], stage: Number(m[3]) as 1 | 2 | 3, path: m[4] });
  }
  return entries;
}

/** The other side of a merge as `.git/MERGE_MSG` names it ("Merge branch 'side'" → side); null when it names none. */
export function mergeMessageName(message: string): string | null {
  const m = /^Merge (?:remote-tracking branch|branch|tag|commit) '([^']+)'/.exec(message);
  return m ? m[1] : null;
}

/** What is known about the operation in progress, for `conflictLabels`. */
export interface ConflictLabelInfo {
  operation?: GitOperation;
  /** The current branch, or the short HEAD when it is detached (as it is during a rebase). */
  current: string;
  /** A merge's other side: the branch MERGE_MSG names, or the short MERGE_HEAD. */
  merging?: string;
  /** A rebase: the branch being rebased (`head-name`, without refs/heads/) and the branch or commit it goes onto. */
  rebasing?: string;
  onto?: string;
  /** The commit a cherry-pick, revert or rebase stopped on, as "<short hash> <subject>". */
  commit?: string;
}

/**
 * What ours and theirs stand for. A merge, cherry-pick and revert stop with the current branch checked out, so it is
 * ours and the commit coming in theirs. A rebase replays the branch's commits onto another one, so they swap: ours is
 * what it is rebased onto (with the commits replayed so far) and theirs the commit being replayed.
 */
export function conflictLabels(info: ConflictLabelInfo): { ours: string; theirs: string } {
  switch (info.operation) {
    case 'merge':
      return { ours: info.current, theirs: info.merging ?? 'MERGE_HEAD' };
    case 'rebase': {
      const replayed = info.commit ?? 'the commit being replayed';
      return { ours: info.onto ?? 'the upstream', theirs: info.rebasing ? `${replayed} (from ${info.rebasing})` : replayed };
    }
    case 'cherry-pick':
      return { ours: info.current, theirs: info.commit ?? 'the picked commit' };
    case 'revert':
      return { ours: info.current, theirs: info.commit ? `revert of ${info.commit}` : 'the revert' };
    default:
      // A stash apply leaves no operation: ours is the tree as it was, theirs the stash.
      return { ours: info.current, theirs: 'the incoming changes' };
  }
}

/** One conflict in a file, as git's markers lay it out. Offsets are into the text that was parsed. */
export interface ConflictRegion {
  /** 0-based, in the order of the file. */
  index: number;
  /** From the start of the `<<<<<<<` line to the end of the `>>>>>>>` line, its line break included. */
  from: number;
  to: number;
  /** The whole conflict as written, markers included. */
  raw: string;
  /** Each side's lines, with their line breaks. */
  ours: string;
  /** The common ancestor's lines, in the diff3 and zdiff3 styles (`|||||||`); null in the merge style. */
  base: string | null;
  theirs: string;
  /** What follows each marker: `<<<<<<< HEAD`, `||||||| merged common ancestors`, `>>>>>>> side`. */
  oursLabel: string;
  baseLabel: string | null;
  theirsLabel: string;
  /** Where each side's lines are, without the marker lines. */
  oursFrom: number;
  oursTo: number;
  baseFrom: number | null;
  baseTo: number | null;
  theirsFrom: number;
  theirsTo: number;
  /** The marker lines' line break, `\n` or `\r\n`, used when two sides are joined. */
  eol: string;
}

export type ConflictChunk = { kind: 'text'; text: string } | ({ kind: 'conflict' } & ConflictRegion);

const START_MARKER = /^<{7}(?: (.*))?$/;
const BASE_MARKER = /^\|{7}(?: (.*))?$/;
const SEPARATOR = /^={7}$/;
const END_MARKER = /^>{7}(?: (.*))?$/;

/**
 * A file's text split into plain stretches and conflicts, in order; joined back they give the text unchanged. Markers
 * are git's, of the default size: exactly seven characters at the start of a line, the start and end ones followed by
 * a space and a label or nothing, the separator alone. The `merge`, `diff3` and `zdiff3` styles are read (zdiff3 only
 * moves common lines out of the conflict). CRLF lines are kept as they are. Lines that only look like markers (eight
 * `<`, `=======` with text after it, a separator or end marker outside a conflict) are plain text, and so is a
 * conflict that is never closed; a start marker inside an open conflict starts a new one, the unclosed one staying text.
 */
export function parseConflictMarkers(text: string): ConflictChunk[] {
  const chunks: ConflictChunk[] = [];
  let plainFrom = 0;
  let offset = 0;
  let index = 0;
  type Open = {
    from: number;
    eol: string;
    oursLabel: string;
    oursFrom: number;
    oursTo: number;
    baseLabel: string | null;
    baseFrom: number | null;
    baseTo: number | null;
    theirsFrom: number;
    state: 'ours' | 'base' | 'theirs';
  };
  let open: Open | null = null;
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const at = offset;
    offset += line.length;
    const body = line.replace(/\r?\n$/, '');
    let m = START_MARKER.exec(body);
    if (m) {
      open = { from: at, eol: line.slice(body.length) || '\n', oursLabel: m[1] ?? '', oursFrom: offset, oursTo: offset, baseLabel: null, baseFrom: null, baseTo: null, theirsFrom: offset, state: 'ours' };
      continue;
    }
    if (!open) continue;
    if (open.state === 'ours' && (m = BASE_MARKER.exec(body))) {
      Object.assign(open, { oursTo: at, baseLabel: m[1] ?? '', baseFrom: offset, state: 'base' });
    } else if (open.state !== 'theirs' && SEPARATOR.test(body)) {
      if (open.state === 'ours') open.oursTo = at;
      else open.baseTo = at;
      Object.assign(open, { theirsFrom: offset, state: 'theirs' });
    } else if (open.state === 'theirs' && (m = END_MARKER.exec(body))) {
      if (open.from > plainFrom) chunks.push({ kind: 'text', text: text.slice(plainFrom, open.from) });
      const { from, eol, oursLabel, oursFrom, oursTo, baseLabel, baseFrom, baseTo, theirsFrom } = open;
      chunks.push({
        kind: 'conflict',
        index: index++,
        from,
        to: offset,
        raw: text.slice(from, offset),
        ours: text.slice(oursFrom, oursTo),
        base: baseFrom === null || baseTo === null ? null : text.slice(baseFrom, baseTo),
        theirs: text.slice(theirsFrom, at),
        oursLabel,
        baseLabel,
        theirsLabel: m[1] ?? '',
        oursFrom,
        oursTo,
        baseFrom,
        baseTo,
        theirsFrom,
        theirsTo: at,
        eol,
      });
      plainFrom = offset;
      open = null;
    }
  }
  if (plainFrom < text.length) chunks.push({ kind: 'text', text: text.slice(plainFrom) });
  return chunks;
}

/** The conflicts of a text, in order. */
export function conflictRegions(text: string): ConflictRegion[] {
  return parseConflictMarkers(text).filter((c): c is { kind: 'conflict' } & ConflictRegion => c.kind === 'conflict');
}

/**
 * How one conflict is resolved: one side, the base, both in either order, none of it, or text of one's own. Both
 * sides keep their order of lines; a side whose last line has no line break gets one before the other follows.
 */
export type ConflictChoice = 'ours' | 'theirs' | 'base' | 'ours-theirs' | 'theirs-ours' | 'none' | { text: string };

/** The text a conflict is replaced with for a choice. */
export function resolveConflict(region: ConflictRegion, choice: ConflictChoice): string {
  const join = (a: string, b: string) => (a && b && !a.endsWith('\n') ? a + region.eol + b : a + b);
  let text: string;
  if (typeof choice === 'object') text = choice.text;
  else if (choice === 'ours') text = region.ours;
  else if (choice === 'theirs') text = region.theirs;
  else if (choice === 'base') text = region.base ?? '';
  else if (choice === 'ours-theirs') text = join(region.ours, region.theirs);
  else if (choice === 'theirs-ours') text = join(region.theirs, region.ours);
  else text = '';
  // A conflict at the very end of a file with no final line break: the resolution has none either.
  return typeof choice !== 'object' && !region.raw.endsWith('\n') ? text.replace(/\r?\n$/, '') : text;
}

/** The text with the chosen conflicts resolved, by their index; a conflict with no choice keeps its markers. */
export function renderResolution(chunks: ConflictChunk[], choices: Readonly<Partial<Record<number, ConflictChoice>>>): string {
  return chunks
    .map((c) => {
      if (c.kind === 'text') return c.text;
      const choice = choices[c.index];
      return choice === undefined ? c.raw : resolveConflict(c, choice);
    })
    .join('');
}
