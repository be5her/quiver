import { defineModule } from '@quiver/core';
import { closeQueues, consumers, queueCommands } from './commands';

export const queuesModule = defineModule({
  id: 'queues',
  commands: [...queueCommands],
  onWorkspaceClose: (workspace) => closeQueues(workspace),
  onStop: () => consumers.stopAll(),
});
