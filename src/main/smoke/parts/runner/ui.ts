import type { SmokeSection } from '../../part';

// The Runner panel. Owned by the UI lane.
const section: SmokeSection = async ({ check }) => ({
  ui: async ({ js, wait }) => {
    await js(`document.querySelector('[data-testid=activity-item][data-drag-id=runner]').click()`);
    await wait(300);
    const shown = await js(`Boolean(document.querySelector('q-runner-sidebar'))`);
    check('runner: the activity bar opens the Runner sidebar', shown === true);
  },
});

export default section;
