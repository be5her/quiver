import { QuiverError, type QueueDriver } from '@quiver/core';

const notYet = (): never => {
  throw new QuiverError('NOT_SUPPORTED', 'kafka queues are not implemented yet');
};

// Lane Q1 replaces this stub.
export const kafkaDriver: QueueDriver = {
  kind: 'kafka',
  test: async () => notYet(),
  listDestinations: async () => notYet(),
  describe: async () => notYet(),
  peek: async () => notYet(),
  produce: async () => notYet(),
  consume: async () => notYet(),
};
