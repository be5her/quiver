import { defineModule } from '@quiver/core';
import { closeQueues, queueCommands, stopQueues } from './commands';

export const queuesModule = defineModule({
  id: 'queues',
  commands: [...queueCommands],
  onWorkspaceClose: (workspace) => closeQueues(workspace),
  onStop: () => stopQueues(),
});
