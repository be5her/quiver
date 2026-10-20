import {
  GitPrCheckoutInputSchema,
  GitPrChecksInputSchema,
  GitPrCommentInputSchema,
  GitPrCreateInputSchema,
  GitPrListInputSchema,
  GitPrRefInputSchema,
  QuiverError,
  defineCommand,
  type CommandContext,
  type CommandDefinition,
  type GhStatus,
  type GitDiffFile,
  type GitPrCheckWithLog,
  type GitPullRequest,
  type GitPullRequestDetail,
  type GitStatus,
  type WorkspaceApi,
} from '@quiver/core';
import { z } from 'zod';
import * as local from './local';
import * as pr from './pr';

// Lane G2: pull requests through the GitHub CLI, signed in as the user. Reads are open to agents; checking out,
// creating and commenting are mutating.

/** The refresh asks gh at most this often per workspace, however many views call it. */
const REFRESH_MIN_MS = 30_000;

function workspace(ctx: CommandContext): WorkspaceApi {
  if (!ctx.workspace) throw new QuiverError('NO_WORKSPACE', 'Open a workspace first');
  return ctx.workspace;
}

/** Per workspace: what the open pull requests looked like at the last refresh, and when that was. */
const lastSeen = new Map<string, { fingerprint: string | null; at: number }>();

/** Tell the views the pull requests changed. The next refresh takes a new baseline rather than announcing this change twice. */
function prsChanged(ctx: CommandContext, ws: WorkspaceApi): void {
  lastSeen.delete(ws.id);
  ctx.host.emit('git.changed', { workspaceId: ws.id, reason: 'prs' });
}

const status = defineCommand({
  id: 'git.pr.status',
  title: 'GitHub CLI status',
  description:
    'Whether pull requests can be used in this workspace: gh installed, signed in (and as whom), and the GitHub repository (owner/name) picked from the configured remotes. message says what to do when something is missing. Quiver uses the gh sign-in of the user and stores no token.',
  scope: 'workspace',
  input: z.object({}),
  handler: async (_i, ctx): Promise<GhStatus> => pr.status(workspace(ctx).path),
});

const list = defineCommand({
  id: 'git.pr.list',
  title: 'List pull requests',
  description:
    "Pull requests of the workspace's GitHub repository, newest first: number, title, state, draft, author, head and base branches, review decision, labels and a roll-up of the head commit's checks. filter: mine (authored by the signed-in user), review-requested (waiting on their review) or all; state: open (default), closed, merged or all.",
  scope: 'workspace',
  input: GitPrListInputSchema,
  handler: async (input, ctx): Promise<GitPullRequest[]> => pr.list(workspace(ctx).path, input),
});

const get = defineCommand({
  id: 'git.pr.get',
  title: 'Get pull request',
  description: 'One pull request with its description, line counts, changed files, reviews and conversation comments, plus everything git.pr.list gives.',
  scope: 'workspace',
  input: GitPrRefInputSchema,
  handler: async ({ number }, ctx): Promise<GitPullRequestDetail> => pr.get(workspace(ctx).path, number),
});

const checks = defineCommand({
  id: 'git.pr.checks',
  title: 'Pull request checks',
  description:
    "The CI checks on a pull request's head commit: name, workflow, state (pending, success, failure, skipped, neutral), link and times. failedLogs adds, for up to 5 failed GitHub Actions jobs, the last 60 lines of the failed steps' log (log, with ## <step> headings) or why it could not be read (logError).",
  scope: 'workspace',
  input: GitPrChecksInputSchema,
  handler: async ({ number, failedLogs }, ctx): Promise<GitPrCheckWithLog[]> => pr.checks(workspace(ctx).path, number, failedLogs),
});

const diff = defineCommand({
  id: 'git.pr.diff',
  title: 'Pull request diff',
  description: "A pull request's changes against its base, as git.diff gives them: per-file status, added/deleted line counts and unified patch (a patch over 512 KB is left out and the file marked truncated).",
  scope: 'workspace',
  input: GitPrRefInputSchema,
  handler: async ({ number }, ctx): Promise<GitDiffFile[]> => pr.diff(workspace(ctx).path, number),
});

