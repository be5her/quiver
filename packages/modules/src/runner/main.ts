import { defineModule } from '@quiver/core';
import { taskCommands } from './commands-tasks';
import { procCommands } from './commands-proc';
import { onStop, onWorkspaceClose } from './supervisor';

export const runnerModule = defineModule({
  id: 'runner',
  commands: [...taskCommands, ...procCommands],
  onWorkspaceClose,
  onStop,
});
