import { promises as fs, realpath } from 'node:fs';
import path from 'node:path';
import {
  GitWorktreeAddInputSchema,
  GitWorktreeLockInputSchema,
  GitWorktreePathInputSchema,
  GitWorktreeRemoveInputSchema,
  QuiverError,
  defaultWorktreePath,
  defineCommand,
  isSameOrInside,
  sameWorktreePath,
  type CommandContext,
  type CommandDefinition,
  type GitWorktree,
  type WorkspaceApi,
} from '@quiver/core';
import { z } from 'zod';
import { changed, workspace } from './commands-local';
import * as local from './local';

// Worktrees: more than one branch checked out at once, each in a folder of its own (`git worktree`). Listing is open
// to agents; adding, removing, locking, unlocking and pruning are mutating. A folder given by a caller is made absolute
// (relative to the folder that holds the main worktree) and, past `add`, must be one git lists, so what reaches git is
// always an absolute path after `--`.

/** Making a worktree checks out every file and runs the post-checkout hook, which can take far longer than a read. */
const ADD_TIMEOUT_MS = 180_000;

interface Repo {
  ws: WorkspaceApi;
  root: string;
  list: GitWorktree[];
}

async function repo(ctx: CommandContext): Promise<Repo> {
  const ws = workspace(ctx);
  const root = await local.repoRoot(ws.path);
  return { ws, root, list: await local.worktrees(root) };
}

/** A folder as given, made absolute: a relative one is taken from the folder that holds the main worktree. */
function resolveFolder(r: Repo, given: string): string {
  return path.resolve(path.dirname(r.list[0]?.path ?? r.root), given);
}

/**
 * A folder by its real path, as git lists worktrees: through junctions and links, and with Windows' long names in
 * place of 8.3 ones (`C:\Users\RUNNER~1`, as a temp folder can be given). As given when it does not exist.
 */
async function realFolder(folder: string): Promise<string> {
  return new Promise((resolve) => realpath.native(folder, (err, real) => resolve(err ? folder : real)));
}

/** The listed worktree at a folder, as given or by its real path. */
async function listedAt(list: GitWorktree[], folder: string): Promise<GitWorktree | undefined> {
  const found = list.find((w) => sameWorktreePath(w.path, folder));
  if (found) return found;
  const real = await realFolder(folder);
  return list.find((w) => sameWorktreePath(w.path, real));
}

/** The worktree at a folder as given, or a clear error when git lists none there. */
async function findWorktree(r: Repo, given: string): Promise<GitWorktree> {
  const target = resolveFolder(r, given);
  const found = await listedAt(r.list, target);
  if (!found) throw new QuiverError('NOT_FOUND', `${target} is not a worktree of this repository (see git.worktree.list)`, { reason: 'not-a-worktree' });
  return found;
}

/** A branch name for `-b` or to check out, never a refspec, a full ref name or HEAD. */
function branchName(name: string): string {
  local.requireBranchName(name);
  if (name.startsWith('refs/') || name === 'HEAD') throw new QuiverError('INVALID_INPUT', `${name} is not a branch name: give the name alone, as in "feature"`);
  return name;
}

const list = defineCommand({
  id: 'git.worktree.list',
  title: 'Git worktrees',
  description:
    'Every worktree of the repository, the main one first: its folder, the branch checked out (null when detached), HEAD, and whether it is bare, locked (with the reason), prunable (its folder is gone), the main worktree or the one this workspace is in (current).',
  scope: 'workspace',
  input: z.object({}),
  handler: async (_i, ctx): Promise<GitWorktree[]> => local.worktrees(workspace(ctx).path),
});

