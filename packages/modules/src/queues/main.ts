import { defineModule } from '@quiver/core';
import { queueCommands } from './commands';

export const queuesModule = defineModule({
  id: 'queues',
  commands: [...queueCommands],
});
