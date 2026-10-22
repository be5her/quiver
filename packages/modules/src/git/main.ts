import { defineModule } from '@quiver/core';
import { localCommands, localLifecycle } from './commands-local';
import { manageCommands } from './commands-manage';
import { prCommands } from './commands-pr';
import { worktreeCommands } from './commands-worktree';

export const gitModule = defineModule({
  id: 'git',
  commands: [...localCommands, ...manageCommands, ...prCommands, ...worktreeCommands],
  ...localLifecycle,
});
