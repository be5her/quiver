import type { SmokeSection } from '../../part';

// The Git panel. Owned by the UI lane.
const section: SmokeSection = async ({ check }) => ({
  ui: async ({ js, wait }) => {
    await js(`document.querySelector('[data-testid=activity-item][data-drag-id=git]').click()`);
    await wait(300);
    const shown = await js(`Boolean(document.querySelector('q-git-sidebar'))`);
    check('git: the activity bar opens the Git sidebar', shown === true);
  },
});

export default section;
