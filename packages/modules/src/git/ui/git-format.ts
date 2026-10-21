import { shortRelativeTime, type GitCommit, type GitDiffFile, type GitFileChange, type GitPrCheckState, type GitPullRequest, type GitStatus } from '@quiver/core';

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

/** Where a diff tab's files come from. */
export type DiffSource =
  | { kind: 'working'; path?: string }
  | { kind: 'staged'; path?: string }
  | { kind: 'commit'; ref: string; path?: string };

/** Unmerged entries: git's XY pairs for a conflict (UU, AA, DD, AU, UA, DU, UD). */
export function isConflict(f: GitFileChange): boolean {
  return f.index === 'U' || f.worktree === 'U' || (f.index === 'A' && f.worktree === 'A') || (f.index === 'D' && f.worktree === 'D');
}

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
