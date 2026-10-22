import { isUnmerged, shortRelativeTime, type GitBranch, type GitCommit, type GitDiffFile, type GitFileChange, type GitPrCheckState, type GitPullRequest, type GitStash, type GitStatus, type GitTag } from '@quiver/core';
import type { CodeLanguage } from '@quiver/ui';
import type { GitBlame, GitBlameCommit } from '@quiver/core';
import type { LineMarker } from '@quiver/ui';

// What the Git panel shows, worked out from what the host commands give back. No Angular here.

/** `git.log`'s page. */
export interface GitLogPage {
  commits: GitCommit[];
  hasMore: boolean;
}

/** `git.show`: one commit and its changes against its first parent. */
export interface GitShowResult {
  commit: GitCommit;
  files: GitDiffFile[];
}

/** What fetch, pull and push give back. */
export interface GitRemoteResult {
  output: string;
  status: GitStatus;
}

/** `git.stash.show`: one stash and its changes. */
export interface GitStashShowResult {
  stash: GitStash;
  files: GitDiffFile[];
}

/** Where a diff tab's files come from. */
export type DiffSource =
  | { kind: 'working'; path?: string }
  | { kind: 'staged'; path?: string }
  | { kind: 'commit'; ref: string; path?: string }
  /** Two refs: how `to` differs from `from`, as `git diff from to` (both ways, not only what `to` added). */
  | { kind: 'compare'; from: string; to: string; path?: string }
  /** A stash by its index, with its hash so a tab whose stash has gone (or moved up) says so. */
  | { kind: 'stash'; index: number; hash: string; path?: string };

/** Where the old side of a diff's files is read from, so the merge view can show whole files: a ref, or the index. */
export type DiffBase = { ref: string } | { index: true };

/** Unmerged entries: git's XY pairs for a conflict (UU, AA, DD, AU, UA, DU, UD). */
export const isConflict: (f: GitFileChange) => boolean = isUnmerged;

export interface GroupedChanges {
  conflicts: GitFileChange[];
  staged: GitFileChange[];
  unstaged: GitFileChange[];
  untracked: GitFileChange[];
}

/** The changed files as the sidebar lists them. A file with staged and unstaged edits is in both groups. */
export function groupChanges(files: GitFileChange[]): GroupedChanges {
  const groups: GroupedChanges = { conflicts: [], staged: [], unstaged: [], untracked: [] };
  for (const f of files) {
    if (f.index === '?') groups.untracked.push(f);
    else if (isConflict(f)) groups.conflicts.push(f);
    else {
      if (f.index !== '.') groups.staged.push(f);
      if (f.worktree !== '.') groups.unstaged.push(f);
    }
  }
  const byPath = (a: GitFileChange, b: GitFileChange) => a.path.localeCompare(b.path);
  for (const list of Object.values(groups)) list.sort(byPath);
  return groups;
}

const CODE_WORD: Record<string, string> = { M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', C: 'Copied', T: 'Type changed', U: 'Unmerged', '?': 'Untracked' };

export function codeWord(code: string): string {
  return CODE_WORD[code] ?? code;
}

/** The colour of a status letter. */
export function codeClass(code: string): string {
  switch (code) {
    case 'A':
    case '?':
      return 'text-success';
    case 'D':
      return 'text-danger';
    case 'U':
      return 'text-warning';
    default:
      return 'text-accent';
  }
}

const STATUS_CODE: Record<GitDiffFile['status'], string> = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R', copied: 'C', 'type-changed': 'T' };

export function diffCode(f: Pick<GitDiffFile, 'status'>): string {
  return STATUS_CODE[f.status];
}

/** `src/app/main.ts` → `main.ts` and `src/app`. An untracked folder (`new/`) keeps its slash. */
export function splitPath(p: string): { name: string; dir: string } {
  const trimmed = p.endsWith('/') ? p.slice(0, -1) : p;
  const at = trimmed.lastIndexOf('/');
  return at < 0 ? { name: p, dir: '' } : { name: p.slice(at + 1), dir: trimmed.slice(0, at) };
}

/** "3m ago", "just now". */
export function ago(iso: string | undefined, now = Date.now()): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const short = shortRelativeTime(t - now);
  return short === 'now' ? 'just now' : `${short} ago`;
}

