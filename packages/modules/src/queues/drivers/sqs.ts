import { QuiverError, type QueueDriver } from '@quiver/core';

const notYet = (): never => {
  throw new QuiverError('NOT_SUPPORTED', 'sqs queues are not implemented yet');
};

// Lane Q2 replaces this stub.
export const sqsDriver: QueueDriver = {
  kind: 'sqs',
  test: async () => notYet(),
  listDestinations: async () => notYet(),
  describe: async () => notYet(),
  peek: async () => notYet(),
  produce: async () => notYet(),
  consume: async () => notYet(),
};
