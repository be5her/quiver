import { defineModule } from '@quiver/core';
import { conflictCommands } from './commands-conflict';
import { localCommands, localLifecycle } from './commands-local';
import { manageCommands } from './commands-manage';
import { prCommands } from './commands-pr';

export const gitModule = defineModule({
  id: 'git',
  commands: [...localCommands, ...manageCommands, ...prCommands, ...conflictCommands],
  ...localLifecycle,
});
