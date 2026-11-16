import { existsSync } from 'node:fs';
import {
  GitBranchPushInputSchema,
  GitBranchSyncInputSchema,
  QuiverError,
  defineCommand,
  planBranchSync,
  remotesToFetch,
  type BranchTracking,
  type CommandContext,
  type CommandDefinition,
  type GitBranchSyncItem,
  type GitBranchSyncResult,
} from '@quiver/core';
import { changed, interactive, workspace } from './commands-local';
import * as local from './local';

// Pulling and pushing branches other than the current one. A branch that is not checked out is fast-forwarded by
// moving its ref (`git fetch . <upstream>:<branch>`, which only ever fast-forwards and which git refuses for a branch
// checked out anywhere); the current branch with `merge --ff-only`, which leaves uncommitted changes alone or refuses;
// one checked out in another worktree the same way, in that worktree. Nothing here merges or rebases: a branch whose
// upstream has commits it lacks while it has commits of its own is reported as diverged, for a pull on the branch itself.

/** The local branches named, in that order, or every one tracking a branch that still exists on its remote. */
function pick(all: BranchTracking[], names: string[] | undefined): BranchTracking[] {
  if (!names) return all.filter((b) => b.upstream && !b.gone);
  return names.map((name) => {
    local.requireBranchName(name);
    const found = all.find((b) => b.name === name);
    if (!found) throw new QuiverError('INVALID_INPUT', `${name} is not a local branch${all.length ? '' : '; this repository has none yet'}`, { reason: 'no-branch', name });
    return found;
  });
}

/** A git failure for a branch's `message`. */
function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Fast-forwards a branch to its upstream: in the worktree it is checked out in, when there is one, else by moving the
 * ref. Gives what git printed.
 */
async function fastForward(root: string, b: BranchTracking): Promise<string> {
  const upstream = b.upstream!;
  const where = b.current ? root : b.worktreePath;
  if (where) {
    if (!existsSync(where)) throw new QuiverError('INVALID_INPUT', `${b.name} is checked out in the worktree at ${where}, which is missing; prune it or open that folder`);
    const state = await local.status(where, { files: false });
    if (state.operation) throw new QuiverError('INVALID_INPUT', `a ${state.operation} is in progress${b.current ? '' : ` in the worktree at ${where}`}; finish or abort it first`);
    // The list was read before the fetch; had the worktree switched to another branch since, the merge would move that one.
    if (state.branch !== b.name) throw new QuiverError('INVALID_INPUT', `${where} has switched to ${state.branch ?? 'a detached HEAD'} since; pull again`);
    return local.output(await local.git(where, ['merge', '--ff-only', upstream.ref], { env: local.NO_EDITOR_ENV }));
  }
  return local.output(await local.git(root, ['fetch', '--no-tags', '--no-prune', '.', `${upstream.ref}:refs/heads/${b.name}`]));
}

/**
 * Fetches the remotes the branches track, then fast-forwards each one that is only behind and, with `push`, pushes
 * each one that is only ahead. A failure on one branch is reported in its item and the others go on; a fetch that
 * fails stops it all, since nothing after it would be up to date.
 */
async function syncBranches(ctx: CommandContext, names: string[] | undefined, push: boolean): Promise<GitBranchSyncResult> {
  const ws = workspace(ctx);
  const root = await local.repoRoot(ws.path);
  const targets = pick(await local.tracking(root), names);
  const fetched = remotesToFetch(targets);
  const printed: string[] = [];
  const items: GitBranchSyncItem[] = [];
  try {
    for (const remote of fetched) {
      await local.requireRemote(root, remote);
      printed.push(local.output(await local.network(root, ['fetch', '--prune', remote], interactive(ctx))));
    }
    // Ahead and behind as the fetch left them.
    const after = new Map((await local.tracking(root)).map((b) => [b.name, b]));
    for (const before of targets) {
      const b = after.get(before.name) ?? before;
      const plan = planBranchSync(b, push);
      const target = b.push;
      const item: GitBranchSyncItem = {
        name: b.name,
        ...(b.upstream ? { upstream: b.upstream.short } : {}),
        outcome: plan === 'fast-forward' ? 'updated' : plan === 'push' ? 'pushed' : plan,
        // What is pushed counts against the push target (a first push: everything ahead of the upstream).
        ahead: plan === 'push' && target?.exists ? target.ahead : b.ahead,
        behind: b.behind,
        ...(target ? { pushTarget: target.short } : {}),
        ...(b.worktreePath ? { worktreePath: b.worktreePath } : {}),
      };
      if (push && plan === 'ahead' && !target && b.upstream) {
        item.message = `git would not push it: it tracks ${b.upstream.short}, a branch of another name (push.default). Push it to publish it under its own name`;
      } else if (push && plan === 'diverged' && !(b.ahead && b.behind) && target) {
        item.message = `${target.short}, where it is pushed, has commits it does not`;
      }
      try {
        if (plan === 'fast-forward') {
          printed.push(await fastForward(root, b));
          Object.assign(item, { from: b.head, to: (await local.git(root, ['rev-parse', '--verify', `refs/heads/${b.name}`])).stdout.trim() });
        } else if (plan === 'push' && target) {
          // Where `git push` itself would send it, never to an upstream of another name.
          printed.push(local.output(await local.network(root, ['push', target.remote, `refs/heads/${b.name}:refs/heads/${target.branch}`], interactive(ctx))));
        }
      } catch (err) {
        Object.assign(item, { outcome: 'failed', message: reason(err) });
      }
      items.push(item);
    }
  } finally {
    changed(ctx, ws, 'branches', 'status');
  }
  return { branches: items, fetched, output: printed.filter(Boolean).join('\n'), status: await local.status(root) };
}

