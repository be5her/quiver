import { z } from 'zod';

// Git module contract: what the host commands take and give back. Local commands run the git CLI in the
// workspace folder; pull request commands run the GitHub CLI (`gh`) with the user's own sign-in, so Quiver
// stores no GitHub token.

/** One changed path, with git's one-letter codes for the index (staged) and the working tree. `?` is untracked, `U` unmerged. */
export interface GitFileChange {
  path: string;
  /** The old path of a rename or copy. */
  origPath?: string;
  index: string;
  worktree: string;
}

export interface GitStatus {
  /** Null on a detached HEAD. */
  branch: string | null;
  head: string | null;
  upstream?: string;
  ahead: number;
  behind: number;
  files: GitFileChange[];
  /** True while a merge, rebase, cherry-pick or revert is in progress. */
  operation?: 'merge' | 'rebase' | 'cherry-pick' | 'revert';
}

export interface GitBranch {
  name: string;
  current: boolean;
  remote: boolean;
  upstream?: string;
  ahead: number;
  behind: number;
  head: string;
  subject: string;
  date: string;
  /**
   * Its commits are all in the default branch (`origin/HEAD`, else a local `main` or `master`), or in the current
   * branch when there is no default. Never true of the default branch itself, the current branch or a remote branch
   * of the default's name.
   */
  merged: boolean;
  /** It has an upstream that no longer exists on the remote (a fetch pruned it). */
  gone: boolean;
}

export interface GitTag {
  name: string;
  /** The commit it points at (for an annotated tag, the commit its tag object points at). */
  commit: string;
  annotated: boolean;
  /** The tag message's first line, or the commit's subject for a lightweight tag. */
  subject: string;
  /** When it was tagged, or the commit's date for a lightweight tag. */
  date: string;
}

export interface GitStash {
  /** The N of `stash@{N}`; 0 is the newest. */
  index: number;
  hash: string;
  /** The message given, or git's "WIP" line (the commit it was made on) when none was. */
  message: string;
  /** The branch it was made on; absent on a detached HEAD. */
  branch?: string;
  /** ISO 8601. */
  date: string;
}

/** What a merge, rebase, cherry-pick, revert, stash apply or a continue gives back. */
export interface GitOperationResult {
  /** What git printed. */
  output: string;
  /**
   * Paths left with conflicts. Not an error: the operation waits for them to be resolved and staged, then for
   * `git.operation.continue` (or abort). Empty when it went through.
   */
  conflicts: string[];
  status: GitStatus;
}

/** A file's content at a ref or in the index (`git.file.show`). */
export interface GitFileContent {
  path: string;
  /** The ref it was read at; absent when read from the index. */
  ref?: string;
  /** In bytes. */
  size: number;
  /** A NUL byte in its first 8000 bytes, as git decides; no content then. */
  binary: boolean;
  /** Over the 2 MB limit; no content then. */
  tooLarge: boolean;
  /** UTF-8 text, when it is neither binary nor too large. */
  content?: string;
}

export interface GitCommit {
  hash: string;
  shortHash: string;
  parents: string[];
  author: string;
  email: string;
  /** ISO 8601. */
  date: string;
  subject: string;
  body: string;
  /** Branch and tag names pointing at it. */
  refs: string[];
}

export interface GitDiffFile {
  path: string;
  origPath?: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'type-changed';
  additions: number;
  deletions: number;
  binary: boolean;
  /** The unified diff of this file; left out when it is binary or over the size limit. */
  patch?: string;
  truncated?: boolean;
}

/**
 * A ref, branch, remote or path handed to git on its command line. Git reads a value starting with `-` as an
 * option, and some of those write files or run programs (`--output=<file>`, `--upload-pack=<cmd>`), which would
 * turn a read-only command into a write for an agent. Commands still put `--` before paths.
 */
export const GitArgSchema = z.string().min(1).refine((s) => !s.startsWith('-'), { message: 'must not start with "-"' });

export const GitLogInputSchema = z.object({
  ref: GitArgSchema.optional(),
  path: GitArgSchema.optional(),
  limit: z.number().int().min(1).max(500).default(50),
  skip: z.number().int().min(0).default(0),
});

/** Working tree against the index (default), the index against HEAD (`staged`), or two refs. */
export const GitDiffInputSchema = z.object({
  staged: z.boolean().default(false),
  from: GitArgSchema.optional(),
  to: GitArgSchema.optional(),
  path: GitArgSchema.optional(),
  /** Leave patches out and give only the per-file counts. */
  statOnly: z.boolean().default(false),
});

