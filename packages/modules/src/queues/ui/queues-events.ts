import { inject, untracked } from '@angular/core';
import type { HostEvents } from '@quiver/core';
import { AppState, injectHostEvent } from '@quiver/ui';

export type QueuesChanged = HostEvents['queues.changed'];

/**
 * `queues.changed` of the workspace on screen only. Two checkouts of one project share the committed connection ids,
 * so an event from the other one must not reload (or peek) anything here.
 */
export function injectQueuesChanged(listener: (p: QueuesChanged) => void): void {
  const app = inject(AppState);
  injectHostEvent('queues.changed', (p) => {
    if (p.workspaceId === untracked(app.activeWorkspaceId)) listener(p);
  });
}

/** Whether an event is about this topic or queue: it names it, or names none (secrets, history, a whole connection). */
export function concernsDestination(p: QueuesChanged, connectionId: string, destination: string): boolean {
  return p.connectionId === connectionId && (p.destination === undefined || p.destination === destination);
}
