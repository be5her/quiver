import {
  GitBranchDeleteInputSchema,
  GitBranchDeleteRemoteInputSchema,
  GitBranchRenameInputSchema,
  GitBranchSetUpstreamInputSchema,
  GitCherryPickInputSchema,
  GitDiscardInputSchema,
  GitFileShowInputSchema,
  GitMergeInputSchema,
  GitRebaseInputSchema,
  GitResetInputSchema,
  GitRevertInputSchema,
  GitStashApplyInputSchema,
  GitStashIndexInputSchema,
  GitStashPushInputSchema,
  GitTagCreateInputSchema,
  GitTagNameInputSchema,
  GitTagPushInputSchema,
  QuiverError,
  conflictedPaths,
  defineCommand,
  operationArgs,
  planDiscard,
  type CommandContext,
  type CommandDefinition,
  type GitDiffFile,
  type GitFileContent,
  type GitOperationAction,
  type GitOperationResult,
  type GitStash,
  type GitStatus,
  type GitTag,
  type WorkspaceApi,
} from '@quiver/core';
import { z } from 'zod';
import { changed, interactive, workspace } from './commands-local';
import * as local from './local';

// Managing the local repository: branches, merges and rebases with the operation they leave in progress, commits
// picked, reverted or reset to, stashes, tags, discarding working changes, and a file's content at a ref. Every write
// is mutating and comes back with the new status (or, for what may stop on conflicts, a GitOperationResult listing
// them); the reads are open to agents.

async function repo(ctx: CommandContext): Promise<{ ws: WorkspaceApi; root: string }> {
  const ws = workspace(ctx);
  return { ws, root: await local.repoRoot(ws.path) };
}

/**
 * Runs a write and announces it also when git failed part-way: a merge or cherry-pick stopped by a hook or left empty,
 * or a discard whose clean failed after the restore, has still changed the branch, the index or the files.
 */
async function announced<T>(ctx: CommandContext, ws: WorkspaceApi, reasons: ('status' | 'branches' | 'stashes')[], run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } finally {
    changed(ctx, ws, ...reasons);
  }
}

/**
 * A branch or tag as a plain name, or a clear error: no refspec (see `requireBranchName`), and no full ref name or
 * HEAD, which `push --delete` and friends would read as something other than the branch meant.
 */
function plainName(name: string, what = 'branch'): string {
  local.requireBranchName(name);
  if (name.startsWith('refs/') || name === 'HEAD') throw new QuiverError('INVALID_INPUT', `${name} is not a ${what} name: give the name alone, as in "feature"`);
  return name;
}

// ---------- branches ----------

const branchDelete = defineCommand({
  id: 'git.branch.delete',
  title: 'Delete git branch',
  description:
    'Deletes a local branch. Refuses the current branch, and a branch whose commits are in none of its upstream, HEAD and the default branch (details.reason "not-merged") unless force is true; a forced delete leaves those commits only in the reflog. The remote branch is untouched; see git.branch.deleteRemote.',
  scope: 'workspace',
  mutating: true,
  input: GitBranchDeleteInputSchema,
  handler: async ({ name, force }, ctx): Promise<GitStatus> => {
    const { ws, root } = await repo(ctx);
    plainName(name);
    if ((await local.status(root, { files: false })).branch === name) throw new QuiverError('INVALID_INPUT', `${name} is the current branch; switch to another one first`, { reason: 'current-branch' });
    const args = ['branch', force ? '-D' : '-d', name];
    const result = await local.git(root, args, { allowFailure: true });
    if (result.code !== 0) {
      const err = local.gitFailure(args, result);
      if (!/not fully merged/i.test(err.message)) throw err;
      // Git's -d only looks at the upstream and HEAD. A branch git.branch.list calls merged has its commits in the
      // default branch, so nothing is lost when it goes from another branch.
      const base = await local.defaultBranch(root);
      // Never the default branch itself, whose commits would trivially be "in" it: neither `main` when it is the base,
      // nor the local `main` when the base is `origin/main`.
      const inDefault = base && base.ref !== `refs/heads/${name}` && base.name !== name && (await local.git(root, ['merge-base', '--is-ancestor', `refs/heads/${name}`, base.ref], { allowFailure: true })).code === 0;
      if (!inDefault) throw new QuiverError('INVALID_INPUT', `${name} has commits that are not merged; delete it with force to drop them`, { reason: 'not-merged' });
      await local.git(root, ['branch', '-D', name]);
    }
    changed(ctx, ws, 'branches');
    return local.status(root);
  },
});

