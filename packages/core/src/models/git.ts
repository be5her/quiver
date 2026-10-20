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
