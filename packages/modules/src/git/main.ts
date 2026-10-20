import { defineModule } from '@quiver/core';
import { localCommands } from './commands-local';
import { prCommands } from './commands-pr';

export const gitModule = defineModule({
  id: 'git',
  commands: [...localCommands, ...prCommands],
});