// ---- Patches ----

export type PatchRow =
  | { kind: 'hunk'; text: string }
  | { kind: 'context'; old: number; new: number; text: string }
  | { kind: 'del'; old: number; text: string }
  | { kind: 'add'; new: number; text: string }
  /** `\ No newline at end of file`. */
  | { kind: 'note'; text: string };

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;

/** A unified patch as rows, the file headers (`diff --git`, `index`, `---`, `+++`) left out. */
export function parsePatch(patch: string): PatchRow[] {
  const rows: PatchRow[] = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  const lines = patch.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  for (const raw of lines) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const hunk = HUNK.exec(line);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      inHunk = true;
      rows.push({ kind: 'hunk', text: line });
      continue;
    }
    if (!inHunk) continue;
    const mark = line[0];
    const text = line.slice(1);
    if (mark === '+') rows.push({ kind: 'add', new: newNo++, text });
    else if (mark === '-') rows.push({ kind: 'del', old: oldNo++, text });
    else if (mark === '\\') rows.push({ kind: 'note', text: line });
    else if (mark === ' ' || line === '') rows.push({ kind: 'context', old: oldNo++, new: newNo++, text });
    // Anything else ends the hunk: the next file's header in a patch that holds several.
    else inHunk = false;
  }
  return rows;
}

export interface SplitCell {
  no?: number;
  text: string;
  kind: 'context' | 'del' | 'add' | 'empty';
}

export type SplitRow = { kind: 'hunk'; text: string } | { kind: 'note'; text: string } | { kind: 'pair'; left: SplitCell; right: SplitCell };

/** Rows side by side: a run of deleted lines is paired with the added lines that follow it, line by line. */
export function splitRows(rows: PatchRow[]): SplitRow[] {
  const out: SplitRow[] = [];
  let dels: SplitCell[] = [];
  let adds: SplitCell[] = [];
  const flush = () => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) {
      out.push({ kind: 'pair', left: dels[i] ?? { text: '', kind: 'empty' }, right: adds[i] ?? { text: '', kind: 'empty' } });
    }
    dels = [];
    adds = [];
  };
  for (const row of rows) {
    if (row.kind === 'del') {
      if (adds.length) flush();
      dels.push({ no: row.old, text: row.text, kind: 'del' });
    } else if (row.kind === 'add') adds.push({ no: row.new, text: row.text, kind: 'add' });
    else {
      flush();
      if (row.kind === 'context') out.push({ kind: 'pair', left: { no: row.old, text: row.text, kind: 'context' }, right: { no: row.new, text: row.text, kind: 'context' } });
      else out.push(row);
    }
  }
  flush();
  return out;
}

/**
 * The new side of a file from its old side and its unified patch, or null when they do not fit (a context or deleted
 * line that is not in the old side, a combined diff of a conflict): a file is then drawn from its hunks rather than
 * shown wrong. Line endings stay as they are, `\r` included.
 */
export function applyPatch(old: string, patch: string): string | null {
  if (patch.startsWith('diff --cc ') || patch.startsWith('diff --combined ')) return null;
  const source = old === '' ? [] : old.split('\n');
  let endsWithNewline = old === '' || old.endsWith('\n');
  if (old.endsWith('\n')) source.pop();
  const lines = patch.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const out: string[] = [];
  let at = 0;
  let inHunk = false;
  let last: ' ' | '-' | '+' | null = null;
  for (const line of lines) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(line);
    if (hunk) {
      // `-n,0` is an insertion after line n; otherwise the hunk starts at line n.
      const start = hunk[2] === '0' ? Number(hunk[1]) : Number(hunk[1]) - 1;
      if (start < at || start > source.length) return null;
      out.push(...source.slice(at, start));
      at = start;
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    // An empty line is an empty context line whose leading space was trimmed, as parsePatch reads it.
    const mark = line === '' ? ' ' : line[0];
    const text = line.slice(1);
    if (mark === ' ' || mark === '-') {
      if (source[at] !== text) return null;
      at++;
      if (mark === ' ') out.push(text);
      last = mark;
    } else if (mark === '+') {
      out.push(text);
      last = mark;
    } else if (mark === '\\') {
      // `\ No newline at end of file` after an old-side line: the old file lacked it, so the new one ends with one
      // unless a marker after a new-side line says otherwise.
      endsWithNewline = last === '-';
    } else return null;
  }
  out.push(...source.slice(at));
  if (!out.length) return '';
  return out.join('\n') + (endsWithNewline ? '\n' : '');
}