const open = defineCommand({
  id: 'git.pr.open',
  title: 'Open pull request in browser',
  description: "Opens the pull request's page on GitHub in the user's browser.",
  scope: 'workspace',
  input: GitPrRefInputSchema,
  handler: async ({ number }, ctx): Promise<{ opened: true }> => {
    await pr.open(workspace(ctx).path, number);
    return { opened: true };
  },
});

const checkout = defineCommand({
  id: 'git.pr.checkout',
  title: 'Check out pull request',
  description:
    "Fetches a pull request's branch and switches to it, creating or updating a local branch. Fails rather than overwrite uncommitted changes. A pull request from a fork is refused unless allowFork is true, since its .quiver/ folder can start commands when the workspace next opens. Gives back the new git.status.",
  scope: 'workspace',
  mutating: true,
  input: GitPrCheckoutInputSchema,
  handler: async ({ number, allowFork }, ctx): Promise<GitStatus> => {
    const ws = workspace(ctx);
    const root = await pr.checkout(ws.path, number, { interactive: ctx.caller !== 'mcp', allowFork });
    for (const reason of ['status', 'branches'] as const) ctx.host.emit('git.changed', { workspaceId: ws.id, reason });
    return local.status(root);
  },
});

const create = defineCommand({
  id: 'git.pr.create',
  title: 'Create pull request',
  description:
    "Opens a pull request from the current branch, which must already be pushed (git.push with setUpstream), into base (default: the repository's default branch). draft opens it as a draft; labels must exist in the repository. Gives back the new pull request.",
  scope: 'workspace',
  mutating: true,
  input: GitPrCreateInputSchema,
  handler: async (input, ctx): Promise<GitPullRequest> => {
    const ws = workspace(ctx);
    const created = await pr.create(ws.path, input);
    prsChanged(ctx, ws);
    return created;
  },
});

const comment = defineCommand({
  id: 'git.pr.comment',
  title: 'Comment on pull request',
  description: "Adds a comment (Markdown) to a pull request's conversation, as the signed-in user. Gives back the comment's address.",
  scope: 'workspace',
  mutating: true,
  input: GitPrCommentInputSchema,
  handler: async ({ number, body }, ctx): Promise<{ url: string }> => {
    const ws = workspace(ctx);
    const result = await pr.comment(ws.path, number, body);
    prsChanged(ctx, ws);
    return result;
  },
});

/**
 * Polling, driven by the view: while the pull requests are on screen it calls this every 60 seconds. The host asks gh
 * for a fingerprint of the open pull requests (at most every 30s per workspace, however many views ask) and emits
 * `git.changed` with reason `prs` when it differs from the last one, so every view reloads only when something
 * changed, and nothing runs while no view is open.
 */
const refresh = defineCommand({
  id: 'git.pr.refresh',
  title: 'Refresh pull requests',
  description: 'Checks whether the open pull requests changed since the last refresh, and if so emits git.changed with reason prs. force skips the 30-second limit (a refresh button).',
  scope: 'workspace',
  hidden: true,
  input: z.object({ force: z.boolean().default(false) }),
  handler: async ({ force }, ctx): Promise<{ changed: boolean; error?: string }> => {
    const ws = workspace(ctx);
    const seen = lastSeen.get(ws.id);
    if (seen && !force && Date.now() - seen.at < REFRESH_MIN_MS) return { changed: false };
    lastSeen.set(ws.id, { fingerprint: seen?.fingerprint ?? null, at: Date.now() });
    let fingerprint: string;
    try {
      fingerprint = await pr.fingerprint(ws.path);
    } catch (err) {
      // gh missing or signed out: the view shows git.pr.status; the refresh just has nothing to compare.
      return { changed: false, error: (err as Error).message };
    }
    const changed = seen?.fingerprint != null && seen.fingerprint !== fingerprint;
    lastSeen.set(ws.id, { fingerprint, at: Date.now() });
    if (changed) ctx.host.emit('git.changed', { workspaceId: ws.id, reason: 'prs' });
    return { changed };
  },
});

export const prCommands: CommandDefinition[] = [status, list, get, checks, diff, open, checkout, create, comment, refresh];
