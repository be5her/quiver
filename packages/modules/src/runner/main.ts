import { defineModule, RunnerTaskSchema } from '@quiver/core';
import { taskCommands } from './commands-tasks';
import { procCommands } from './commands-proc';
import { procLifecycle } from './supervisor';
import { TASKS_COLLECTION } from './tasks';

export const runnerModule = defineModule({
  id: 'runner',
  collections: { [TASKS_COLLECTION]: RunnerTaskSchema },
  commands: [...taskCommands, ...procCommands],
  // Lane R1 adds its own lifecycle object here, if it needs one, rather than editing this one.
  ...procLifecycle,
});
