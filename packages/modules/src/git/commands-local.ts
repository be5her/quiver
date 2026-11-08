import {
  GitArgSchema,
  GitBranchCreateInputSchema,
  GitCheckoutInputSchema,
  GitCommitInputSchema,
  GitDiffInputSchema,
  GitLogInputSchema,
  GitPathsInputSchema,
  GitPushInputSchema,
  GitRemoteInputSchema,
  QuiverError,
  defineCommand,
  type CommandContext,
  type CommandDefinition,
  type GitBranch,
  type GitCommit,
  type GitDiffFile,
  type GitStatus,
  type HostApi,
  type WorkspaceApi,
} from '@quiver/core';
import { z } from 'zod';
import * as local from './local';

// Lane G1: the local repository through the git CLI. Reads are open to agents; anything that moves HEAD, the index,
// a branch or a remote is mutating.

export function workspace(ctx: CommandContext): WorkspaceApi {
  if (!ctx.workspace) throw new QuiverError('NO_WORKSPACE', 'Open a workspace first');
  // The first git command in a folder that has become a repository starts its watcher.
  void local.ensureWatcher(ctx.workspace, ctx.host);
  return ctx.workspace;
}

/** A call from the UI may open a credential window; one from an agent must not hang behind a dialog nobody sees coming. */
export function interactive(ctx: CommandContext): boolean {
  return ctx.caller !== 'mcp';
}

/** Announce a change at once; the watcher's debounced event follows, but the view should not wait for it. */
export function changed(ctx: CommandContext, ws: WorkspaceApi, ...reasons: ('status' | 'branches' | 'stashes' | 'worktrees')[]): void {
  for (const reason of reasons) ctx.host.emit('git.changed', { workspaceId: ws.id, reason });
}

const status = defineCommand({
  id: 'git.status',
  title: 'Git status',
  description:
    'The workspace repository: current branch (null when detached), HEAD, upstream with ahead/behind counts, the operation in progress (merge, rebase, cherry-pick, revert) and every changed file with its index and worktree codes (M modified, A added, D deleted, R renamed, U unmerged, ? untracked, . unchanged). Paths are relative to the repository root (an untracked folder is one entry, "new/"), and every other git command takes them that way. files: false leaves the files out (an empty list) and is faster in a big repository, for when only the branch is wanted. worktree.linked says the workspace is a linked worktree (git worktree add) of the repository whose main worktree is worktree.mainPath.',
  scope: 'workspace',
  input: z.object({ files: z.boolean().optional() }),
  handler: async (i, ctx): Promise<GitStatus> => local.status(workspace(ctx).path, { files: i.files }),
});

const branchList = defineCommand({
  id: 'git.branch.list',
  title: 'Git branches',
  description:
    'Local and remote-tracking branches, newest commit first, with the current one, upstream, ahead/behind, head commit, subject and date. merged: all its commits are in the default branch (origin/HEAD, else a local main or master), or in the current branch when there is none; never set on that branch or the current one. gone: its upstream was deleted on the remote. worktreePath: the other worktree it is checked out in, where it cannot be checked out here.',
  scope: 'workspace',
  input: z.object({}),
  handler: async (_i, ctx): Promise<GitBranch[]> => local.branches(workspace(ctx).path),
});

const log = defineCommand({
  id: 'git.log',
  title: 'Git log',
  description: 'Commit history, newest first, of HEAD or a ref, optionally only commits touching a path. Paged with limit and skip; hasMore says whether older commits follow.',
  scope: 'workspace',
  input: GitLogInputSchema,
  handler: async (input, ctx): Promise<local.GitLogPage> => local.log(workspace(ctx).path, input),
});

const diff = defineCommand({
  id: 'git.diff',
  title: 'Git diff',
  description:
    'Changed files with added/deleted line counts and unified patches. Default: working tree against the index (unstaged changes). staged: index against HEAD. from: working tree (or with staged, the index) against a ref. from and to: between two refs. path limits it to one file or folder; statOnly leaves the patches out. Untracked files are not in a diff; see git.status.',
  scope: 'workspace',
  input: GitDiffInputSchema,
  handler: async (input, ctx): Promise<GitDiffFile[]> => local.diff(workspace(ctx).path, input),
});