const branchDeleteRemote = defineCommand({
  id: 'git.branch.deleteRemote',
  title: 'Delete remote git branch',
  description:
    "Deletes a branch on a remote (git push <remote> --delete refs/heads/<name>) and its remote-tracking branch here. remote must be a configured remote; name is the branch's name on it, without the remote. Refuses the remote's default branch (details.reason \"default-branch\"). Local branches are untouched.",
  scope: 'workspace',
  mutating: true,
  input: GitBranchDeleteRemoteInputSchema,
  handler: async ({ remote, name }, ctx): Promise<local.GitRemoteResult> => {
    const { ws, root } = await repo(ctx);
    await local.requireRemote(root, remote);
    plainName(name);
    if ((await local.remoteDefaultBranch(root, remote, interactive(ctx))) === name) {
      throw new QuiverError('INVALID_INPUT', `${name} is the default branch of ${remote}; it is not deleted from here`, { reason: 'default-branch' });
    }
    // The full ref name, so a tag of the same name is never what goes.
    const result = await local.remoteOp(root, ['push', '--delete', remote, `refs/heads/${name}`], remote, interactive(ctx));
    changed(ctx, ws, 'branches');
    return result;
  },
});

const branchRename = defineCommand({
  id: 'git.branch.rename',
  title: 'Rename git branch',
  description: 'Renames a local branch (the current one when from is left out), keeping its upstream; fails when to is taken. The branch on the remote keeps its name.',
  scope: 'workspace',
  mutating: true,
  input: GitBranchRenameInputSchema,
  handler: async ({ from, to }, ctx): Promise<GitStatus> => {
    const { ws, root } = await repo(ctx);
    if (from) plainName(from);
    plainName(to);
    await local.git(root, ['branch', '-m', ...(from ? [from] : []), to]);
    changed(ctx, ws, 'status', 'branches');
    return local.status(root);
  },
});

const branchSetUpstream = defineCommand({
  id: 'git.branch.setUpstream',
  title: 'Set git upstream',
  description: 'Sets the upstream a branch (the current one by default) pulls from and compares against, such as "origin/main", or unsets it with upstream null. Nothing is fetched or pushed.',
  scope: 'workspace',
  mutating: true,
  input: GitBranchSetUpstreamInputSchema,
  handler: async ({ branch, upstream }, ctx): Promise<GitStatus> => {
    const { ws, root } = await repo(ctx);
    if (branch) plainName(branch);
    if (upstream !== null) local.requireBranchName(upstream);
    await local.git(root, ['branch', upstream === null ? '--unset-upstream' : `--set-upstream-to=${upstream}`, ...(branch ? [branch] : [])]);
    changed(ctx, ws, 'status', 'branches');
    return local.status(root);
  },
});

// ---------- merge, rebase and the operation in progress ----------

const MERGE_MODE: Record<'ff' | 'no-ff' | 'ff-only' | 'squash', string> = { ff: '--ff', 'no-ff': '--no-ff', 'ff-only': '--ff-only', squash: '--squash' };