const add = defineCommand({
  id: 'git.worktree.add',
  title: 'Add git worktree',
  description:
    'Checks out a branch in a new folder of its own, beside the main worktree by default (<folder holding it>/<repository name>.worktrees/<branch, / as ->). Give one of branch (an existing branch, which must not be checked out in another worktree), newBranch (created at from, default HEAD) or detach (from, default HEAD, without a branch). A relative path is taken from the folder holding the main worktree; a folder inside another worktree, or one that is not empty, is refused. Gives back the new worktree.',
  scope: 'workspace',
  mutating: true,
  input: GitWorktreeAddInputSchema,
  handler: async ({ path: given, branch, newBranch, from, detach }, ctx): Promise<GitWorktree> => {
    const r = await repo(ctx);
    if ([branch, newBranch, detach ? 'detach' : undefined].filter(Boolean).length !== 1) {
      throw new QuiverError('INVALID_INPUT', 'Give one of branch (an existing branch), newBranch (a new one, at from) or detach');
    }
    if (branch && from) throw new QuiverError('INVALID_INPUT', `from goes with newBranch or detach; ${branch} is checked out where it points`);
    if (branch) {
      branchName(branch);
      const other = r.list.find((w) => w.branch === branch);
      if (other) throw new QuiverError('INVALID_INPUT', `${branch} is checked out in the worktree at ${other.path}; open that one instead`, { reason: 'checked-out-elsewhere', branch, path: other.path });
      const isLocal = (await local.git(r.root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { allowFailure: true })).code === 0;
      if (!isLocal) {
        // Git makes a local branch tracking `<remote>/<branch>` when exactly one remote has it.
        const remotes = (await local.git(r.root, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes'])).stdout.split(/\r?\n/).filter((n) => n.slice(n.indexOf('/') + 1) === branch);
        if (!remotes.length) throw new QuiverError('NOT_FOUND', `There is no branch ${branch}; give newBranch (and from) to start one`);
      }
    }
    if (newBranch) branchName(newBranch);
    let name = newBranch ?? branch ?? '';
    if (detach) {
      const short = await local.git(r.root, ['rev-parse', '--verify', '--quiet', '--short', `${from ?? 'HEAD'}^{commit}`], { allowFailure: true });
      if (short.code !== 0) throw new QuiverError('NOT_FOUND', `${from ?? 'HEAD'} is not a commit`);
      name = `detached-${short.stdout.trim()}`;
    }
    const target = given ? resolveFolder(r, given) : path.normalize(defaultWorktreePath(r.list[0]?.path ?? r.root, name));
    // Also by the real path of the folder it goes in, so a junction or link into a worktree does not get past.
    const realTarget = path.join(await realFolder(path.dirname(target)), path.basename(target));
    const inside = r.list.find((w) => isSameOrInside(target, w.path) || isSameOrInside(realTarget, w.path));
    if (inside) throw new QuiverError('INVALID_INPUT', `${target} is inside the worktree at ${inside.path}; pick a folder outside every worktree`, { reason: 'inside-worktree', path: inside.path });
    const stat = await fs.stat(target).catch(() => null);
    if (stat && !stat.isDirectory()) throw new QuiverError('INVALID_INPUT', `${target} is a file`, { reason: 'not-empty' });
    if (stat && (await fs.readdir(target)).length) throw new QuiverError('INVALID_INPUT', `${target} is not empty; pick a new or empty folder`, { reason: 'not-empty' });
    const args = ['worktree', 'add', ...(newBranch ? ['-b', newBranch] : []), ...(detach ? ['--detach'] : []), '--', target, ...(branch ? [branch] : from ? [from] : [])];
    try {
      await local.git(r.root, args, { timeoutMs: ADD_TIMEOUT_MS });
    } catch (err) {
      throw local.inOtherWorktree(err, 'open that one instead');
    } finally {
      // A failed add may still have made the branch.
      changed(ctx, r.ws, 'worktrees', 'branches');
    }
    const made = await listedAt(await local.worktrees(r.root), target);
    if (!made) throw new QuiverError('REQUEST_FAILED', `git did not list a worktree at ${target}`);
    return made;
  },
});

const remove = defineCommand({
  id: 'git.worktree.remove',
  title: 'Remove git worktree',
  description:
    'Deletes a linked worktree and its folder; the branch stays. Refuses the main worktree, the one this workspace is in, one open as a workspace, and a locked one (unlock it first). With changes or untracked files in it the call is refused (details.reason "dirty") unless force is true, which loses them. Gives back the worktrees left.',
  scope: 'workspace',
  mutating: true,
  input: GitWorktreeRemoveInputSchema,
  handler: async ({ path: given, force }, ctx): Promise<GitWorktree[]> => {
    const r = await repo(ctx);
    const wt = await findWorktree(r, given);
    if (wt.main) throw new QuiverError('INVALID_INPUT', `${wt.path} is the main worktree, the repository itself; it is not removed from here`, { reason: 'main-worktree' });
    if (wt.current) throw new QuiverError('INVALID_INPUT', `${wt.path} is the worktree this workspace is in; remove it from another worktree`, { reason: 'current-worktree' });
    // By real path too: a workspace may have been opened through a junction, or with the drive letter in another case.
    const workspaces = await Promise.all(ctx.host.workspaces.list().map(async (w) => ({ w, real: await realFolder(w.path) })));
    const open = workspaces.find(({ w, real }) => isSameOrInside(w.path, wt.path) || isSameOrInside(real, wt.path))?.w;
    if (open) throw new QuiverError('INVALID_INPUT', `${wt.path} is open as the workspace ${open.name}; close it first`, { reason: 'open-workspace' });
    if (wt.locked) throw new QuiverError('INVALID_INPUT', `${wt.path} is locked${wt.lockReason ? ` (${wt.lockReason})` : ''}; unlock it first`, { reason: 'locked' });
    const args = ['worktree', 'remove', ...(force ? ['--force'] : []), '--', wt.path];
    const result = await local.git(r.root, args, { allowFailure: true });
    if (result.code !== 0) {
      const err = local.gitFailure(args, result);
      if (/contains modified or untracked files/i.test(err.message)) throw new QuiverError('INVALID_INPUT', `${wt.path} has changes or untracked files; remove it with force to lose them`, { reason: 'dirty', path: wt.path });
      throw err;
    }
    changed(ctx, r.ws, 'worktrees', 'branches');
    return local.worktrees(r.root);
  },
});

const lock = defineCommand({
  id: 'git.worktree.lock',
  title: 'Lock git worktree',
  description: 'Locks a linked worktree, so prune and remove leave it alone (for one on a removable disk, say), with an optional reason. Gives back the worktrees.',
  scope: 'workspace',
  mutating: true,
  input: GitWorktreeLockInputSchema,
  handler: async ({ path: given, reason }, ctx): Promise<GitWorktree[]> => {
    const r = await repo(ctx);
    const wt = await findWorktree(r, given);
    if (wt.main) throw new QuiverError('INVALID_INPUT', 'The main worktree cannot be locked', { reason: 'main-worktree' });
    await local.git(r.root, ['worktree', 'lock', ...(reason ? [`--reason=${reason}`] : []), '--', wt.path]);
    changed(ctx, r.ws, 'worktrees');
    return local.worktrees(r.root);
  },
});

const unlock = defineCommand({
  id: 'git.worktree.unlock',
  title: 'Unlock git worktree',
  description: 'Unlocks a locked worktree. Gives back the worktrees.',
  scope: 'workspace',
  mutating: true,
  input: GitWorktreePathInputSchema,
  handler: async ({ path: given }, ctx): Promise<GitWorktree[]> => {
    const r = await repo(ctx);
    const wt = await findWorktree(r, given);
    await local.git(r.root, ['worktree', 'unlock', '--', wt.path]);
    changed(ctx, r.ws, 'worktrees');
    return local.worktrees(r.root);
  },
});

const prune = defineCommand({
  id: 'git.worktree.prune',
  title: 'Prune git worktrees',
  description: "Forgets the worktrees whose folder was deleted by hand (prunable in git.worktree.list), unless they are locked. pruned names git's record of each one removed; worktrees is the list left.",
  scope: 'workspace',
  mutating: true,
  input: z.object({}),
  handler: async (_i, ctx): Promise<{ pruned: string[]; worktrees: GitWorktree[] }> => {
    const r = await repo(ctx);
    // --verbose writes "Removing worktrees/<name>: <why>" to stderr for each.
    const result = await local.git(r.root, ['worktree', 'prune', '--verbose']);
    const pruned = [...local.output(result).matchAll(/^Removing worktrees\/(.+?): /gm)].map((m) => m[1]);
    changed(ctx, r.ws, 'worktrees', 'branches');
    return { pruned, worktrees: await local.worktrees(r.root) };
  },
});

const reveal = defineCommand({
  id: 'git.worktree.reveal',
  title: 'Reveal git worktree',
  description: "Opens a worktree's folder in the file manager; for the UI only.",
  scope: 'workspace',
  hidden: true,
  input: GitWorktreePathInputSchema,
  handler: async ({ path: given }, ctx): Promise<{ path: string; revealed: boolean }> => {
    if (ctx.caller !== 'ui') throw new QuiverError('INVALID_INPUT', 'Revealing a folder is only available from the UI');
    const wt = await findWorktree(await repo(ctx), given);
    // The host opens the path with the system's default handler, which runs a program: only ever a folder.
    if (!(await fs.stat(wt.path).catch(() => null))?.isDirectory()) throw new QuiverError('NOT_FOUND', `${wt.path} is not a folder (any more); prune the worktree`);
    await ctx.host.revealFolder?.(wt.path);
    return { path: wt.path, revealed: Boolean(ctx.host.revealFolder) };
  },
});

export const worktreeCommands: CommandDefinition[] = [list, add, remove, lock, unlock, prune, reveal];