const show = defineCommand({
  id: 'git.show',
  title: 'Show git commit',
  description: 'One commit: author, date, message, refs, and its changes against its first parent with patches (statOnly leaves them out).',
  scope: 'workspace',
  input: z.object({ ref: GitArgSchema.describe('A commit hash, branch or tag'), statOnly: z.boolean().default(false) }),
  handler: async ({ ref, statOnly }, ctx): Promise<local.GitShowResult> => local.show(workspace(ctx).path, ref, statOnly),
});

const fetch = defineCommand({
  id: 'git.fetch',
  title: 'Git fetch',
  description:
    "Downloads new commits and branches from a remote (default: the current branch's remote) and prunes deleted remote branches. Only remote-tracking refs change; local branches and files are untouched. remote must be one of the repository's configured remotes, not a URL or a folder.",
  scope: 'workspace',
  input: GitRemoteInputSchema.pick({ remote: true }),
  handler: async ({ remote }, ctx): Promise<local.GitRemoteResult> => {
    const ws = workspace(ctx);
    const result = await local.remoteOp(ws.path, ['fetch', '--prune', ...(remote ? [remote] : [])], remote, interactive(ctx));
    changed(ctx, ws, 'branches', 'status');
    return result;
  },
});

const checkout = defineCommand({
  id: 'git.checkout',
  title: 'Git checkout',
  description:
    'Switches to a branch, tag or commit. A remote branch name without its remote ("feature" for origin/feature) creates a local tracking branch. Fails rather than overwrite uncommitted changes, and for a branch checked out in another worktree (details.reason "checked-out-elsewhere", details.path that worktree).',
  scope: 'workspace',
  mutating: true,
  input: GitCheckoutInputSchema,
  handler: async ({ ref }, ctx): Promise<GitStatus> => {
    const ws = workspace(ctx);
    await local.git(await local.repoRoot(ws.path), ['checkout', ref, '--']).catch((err: unknown) => {
      throw local.inOtherWorktree(err, 'open that worktree, or switch it to another branch first');
    });
    changed(ctx, ws, 'status', 'branches');
    return local.status(ws.path);
  },
});

const branchCreate = defineCommand({
  id: 'git.branch.create',
  title: 'Create git branch',
  description: 'Creates a branch at HEAD or at from, and switches to it unless checkout is false.',
  scope: 'workspace',
  mutating: true,
  input: GitBranchCreateInputSchema,
  handler: async ({ name, from, checkout: switchTo }, ctx): Promise<GitStatus> => {
    const ws = workspace(ctx);
    await local.git(await local.repoRoot(ws.path), switchTo ? ['checkout', '-b', name, ...(from ? [from] : []), '--'] : ['branch', name, ...(from ? [from] : [])]);
    changed(ctx, ws, 'status', 'branches');
    return local.status(ws.path);
  },
});

const stage = defineCommand({
  id: 'git.stage',
  title: 'Stage files',
  description: 'Adds files (new, changed or deleted) to the index, ready for the next commit. Paths are relative to the repository root, as git.status and git.diff give them; a folder stages everything in it.',
  scope: 'workspace',
  mutating: true,
  input: GitPathsInputSchema,
  handler: async ({ paths }, ctx): Promise<GitStatus> => {
    const ws = workspace(ctx);
    await local.git(await local.repoRoot(ws.path), ['add', '--all', '--', ...paths]);
    changed(ctx, ws, 'status');
    return local.status(ws.path);
  },
});

const unstage = defineCommand({
  id: 'git.unstage',
  title: 'Unstage files',
  description: 'Takes files out of the index back to HEAD, keeping the changes in the working tree.',
  scope: 'workspace',
  mutating: true,
  input: GitPathsInputSchema,
  handler: async ({ paths }, ctx): Promise<GitStatus> => {
    const ws = workspace(ctx);
    const root = await local.repoRoot(ws.path);
    const before = await local.status(root);
    // Before the first commit there is no HEAD to restore from; the files just leave the index.
    await local.git(root, before.head ? ['restore', '--staged', '--', ...paths] : ['rm', '--cached', '-r', '--quiet', '--', ...paths]);
    changed(ctx, ws, 'status');
    return local.status(ws.path);
  },
});

