import { inject, untracked } from '@angular/core';
import type { HostEvents } from '@quiver/core';
import { AppState, injectHostEvent } from '@quiver/ui';

export type RunnerChanged = HostEvents['runner.changed'];

/**
 * `runner.changed` of the workspace on screen only. Two checkouts of one project share the committed task ids, so an
 * event from the other one must not reload (or read output) here.
 */
export function injectRunnerChanged(listener: (p: RunnerChanged) => void): void {
  const app = inject(AppState);
  injectHostEvent('runner.changed', (p) => {
    if (p.workspaceId === untracked(app.activeWorkspaceId)) listener(p);
  });
}