const branchPull = defineCommand({
  id: 'git.branch.pull',
  title: 'Pull git branches',
  description:
    'Brings local branches up to date with their upstreams without switching to them: fetches their remotes, then fast-forwards each branch that is only behind (names, or every branch tracking a branch that still exists). One that is not checked out moves without touching any file; the current one, or one checked out in another worktree, is fast-forwarded there and git refuses if uncommitted changes are in the way. Never merges or rebases: a branch with commits of its own and new ones upstream comes back "diverged". Each branch gets an outcome: updated, up-to-date, ahead (commits to push), diverged, no-upstream, gone (deleted on the remote) or failed with git\'s message.',
  scope: 'workspace',
  mutating: true,
  input: GitBranchSyncInputSchema,
  handler: async ({ names }, ctx): Promise<GitBranchSyncResult> => syncBranches(ctx, names, false),
});

const branchSync = defineCommand({
  id: 'git.branch.sync',
  title: 'Sync git branches',
  description:
    'git.branch.pull, and then pushes each branch that is not behind and has commits its push target lacks (outcome "pushed"), without switching to it. The push target is where a plain `git push` of it would go (push.default, pushRemote): a branch tracking one of another name (made from origin/main) is never pushed there, and comes back "ahead" with a message. A diverged branch is neither pulled nor pushed, and nothing is ever force pushed.',
  scope: 'workspace',
  mutating: true,
  input: GitBranchSyncInputSchema,
  handler: async ({ names }, ctx): Promise<GitBranchSyncResult> => syncBranches(ctx, names, true),
});

const branchPush = defineCommand({
  id: 'git.branch.push',
  title: 'Push git branch',
  description:
    'Pushes a local branch, current or not, where a plain `git push` of it would go (push.default, pushRemote, remote.pushDefault): usually its upstream of the same name. A branch tracking one of another name (made from origin/main) has no such place and is refused (details.reason "no-push-target") rather than pushed there, as is one whose upstream was deleted on the remote ("gone"); publish: true pushes it under its own name to origin (or its push remote) and tracks that from then on, which is also what happens to a branch with no upstream. forceWithLease overwrites the remote branch only if it is where it was last fetched.',
  scope: 'workspace',
  mutating: true,
  actions: {
    list: ['push', 'force'],
    of: ({ forceWithLease }) => (forceWithLease ? 'force' : 'push'),
    describe: { push: 'A plain push, which the remote refuses unless it fast-forwards', force: 'A push with forceWithLease, which can overwrite commits on the remote branch' },
  },
  input: GitBranchPushInputSchema,
  handler: async ({ name, forceWithLease, publish }, ctx): Promise<local.GitRemoteResult> => {
    const ws = workspace(ctx);
    const root = await local.repoRoot(ws.path);
    const [b] = pick(await local.tracking(root), [name]);
    const lease = forceWithLease ? ['--force-with-lease'] : [];
    let args: string[];
    let remote: string;
    if (publish || !b.upstream) {
      remote = b.push?.remote ?? 'origin';
      args = ['push', '--set-upstream', ...lease, remote, `refs/heads/${name}:refs/heads/${name}`];
    } else if (b.gone) {
      throw new QuiverError('INVALID_INPUT', `${b.upstream.short}, which ${name} tracks, was deleted on the remote; pushing would bring it back. Publish it to push it anyway`, { reason: 'gone' });
    } else if (!b.push) {
      const why = b.upstream.remote === '.' ? `tracks the local branch ${b.upstream.short}` : `tracks ${b.upstream.short}, a branch of another name`;
      throw new QuiverError('INVALID_INPUT', `git would not push ${name} anywhere: it ${why}. Publish it to push it under its own name`, { reason: 'no-push-target', upstream: b.upstream.short });
    } else {
      remote = b.push.remote;
      args = ['push', ...lease, remote, `refs/heads/${name}:refs/heads/${b.push.branch}`];
    }
    try {
      return await local.remoteOp(root, args, remote, interactive(ctx));
    } finally {
      changed(ctx, ws, 'branches', 'status');
    }
  },
});

export const syncCommands: CommandDefinition[] = [branchPull, branchSync, branchPush];