const LANGUAGE: Record<string, CodeLanguage> = {
  json: 'json',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'javascript',
  mts: 'javascript',
  cts: 'javascript',
  tsx: 'javascript',
  html: 'html',
  htm: 'html',
  xml: 'xml',
  svg: 'xml',
  csproj: 'xml',
  sql: 'sql',
  graphql: 'graphql',
  gql: 'graphql',
};

/** The editor language for a file, by its extension; plain text when there is none for it. */
export function languageForPath(p: string): CodeLanguage {
  const name = splitPath(p).name.toLowerCase();
  const dot = name.lastIndexOf('.');
  return dot > 0 ? (LANGUAGE[name.slice(dot + 1)] ?? 'text') : 'text';
}

// ---- Branches and tags ----

/** A branch or tag matches the filter when its name, or its last commit's subject, holds the text (case aside). */
export function refMatches(ref: Pick<GitBranch | GitTag, 'name' | 'subject'>, filter: string): boolean {
  const text = filter.trim().toLowerCase();
  return !text || ref.name.toLowerCase().includes(text) || ref.subject.toLowerCase().includes(text);
}

/** The local branches "Clean up" offers: merged or gone, never the current one. */
export function cleanupCandidates(branches: GitBranch[]): GitBranch[] {
  return branches.filter((b) => !b.remote && !b.current && (b.merged || b.gone));
}

/** `origin/feature` as its remote and the branch's name there. The remote is the part before the first slash. */
export function splitRemoteBranch(name: string): { remote: string; branch: string } {
  const at = name.indexOf('/');
  return at < 0 ? { remote: name, branch: '' } : { remote: name.slice(0, at), branch: name.slice(at + 1) };
}

/**
 * Whether a push failed because the remote branch has commits this one lacks (after an amend or a rebase), which a
 * force push with lease can settle; any other failure (sign-in, network, a hook) is shown as it is.
 */
export function isPushRejected(message: string): boolean {
  return /non-fast-forward|fetch first|\[rejected\]/i.test(message);
}

/** The remotes the branches mention, for picking one to push a tag to. */
export function remotesOf(branches: GitBranch[]): string[] {
  return [...new Set(branches.filter((b) => b.remote).map((b) => splitRemoteBranch(b.name).remote))].sort();
}

// ---- Pull requests ----

export type PrFilter = 'all' | 'mine' | 'review-requested';

export function checkClass(state: GitPrCheckState | 'none'): string {
  switch (state) {
    case 'success':
      return 'text-success';
    case 'failure':
      return 'text-danger';
    case 'pending':
      return 'text-warning';
    default:
      return 'text-muted';
  }
}

/** The roll-up in a few characters: `✓ 3`, `✗ 1/4`, `● 2`. */
export function checksSummary(c: GitPullRequest['checks']): string {
  const total = c.passed + c.failed + c.pending;
  if (c.state === 'none' || !total) return '';
  if (c.state === 'failure') return `✗ ${c.failed}/${total}`;
  if (c.state === 'pending') return `● ${c.pending}/${total}`;
  return `✓ ${c.passed}`;
}

export const REVIEW_LABEL: Record<NonNullable<GitPullRequest['reviewDecision']>, string> = {
  approved: 'Approved',
  changes_requested: 'Changes requested',
  review_required: 'Review required',
};

export function reviewClass(decision: GitPullRequest['reviewDecision']): string {
  return decision === 'approved' ? 'text-success' : decision === 'changes_requested' ? 'text-danger' : 'text-muted';
}

