import { defineModule, QueueConnectionSchema } from '@quiver/core';
import { closeQueues, QUEUES_COLLECTION, queueCommands, stopQueues } from './commands';

export const queuesModule = defineModule({
  id: 'queues',
  collections: { [QUEUES_COLLECTION]: QueueConnectionSchema },
  commands: [...queueCommands],
  onWorkspaceClose: (workspace) => closeQueues(workspace),
  onStop: () => stopQueues(),
});
