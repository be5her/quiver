import { defineModule } from '@quiver/core';
import { asWorkspaceAccount } from './account';
import { accountCommands } from './commands-account';
import { blameCommands } from './commands-blame';
import { conflictCommands } from './commands-conflict';
import { draftCommands } from './commands-draft';
import { localCommands, localLifecycle } from './commands-local';
import { manageCommands } from './commands-manage';
import { prCommands } from './commands-pr';
import { worktreeCommands } from './commands-worktree';

export const gitModule = defineModule({
  id: 'git',
  // Every command runs as the GitHub account its workspace chose (account.ts), down to each git and gh it starts.
  commands: asWorkspaceAccount([...accountCommands, ...localCommands, ...manageCommands, ...prCommands, ...draftCommands, ...blameCommands, ...conflictCommands, ...worktreeCommands]),
  ...localLifecycle,
});
