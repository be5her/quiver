import { defineModule } from '@quiver/core';
import { taskCommands } from './commands-tasks';
import { procCommands } from './commands-proc';
import { procLifecycle } from './supervisor';

export const runnerModule = defineModule({
  id: 'runner',
  commands: [...taskCommands, ...procCommands],
  // Lane R1 adds its own lifecycle object here, if it needs one, rather than editing this one.
  ...procLifecycle,
});
