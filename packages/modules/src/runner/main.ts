import { defineModule } from '@quiver/core';
import { taskCommands } from './commands-tasks';
import { procCommands } from './commands-proc';

export const runnerModule = defineModule({
  id: 'runner',
  commands: [...taskCommands, ...procCommands],
});