export const GitPathsInputSchema = z.object({ paths: z.array(GitArgSchema).min(1) });
export const GitCommitInputSchema = z.object({ message: z.string().trim().min(1), amend: z.boolean().default(false) });
export const GitCheckoutInputSchema = z.object({ ref: GitArgSchema });
export const GitBranchCreateInputSchema = z.object({ name: GitArgSchema, from: GitArgSchema.optional(), checkout: z.boolean().default(true) });
export const GitRemoteInputSchema = z.object({ remote: GitArgSchema.optional(), branch: GitArgSchema.optional() });
export const GitPushInputSchema = GitRemoteInputSchema.extend({ setUpstream: z.boolean().default(false), forceWithLease: z.boolean().default(false) });

export const GitBranchDeleteInputSchema = z.object({
  name: GitArgSchema,
  force: z.boolean().default(false).describe('Delete it even when its commits are not merged anywhere (git branch -D); they are then only in the reflog.'),
});
export const GitBranchDeleteRemoteInputSchema = z.object({ remote: GitArgSchema, name: GitArgSchema.describe('The branch on the remote, without the remote: "feature", not "origin/feature"') });
export const GitBranchRenameInputSchema = z.object({ from: GitArgSchema.optional().describe('Default: the current branch'), to: GitArgSchema });
export const GitBranchSetUpstreamInputSchema = z.object({
  branch: GitArgSchema.optional().describe('Default: the current branch'),
  upstream: GitArgSchema.nullable().describe('A remote-tracking branch such as "origin/main" (or a local branch); null unsets it'),
});

export const GitMergeInputSchema = z.object({
  ref: GitArgSchema.describe('The branch, tag or commit to merge into the current branch'),
  mode: z
    .enum(['ff', 'no-ff', 'ff-only', 'squash'])
    .optional()
    .describe("ff: fast-forward when possible; no-ff: always a merge commit; ff-only: fail unless it fast-forwards; squash: stage the changes as one, without committing. Default: the repository's merge.ff setting"),
  message: z.string().trim().min(1).optional().describe("The merge commit's message; default: git's \"Merge branch …\""),
});
export const GitRebaseInputSchema = z.object({ onto: GitArgSchema.describe('The branch or commit to replay the current branch on') });
export const GitCherryPickInputSchema = z.object({ commits: z.array(GitArgSchema).min(1).max(100).describe('Applied in the order given') });
export const GitRevertInputSchema = z.object({ commit: GitArgSchema });
export const GitResetInputSchema = z.object({
  ref: GitArgSchema.describe('The commit to move the current branch to'),
  mode: z.enum(['soft', 'mixed', 'hard']).describe('soft keeps the index and files; mixed keeps the files and empties the index; hard discards every uncommitted change'),
});

export const GitStashIndexInputSchema = z.object({
  index: z.number().int().min(0).describe('The N of stash@{N}, as git.stash.list gives it; 0 is the newest'),
  hash: z
    .string()
    .regex(/^[0-9a-fA-F]{4,64}$/, 'must be a commit hash')
    .optional()
    .describe('The stash\'s hash from git.stash.list: the call is refused (details.reason "stash-moved") when stash@{index} is another stash by now'),
});
export const GitStashPushInputSchema = z.object({
  message: z.string().trim().min(1).optional(),
  includeUntracked: z.boolean().default(false),
  /** Only these paths; every change by default. */
  paths: z.array(GitArgSchema).min(1).optional(),
});
export const GitStashApplyInputSchema = GitStashIndexInputSchema.extend({ pop: z.boolean().default(false).describe('Drop the stash once it applied without conflicts') });

export const GitDiscardInputSchema = GitPathsInputSchema.extend({
  staged: z.boolean().default(false).describe('Discard what is staged too, back to HEAD. Default: only the working changes, back to the index'),
});

export const GitTagCreateInputSchema = z.object({
  name: GitArgSchema,
  ref: GitArgSchema.optional().describe('Default: HEAD'),
  message: z.string().trim().min(1).optional().describe('Makes an annotated tag with this message; without it the tag is lightweight'),
});
export const GitTagNameInputSchema = z.object({ name: GitArgSchema });
export const GitTagPushInputSchema = z.object({ remote: GitArgSchema, name: GitArgSchema });

export const GitFileShowInputSchema = z.object({
  path: GitArgSchema.describe('Relative to the repository root'),
  ref: GitArgSchema.optional().describe('A commit, branch or tag; give this or index'),
  index: z.boolean().default(false).describe('Read the staged version instead of one at a ref'),
});

