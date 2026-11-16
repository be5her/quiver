import { AsyncLocalStorage } from 'node:async_hooks';
import { GitHubLoginSchema, githubAccountGitEnv, type CommandDefinition, type WorkspaceApi } from '@quiver/core';

// The GitHub account a workspace works as. With several accounts signed in on one machine, Git Credential Manager
// asks which one to use on every network call and gh uses whichever account `gh auth switch` last chose; a workspace
// that names its account gets that one for every git and gh process Quiver starts for it, through the environment of
// that process only: no config file and no global sign-in changes, so other repositories and terminals are untouched.

/** Workspace state key (per machine, `.quiver/local/state.json`): the accounts are this machine's gh sign-ins. */
export const ACCOUNT_STATE_KEY = 'git.githubAccount';

const current = new AsyncLocalStorage<string | null>();

/** The account a workspace chose, or null. A value that is not a GitHub login (state edited by hand) counts as none. */
export async function accountOf(ws: WorkspaceApi): Promise<string | null> {
  const value = await ws.getState<unknown>(ACCOUNT_STATE_KEY, null);
  return GitHubLoginSchema.safeParse(value).success ? (value as string) : null;
}

/** The account of the command under way, or null when its workspace chose none. */
export function currentAccount(): string | null {
  return current.getStore() ?? null;
}

/** Run `fn`, and every git and gh it starts, as `account`. */
export function withAccount<T>(account: string | null, fn: () => T): T {
  return current.run(account, fn);
}

/** For a git process of the command under way: the credential username of its account, or nothing. */
export function accountGitEnv(): Record<string, string> {
  const account = currentAccount();
  return account ? githubAccountGitEnv(account, process.env) : {};
}

/** The commands, each running as its workspace's account. */
export function asWorkspaceAccount(commands: CommandDefinition[]): CommandDefinition[] {
  return commands.map((command) => ({
    ...command,
    handler: async (input, ctx) => (ctx.workspace ? withAccount(await accountOf(ctx.workspace), () => command.handler(input, ctx)) : command.handler(input, ctx)),
  }));
}
