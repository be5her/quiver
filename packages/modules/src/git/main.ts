import { defineModule } from '@quiver/core';
import { blameCommands } from './commands-blame';
import { conflictCommands } from './commands-conflict';
import { draftCommands } from './commands-draft';
import { localCommands, localLifecycle } from './commands-local';
import { manageCommands } from './commands-manage';
import { prCommands } from './commands-pr';

export const gitModule = defineModule({
  id: 'git',
  commands: [...localCommands, ...manageCommands, ...prCommands, ...draftCommands, ...blameCommands, ...conflictCommands],
  ...localLifecycle,
});