export function prStateClass(pr: Pick<GitPullRequest, 'state' | 'draft'>): string {
  if (pr.state === 'merged') return 'text-accent';
  if (pr.state === 'closed') return 'text-danger';
  return pr.draft ? 'text-muted' : 'text-success';
}

export function prStateLabel(pr: Pick<GitPullRequest, 'state' | 'draft'>): string {
  if (pr.state === 'open') return pr.draft ? 'Draft' : 'Open';
  return pr.state === 'merged' ? 'Merged' : 'Closed';
}

/** A reason from `details.reason` of a command's error, when there is one. */
export function errorReason(error: { details?: unknown } | null | undefined): string | undefined {
  const details = error?.details;
  return details && typeof details === 'object' && 'reason' in details && typeof details.reason === 'string' ? details.reason : undefined;
}

// ---- Blame ----

/** What a blame tab shows: a file, at a ref or (without one) in the working tree. */
export interface BlameAt {
  path: string;
  ref?: string;
}

/** A blame tab's key: one tab per path and ref. */
export function blameKey(at: BlameAt): string {
  return `${at.path}@${at.ref ?? ''}`;
}

/** A ref as a tab or header shows it: a full hash cut to seven characters. */
export function shortRef(ref: string): string {
  return /^[0-9a-f]{40,64}$/.test(ref) ? ref.slice(0, 7) : ref;
}

export function blameTitle(at: BlameAt): string {
  return `${splitPath(at.path).name} (blame${at.ref ? ` @ ${shortRef(at.ref)}` : ''})`;
}

/**
 * The blamed file as the editor shows it, one editor line per blamed line. Git ends a line at a newline only, while
 * CodeMirror also breaks at a lone CR, which would push every marker below it off its line; such a CR is drawn as ␍.
 */
export function blameText(lines: readonly { text: string }[]): string {
  return lines.map((l) => l.text.replace(/\r/g, '␍')).join('\n');
}

/** Where "Blame before this commit" goes: the commit before it that held the lines, with the file's path there (renames followed); null when the file starts in it. */
export function blameBefore(commit: Pick<GitBlameCommit, 'previous'>): BlameAt | null {
  return commit.previous ? { path: commit.previous.path, ref: commit.previous.commit } : null;
}

/**
 * The blame gutter: one marker per line. The first line of each run of lines from one commit shows the short hash,
 * the author and how long ago, the rest of the run only the colour; the tooltip has the summary and the full date.
 * The colour goes from faint for the file's oldest commit to strong for its newest; lines not committed yet are in
 * the warning colour. `formatDate` is the full date in the tooltip.
 */
export function blameMarkers(blame: Pick<GitBlame, 'lines' | 'commits'>, now = Date.now(), formatDate: (iso: string) => string = (iso) => new Date(iso).toLocaleString()): LineMarker[] {
  const times = Object.values(blame.commits)
    .map((c) => Date.parse(c.authorTime))
    .filter((t) => !Number.isNaN(t));
  const oldest = Math.min(...times);
  const newest = Math.max(...times);
  const colour = (iso: string) => {
    const t = Date.parse(iso);
    const share = Number.isNaN(t) || newest <= oldest ? 1 : (t - oldest) / (newest - oldest);
    return `color-mix(in srgb, var(--accent) ${Math.round(20 + 70 * share)}%, transparent)`;
  };
  return blame.lines.map((l, i) => {
    const start = i === 0 || blame.lines[i - 1].commit !== l.commit;
    const c = l.commit ? blame.commits[l.commit] : undefined;
    if (!c) return { text: start ? 'Not committed yet' : '', title: 'Not committed yet: changed in the working tree\nClick to see the working changes', color: 'var(--warning)', start };
    const short = c.hash.slice(0, 7);
    const title = `${short} ${c.summary}\n${c.author} <${c.authorEmail}>\n${formatDate(c.authorTime)}${c.boundary ? '\nThe history stops here; the line may be older' : ''}\nClick to open the commit, right-click for more`;
    return { text: start ? `${short} ${c.author} · ${ago(c.authorTime, now)}` : '', title, color: colour(c.authorTime), start, id: c.hash };
  });
}