const merge = defineCommand({
  id: 'git.merge',
  title: 'Git merge',
  description:
    'Merges a branch, tag or commit into the current branch. mode: ff, no-ff, ff-only or squash (stages the changes without committing); message for the merge commit. Never opens an editor. Stopping on conflicts is not an error: the result lists them, and the merge waits for them to be resolved and staged, then git.operation.continue or git.operation.abort.',
  scope: 'workspace',
  mutating: true,
  input: GitMergeInputSchema,
  handler: async ({ ref, mode, message }, ctx): Promise<GitOperationResult> => {
    const { ws, root } = await repo(ctx);
    await local.requireNoOperation(root);
    // The message as `--message=<text>`, so no part of it can be read as an option.
    return announced(ctx, ws, ['status', 'branches'], () => local.operation(root, ['merge', '--no-edit', ...(mode ? [MERGE_MODE[mode]] : []), ...(message ? [`--message=${message}`] : []), ref]));
  },
});

const rebase = defineCommand({
  id: 'git.rebase',
  title: 'Git rebase',
  description:
    'Replays the commits of the current branch on top of onto (a branch or commit). Never interactive and never opens an editor. Stopping on conflicts is not an error: the result lists them, and the rebase waits for them to be resolved and staged, then git.operation.continue, skip or abort.',
  scope: 'workspace',
  mutating: true,
  input: GitRebaseInputSchema,
  handler: async ({ onto }, ctx): Promise<GitOperationResult> => {
    const { ws, root } = await repo(ctx);
    await local.requireNoOperation(root);
    return announced(ctx, ws, ['status', 'branches'], () => local.operation(root, ['rebase', onto]));
  },
});

const OPERATION_TEXT: Record<GitOperationAction, { title: string; description: string }> = {
  continue: {
    title: 'Continue git operation',
    description:
      "Continues the merge, rebase, cherry-pick or revert in progress once its conflicts are resolved and staged, keeping git's prepared commit message (no editor opens). Refused while conflicts are unresolved (details.reason \"unresolved\"). A rebase or cherry-pick may stop on the next commit's conflicts, which the result lists.",
  },
  abort: { title: 'Abort git operation', description: 'Aborts the merge, rebase, cherry-pick or revert in progress and puts the branch, index and files back as they were before it started.' },
  skip: {
    title: 'Skip in git operation',
    description: "Drops the commit a rebase, cherry-pick or revert stopped on and goes on with the next one; a merge has no skip. The skipped commit's changes are lost from the result.",
  },
};

function operationCommand(action: GitOperationAction): CommandDefinition {
  return defineCommand({
    id: `git.operation.${action}`,
    ...OPERATION_TEXT[action],
    scope: 'workspace',
    mutating: true,
    input: z.object({}),
    handler: async (_i, ctx): Promise<GitOperationResult> => {
      const { ws, root } = await repo(ctx);
      const st = await local.status(root);
      if (!st.operation) throw new QuiverError('INVALID_INPUT', 'No merge, rebase, cherry-pick or revert is in progress', { reason: 'no-operation' });
      const args = operationArgs(st.operation, action);
      if (!args) throw new QuiverError('INVALID_INPUT', `A ${st.operation} cannot skip; continue or abort it`);
      const conflicts = conflictedPaths(st.files);
      if (action === 'continue' && conflicts.length) throw new QuiverError('INVALID_INPUT', `Resolve and stage ${conflicts.join(', ')} first`, { reason: 'unresolved', conflicts });
      return announced(ctx, ws, ['status', 'branches'], () => local.operation(root, args));
    },
  });
}

// ---------- commits ----------

const cherryPick = defineCommand({
  id: 'git.cherryPick',
  title: 'Git cherry-pick',
  description:
    'Applies the changes of the commits, in the order given, as new commits on the current branch. Stopping on conflicts is not an error: the result lists them, and the cherry-pick waits for git.operation.continue, skip or abort.',
  scope: 'workspace',
  mutating: true,
  input: GitCherryPickInputSchema,
  handler: async ({ commits }, ctx): Promise<GitOperationResult> => {
    const { ws, root } = await repo(ctx);
    await local.requireNoOperation(root);
    return announced(ctx, ws, ['status', 'branches'], () => local.operation(root, ['cherry-pick', ...commits]));
  },
});