// ---------- Blame ----------

/** A commit that `git.blame` names for some lines, listed once however many lines it has. */
export interface GitBlameCommit {
  hash: string;
  author: string;
  authorEmail: string;
  /** ISO 8601. */
  authorTime: string;
  /** The first line of its message. */
  summary: string;
  /** The file's path in this commit; differs from the blamed path when the file was renamed since. */
  path: string;
  /** The commit before it that held these lines, and the file's path there: where "blame before this commit" goes. */
  previous?: { commit: string; path: string };
  /** The history stops here (a root commit, or the boundary of a range): the lines may be older than it. */
  boundary: boolean;
}

/** One line of the blamed file. */
export interface GitBlameLine {
  /** 1-based, in the file as blamed. */
  line: number;
  /** The commit that last changed the line; null for a line not committed yet (changed in the working tree). */
  commit: string | null;
  /** 1-based, the line's number in that commit's version of the file. */
  originalLine: number;
  /** The line's text, without its line ending. */
  text: string;
}

/** `git.blame`: who last changed each line of a file, at a ref or in the working tree. */
export interface GitBlame {
  path: string;
  /** The ref it was blamed at; absent for the working tree. */
  ref?: string;
  lines: GitBlameLine[];
  /** Keyed by hash. */
  commits: Record<string, GitBlameCommit>;
}

export const GitBlameInputSchema = z.object({
  path: GitArgSchema.describe('The file, relative to the repository root'),
  ref: GitArgSchema.optional().describe('A commit, branch or tag to blame the file at; default: the working tree, where uncommitted lines have commit null'),
  ignoreWhitespace: z.boolean().default(false).describe('Ignore whitespace-only changes when finding the commit of a line (git blame -w)'),
});

/** Whether `gh` can be used here: installed, signed in, and the workspace is a GitHub repository. */
export interface GhStatus {
  installed: boolean;
  authenticated: boolean;
  user?: string;
  /** `owner/name` of the workspace's GitHub repository (`host/owner/name` on GitHub Enterprise). */
  repo?: string;
  /** What to do next when something is missing. */
  message?: string;
}

export type GitPrCheckState = 'pending' | 'success' | 'failure' | 'skipped' | 'neutral';

export interface GitPrCheck {
  name: string;
  workflow?: string;
  state: GitPrCheckState;
  url?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface GitPullRequest {
  number: number;
  title: string;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  author: string;
  headRefName: string;
  baseRefName: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  reviewDecision?: 'approved' | 'changes_requested' | 'review_required';
  labels: string[];
  /** Roll-up of the checks on the head commit. */
  checks: { state: GitPrCheckState | 'none'; passed: number; failed: number; pending: number };
}

export interface GitPullRequestDetail extends GitPullRequest {
  body: string;
  additions: number;
  deletions: number;
  files: { path: string; additions: number; deletions: number }[];
  reviews: { author: string; state: string; submittedAt: string; body: string }[];
  comments: { author: string; createdAt: string; body: string }[];
}

export const GitPrListInputSchema = z.object({
  filter: z.enum(['mine', 'review-requested', 'all']).default('all'),
  state: z.enum(['open', 'closed', 'merged', 'all']).default('open'),
  limit: z.number().int().min(1).max(100).default(30),
});
export const GitPrRefInputSchema = z.object({ number: z.number().int().positive() });
export const GitPrChecksInputSchema = GitPrRefInputSchema.extend({
  /** Include the last lines of each failed job's log. */
  failedLogs: z.boolean().default(false),
});
export const GitPrCheckoutInputSchema = GitPrRefInputSchema.extend({
  allowFork: z
    .boolean()
    .default(false)
    .describe(
      "Check out a pull request from another repository (a fork). Off by default: the fork's branch brings its own committed .quiver/ folder, whose MCP servers, mock servers and realtime connections marked to start with the workspace run their commands on the next open.",
    ),
});
export const GitPrCreateInputSchema = z.object({
  title: z.string().trim().min(1),
  body: z.string().default(''),
  base: GitArgSchema.optional(),
  draft: z.boolean().default(false),
  // gh splits --label on commas and reads quotes as CSV, so such a label would become other labels or an error.
  labels: z.array(GitArgSchema.refine((s) => !/[,"]/.test(s), { message: 'must not contain a comma or a double quote' })).default([]),
});
export const GitPrCommentInputSchema = GitPrRefInputSchema.extend({ body: z.string().trim().min(1) });