const commit = defineCommand({
  id: 'git.commit',
  title: 'Git commit',
  description: "Commits what is staged with the message, as the repository's configured author; hooks run as usual. amend replaces the last commit instead. Fails when nothing is staged.",
  scope: 'workspace',
  mutating: true,
  input: GitCommitInputSchema,
  handler: async ({ message, amend }, ctx): Promise<GitCommit> => {
    const ws = workspace(ctx);
    const root = await local.repoRoot(ws.path);
    // The message goes through stdin so no part of it can be read as an option. `whitespace` trims it like an editor
    // would but keeps lines starting with `#` (`strip` would drop "#42 fix …" as a comment).
    await local.git(root, ['commit', '--file=-', '--cleanup=whitespace', ...(amend ? ['--amend'] : [])], { input: message });
    changed(ctx, ws, 'status', 'branches');
    return local.commitInfo(root, 'HEAD');
  },
});

const pull = defineCommand({
  id: 'git.pull',
  title: 'Git pull',
  description: "Fetches and merges (or rebases, per the repository's pull settings) the upstream of the current branch, or remote and branch when given (a branch name, not a refspec). Never opens an editor; stops on conflicts, leaving them in git.status.",
  scope: 'workspace',
  mutating: true,
  input: GitRemoteInputSchema,
  handler: async ({ remote, branch }, ctx): Promise<local.GitRemoteResult> => {
    const ws = workspace(ctx);
    if (branch && !remote) throw new QuiverError('INVALID_INPUT', 'A pull of a branch needs its remote too');
    if (branch) local.requireBranchName(branch);
    const result = await local.remoteOp(ws.path, ['pull', '--no-edit', ...(remote ? [remote] : []), ...(branch ? [branch] : [])], remote, interactive(ctx));
    changed(ctx, ws, 'status', 'branches');
    return result;
  },
});

const push = defineCommand({
  id: 'git.push',
  title: 'Git push',
  description:
    'Pushes the current branch to its upstream, or to remote and branch when given (a branch name, not a refspec: nothing is deleted or forced through it). setUpstream makes that the upstream (remote defaults to origin, branch to the current one). forceWithLease overwrites the remote branch only if it is where it was last fetched.',
  scope: 'workspace',
  mutating: true,
  actions: {
    list: ['push', 'force'],
    of: ({ forceWithLease }) => (forceWithLease ? 'force' : 'push'),
    describe: { push: 'A plain push, which the remote refuses unless it fast-forwards', force: 'A push with forceWithLease, which can overwrite commits on the remote branch' },
  },
  input: GitPushInputSchema,
  handler: async ({ remote, branch, setUpstream, forceWithLease }, ctx): Promise<local.GitRemoteResult> => {
    const ws = workspace(ctx);
    let target = remote;
    let ref = branch;
    if (setUpstream) {
      target ??= 'origin';
      ref ??= (await local.status(ws.path)).branch ?? undefined;
      if (!ref) throw new QuiverError('INVALID_INPUT', 'HEAD is detached; name the branch to push');
    }
    if (ref && !target) throw new QuiverError('INVALID_INPUT', 'A push of a branch needs its remote too');
    if (ref) local.requireBranchName(ref);
    const args = ['push', ...(setUpstream ? ['--set-upstream'] : []), ...(forceWithLease ? ['--force-with-lease'] : []), ...(target ? [target] : []), ...(ref ? [ref] : [])];
    const result = await local.remoteOp(ws.path, args, target, interactive(ctx));
    changed(ctx, ws, 'status', 'branches');
    return result;
  },
});

export const localCommands: CommandDefinition[] = [status, branchList, log, diff, show, fetch, checkout, branchCreate, stage, unstage, commit, pull, push];

/** The repository watcher's lifecycle, spread into the git module. */
export const localLifecycle = {
  onWorkspaceOpen: (ws: WorkspaceApi, host: HostApi) => local.ensureWatcher(ws, host),
  onWorkspaceClose: (ws: WorkspaceApi) => local.stopWatcher(ws.id),
};