const revert = defineCommand({
  id: 'git.revert',
  title: 'Git revert',
  description:
    "Makes a new commit that undoes a commit's changes, with git's \"Revert …\" message. Stopping on conflicts is not an error: the result lists them, and the revert waits for git.operation.continue, skip or abort. A merge commit cannot be reverted this way.",
  scope: 'workspace',
  mutating: true,
  input: GitRevertInputSchema,
  handler: async ({ commit }, ctx): Promise<GitOperationResult> => {
    const { ws, root } = await repo(ctx);
    await local.requireNoOperation(root);
    return announced(ctx, ws, ['status', 'branches'], () => local.operation(root, ['revert', '--no-edit', commit]));
  },
});

const reset = defineCommand({
  id: 'git.reset',
  title: 'Git reset',
  description:
    'Moves the current branch to ref. soft keeps the index and the files (the undone commits become staged changes); mixed keeps the files and unstages everything; hard also discards every uncommitted change to tracked files, which cannot be undone. Commits left behind stay in the reflog.',
  scope: 'workspace',
  mutating: true,
  input: GitResetInputSchema,
  handler: async ({ ref, mode }, ctx): Promise<GitStatus> => {
    const { ws, root } = await repo(ctx);
    // The `--` says ref is a commit, never a path.
    await local.git(root, ['reset', `--${mode}`, ref, '--']);
    changed(ctx, ws, 'status', 'branches');
    return local.status(root);
  },
});

// ---------- stashes ----------

const stashList = defineCommand({
  id: 'git.stash.list',
  title: 'Git stashes',
  description: 'The stashes, newest first: index (the N of stash@{N}), hash, message, the branch it was made on and the date.',
  scope: 'workspace',
  input: z.object({}),
  handler: async (_i, ctx): Promise<GitStash[]> => local.stashes(workspace(ctx).path),
});

export interface GitStashShowResult {
  stash: GitStash;
  /** Against the commit it was made on, then its untracked files (stashed with includeUntracked) as added. */
  files: GitDiffFile[];
}

const stashShow = defineCommand({
  id: 'git.stash.show',
  title: 'Show git stash',
  description: 'One stash and its changes as git.diff gives them (patches unless statOnly), against the commit it was made on; untracked files it holds come last, as added.',
  scope: 'workspace',
  input: GitStashIndexInputSchema.extend({ statOnly: z.boolean().default(false) }),
  handler: async ({ index, hash, statOnly }, ctx): Promise<GitStashShowResult> => {
    const { root } = await repo(ctx);
    const stash = await local.stashAt(root, index, hash);
    const { parents } = await local.commitInfo(root, stash.hash);
    const files = await local.diffFiles(root, [parents[0], stash.hash], undefined, statOnly);
    // A stash made with --include-untracked has a third parent holding the untracked files.
    if (parents[2]) files.push(...(await local.diffFiles(root, [await local.emptyTree(root), parents[2]], undefined, statOnly)));
    return { stash, files };
  },
});

