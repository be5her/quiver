import { QuiverError, type QueueDriver } from '@quiver/core';

const notYet = (): never => {
  throw new QuiverError('NOT_SUPPORTED', 'rabbit queues are not implemented yet');
};

// Lane Q3 replaces this stub.
export const rabbitDriver: QueueDriver = {
  kind: 'rabbit',
  test: async () => notYet(),
  listDestinations: async () => notYet(),
  describe: async () => notYet(),
  peek: async () => notYet(),
  produce: async () => notYet(),
  consume: async () => notYet(),
};
