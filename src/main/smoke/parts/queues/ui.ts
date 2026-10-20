import type { SmokeSection } from '../../part';

// The Queues panel. Owned by the UI lane.
const section: SmokeSection = async ({ check }) => ({
  ui: async ({ js, wait }) => {
    await js(`document.querySelector('[data-testid=activity-item][data-drag-id=queues]').click()`);
    await wait(300);
    const shown = await js(`Boolean(document.querySelector('q-queues-sidebar'))`);
    check('queues: the activity bar opens the Queues sidebar', shown === true);
  },
});

export default section;