const stashPush = defineCommand({
  id: 'git.stash.push',
  title: 'Stash changes',
  description:
    'Saves the working and staged changes (only those under paths, when given) as a new stash, stash@{0}, and puts the files back to HEAD. includeUntracked stashes untracked files too (ignored files never). Fails with details.reason "nothing-to-stash" when there are no changes.',
  scope: 'workspace',
  mutating: true,
  input: GitStashPushInputSchema,
  handler: async ({ message, includeUntracked, paths }, ctx): Promise<GitStatus> => {
    const { ws, root } = await repo(ctx);
    // Each path literal (`[id].tsx` is a file, not a glob), by its own magic: GIT_LITERAL_PATHSPECS would also switch
    // off the `:/` stash gives its own clean of untracked files, which would then leave them in place.
    const args = ['stash', 'push', ...(includeUntracked ? ['--include-untracked'] : []), ...(message ? [`--message=${message}`] : []), ...(paths ? ['--', ...paths.map((p) => `:(literal)${p}`)] : [])];
    // Git says "No local changes to save" and exits 0, in the user's language; whether refs/stash moved says it in any.
    const top = async () => (await local.git(root, ['rev-parse', '--quiet', '--verify', 'refs/stash'], { allowFailure: true })).stdout.trim();
    const before = await top();
    await local.git(root, args);
    if ((await top()) === before) {
      throw new QuiverError('INVALID_INPUT', includeUntracked ? 'Nothing to stash: there are no local changes' : 'Nothing to stash: there are no changes to tracked files (untracked ones need includeUntracked)', { reason: 'nothing-to-stash' });
    }
    changed(ctx, ws, 'status', 'stashes');
    return local.status(root);
  },
});

const stashApply = defineCommand({
  id: 'git.stash.apply',
  title: 'Apply git stash',
  description:
    'Applies a stash to the working tree; pop also drops it, once it applied without conflicts. Stopping on conflicts is not an error: the result lists them, they are resolved like a merge (there is nothing to continue), and the stash is kept. Fails when the stash touches files with uncommitted changes.',
  scope: 'workspace',
  mutating: true,
  input: GitStashApplyInputSchema,
  handler: async ({ index, hash, pop }, ctx): Promise<GitOperationResult> => {
    const { ws, root } = await repo(ctx);
    const stash = await local.stashAt(root, index, hash);
    await local.requireNoOperation(root);
    // Apply takes the stash by its hash, so a stash pushed or dropped since the check cannot swap in another one. Pop
    // needs the stash@{N} entry it drops; it is checked again just before, which leaves the smallest window.
    if (pop) await local.stashAt(root, index, stash.hash);
    return announced(ctx, ws, ['status', 'stashes'], () => local.operation(root, ['stash', pop ? 'pop' : 'apply', pop ? `stash@{${index}}` : stash.hash]));
  },
});

const stashDrop = defineCommand({
  id: 'git.stash.drop',
  title: 'Drop git stash',
  description: 'Deletes a stash; the ones after it move up by one (stash@{2} becomes stash@{1}). Gives back the stashes left.',
  scope: 'workspace',
  mutating: true,
  input: GitStashIndexInputSchema,
  handler: async ({ index, hash }, ctx): Promise<GitStash[]> => {
    const { ws, root } = await repo(ctx);
    await local.stashAt(root, index, hash);
    await local.git(root, ['stash', 'drop', `stash@{${index}}`]);
    changed(ctx, ws, 'stashes');
    return local.stashes(root);
  },
});

// ---------- working tree ----------

const discard = defineCommand({
  id: 'git.discard',
  title: 'Discard changes',
  description:
    'Throws away changes to files, which cannot be undone: tracked files go back to the index (staged: true takes them back to HEAD, staged changes included), and a path git.status lists as untracked is deleted (an untracked folder entry, "new/", with everything in it). Paths are relative to the repository root; ignored files are never deleted.',
  scope: 'workspace',
  mutating: true,
  input: GitDiscardInputSchema,
  handler: async ({ paths, staged }, ctx): Promise<GitStatus> => {
    const { ws, root } = await repo(ctx);
    const plan = planDiscard((await local.status(root)).files, paths, staged);
    // Restored first: a path git does not know fails it before anything is deleted. Paths are literal, never globs.
    const env = local.LITERAL_PATHS_ENV;
    await announced(ctx, ws, ['status'], async () => {
      if (plan.restore.length) await local.git(root, staged ? ['restore', '--source=HEAD', '--staged', '--worktree', '--', ...plan.restore] : ['restore', '--worktree', '--', ...plan.restore], { env });
      if (plan.clean.length) await local.git(root, ['clean', '--force', ...(plan.cleanDirs ? ['-d'] : []), '--', ...plan.clean], { env });
    });
    return local.status(root);
  },
});

