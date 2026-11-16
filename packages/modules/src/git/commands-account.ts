import { GitAccountSetInputSchema, QuiverError, defineCommand, type CommandContext, type CommandDefinition, type GhAccount, type GitAccountInfo, type WorkspaceApi } from '@quiver/core';
import { z } from 'zod';
import { ACCOUNT_STATE_KEY, accountOf } from './account';
import * as pr from './pr';

// The GitHub account a workspace's git and gh calls use (account.ts). Reading it is open to agents; changing it is
// mutating, since it decides who pushes and comments.

function workspace(ctx: CommandContext): WorkspaceApi {
  if (!ctx.workspace) throw new QuiverError('NO_WORKSPACE', 'Open a workspace first');
  return ctx.workspace;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

const get = defineCommand({
  id: 'git.account.get',
  title: 'GitHub account of this workspace',
  description:
    "The github.com account this workspace's git and gh calls use (account; null: gh's active account, and whichever account Git Credential Manager picks or asks for), and the accounts gh is signed in to there (accounts, gh's active one marked). Every fetch, pull, push and pull request call of the workspace, and every Runner task started in it, runs as that account, through its own process environment only. message says what is wrong: gh missing, or the account not signed in to gh.",
  scope: 'workspace',
  input: z.object({
    accounts: z.boolean().default(true).describe("false: the chosen account only, without asking gh for its accounts (gh checks each one over the network)"),
  }),
  handler: async (i, ctx): Promise<GitAccountInfo> => {
    const ws = workspace(ctx);
    const account = await accountOf(ws);
    if (!i.accounts) return { account, accounts: [] };
    let accounts: GhAccount[] = [];
    let message: string | undefined;
    try {
      accounts = await pr.accounts(ws.path);
    } catch (err) {
      message = (err as Error).message;
    }
    if (!message && account && !accounts.some((a) => same(a.login, account))) {
      message = `gh is not signed in to github.com as ${account}. Run "gh auth login" in a terminal and sign in as ${account}, or pick another account.`;
    }
    return { account, accounts, ...(message ? { message } : {}) };
  },
});

const set = defineCommand({
  id: 'git.account.set',
  title: 'Set the GitHub account of this workspace',
  description:
    "Choose the github.com account this workspace's git and gh calls (and Runner tasks) use: one of the accounts gh is signed in to (git.account.get), or null for gh's active account. Kept per machine, for this workspace only; nothing else that runs git or gh is affected.",
  scope: 'workspace',
  mutating: true,
  input: GitAccountSetInputSchema,
  handler: async ({ account }, ctx): Promise<GitAccountInfo> => {
    const ws = workspace(ctx);
    const accounts = await pr.accounts(ws.path);
    let chosen: string | null = null;
    if (account) {
      // Kept as gh spells it, since `gh auth token --user` looks it up that way.
      chosen = accounts.find((a) => same(a.login, account))?.login ?? null;
      if (!chosen) {
        const signedIn = accounts.map((a) => a.login).join(', ');
        throw new QuiverError(
          'INVALID_INPUT',
          `gh is not signed in to github.com as ${account}${signedIn ? ` (it is as ${signedIn})` : ''}. Run "gh auth login" in a terminal and sign in as ${account} first.`,
          { reason: 'unknown-account' },
        );
      }
    }
    await ws.setState(ACCOUNT_STATE_KEY, chosen);
    // The pull request views read again, as the new account.
    ctx.host.emit('git.changed', { workspaceId: ws.id, reason: 'prs' });
    return { account: chosen, accounts };
  },
});

export const accountCommands: CommandDefinition[] = [get, set];