// ---------- tags ----------

const tagList = defineCommand({
  id: 'git.tag.list',
  title: 'Git tags',
  description: 'The tags, newest first: name, the commit it points at, whether it is annotated, its message (or the commit subject for a lightweight tag) and its date.',
  scope: 'workspace',
  input: z.object({}),
  handler: async (_i, ctx): Promise<GitTag[]> => local.tags(workspace(ctx).path),
});

const tagCreate = defineCommand({
  id: 'git.tag.create',
  title: 'Create git tag',
  description: 'Tags HEAD, or ref. With a message the tag is annotated (the message goes on stdin), without one lightweight. Fails when the name is taken. Nothing is pushed; see git.tag.push. Gives back the new tag.',
  scope: 'workspace',
  mutating: true,
  input: GitTagCreateInputSchema,
  handler: async ({ name, ref, message }, ctx): Promise<GitTag> => {
    const { ws, root } = await repo(ctx);
    plainName(name, 'tag');
    const target = ref ? [ref] : [];
    if (message) await local.git(root, ['tag', '--annotate', '--file=-', '--cleanup=whitespace', name, ...target], { input: message });
    else await local.git(root, ['tag', name, ...target]);
    changed(ctx, ws, 'branches');
    const tag = (await local.tags(root)).find((t) => t.name === name);
    if (!tag) throw new QuiverError('INTERNAL', `The tag ${name} was made but is not listed`);
    return tag;
  },
});

const tagDelete = defineCommand({
  id: 'git.tag.delete',
  title: 'Delete git tag',
  description: 'Deletes a local tag. A tag already pushed stays on the remote. Gives back the tags left.',
  scope: 'workspace',
  mutating: true,
  input: GitTagNameInputSchema,
  handler: async ({ name }, ctx): Promise<GitTag[]> => {
    const { ws, root } = await repo(ctx);
    plainName(name, 'tag');
    await local.git(root, ['tag', '-d', name]);
    changed(ctx, ws, 'branches');
    return local.tags(root);
  },
});

const tagPush = defineCommand({
  id: 'git.tag.push',
  title: 'Push git tag',
  description: "Pushes one tag to a configured remote (git push <remote> refs/tags/<name>). Fails, rather than move it, when the remote has a different tag of that name.",
  scope: 'workspace',
  mutating: true,
  input: GitTagPushInputSchema,
  handler: async ({ remote, name }, ctx): Promise<local.GitRemoteResult> => {
    const { ws, root } = await repo(ctx);
    plainName(name, 'tag');
    const result = await local.remoteOp(root, ['push', remote, `refs/tags/${name}`], remote, interactive(ctx));
    changed(ctx, ws, 'branches');
    return result;
  },
});

// ---------- files ----------

const fileShow = defineCommand({
  id: 'git.file.show',
  title: 'Show file at git ref',
  description:
    "A file's content as git stores it at ref (a commit, branch or tag), or in the index with index: true. Over 2 MB (tooLarge) or binary (a NUL byte in its first 8000 bytes) it comes back without content. path is relative to the repository root.",
  scope: 'workspace',
  input: GitFileShowInputSchema,
  handler: async (input, ctx): Promise<GitFileContent> => local.fileAt(workspace(ctx).path, input),
});

export const manageCommands: CommandDefinition[] = [
  branchDelete,
  branchDeleteRemote,
  branchRename,
  branchSetUpstream,
  merge,
  rebase,
  operationCommand('continue'),
  operationCommand('abort'),
  operationCommand('skip'),
  cherryPick,
  revert,
  reset,
  stashList,
  stashShow,
  stashPush,
  stashApply,
  stashDrop,
  discard,
  tagList,
  tagCreate,
  tagDelete,
  tagPush,
  fileShow,
];
