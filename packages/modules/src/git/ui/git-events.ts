import { DestroyRef, effect, inject, untracked } from '@angular/core';
import type { HostEvents } from '@quiver/core';
import { AppState, HostBridge, TabsState, injectHostEvent, type Tab } from '@quiver/ui';

export type GitChanged = HostEvents['git.changed'];

/** `git.changed` of the workspace on screen only: another open repository's commits must not reload this one's views. */
export function injectGitChanged(listener: (p: GitChanged) => void): void {
  const app = inject(AppState);
  injectHostEvent('git.changed', (p) => {
    if (p.workspaceId === untracked(app.activeWorkspaceId)) listener(p);
  });
}

/** How often the pull requests are checked while a view of them is on screen. */
const PR_POLL_MS = 60_000;

/**
 * While `visible` holds, ask the host every minute whether the open pull requests changed (`git.pr.refresh`); it
 * answers with `git.changed{prs}` when they did, which reloads the views. Nothing runs while no view is on screen.
 */
export function injectPrPolling(visible: () => boolean): void {
  const host = inject(HostBridge);
  let timer: ReturnType<typeof setInterval> | null = null;
  const refresh = () => void host.invoke('git.pr.refresh', {}).catch(() => {});
  effect(() => {
    const on = visible();
    if (on && !timer) {
      refresh();
      timer = setInterval(() => document.visibilityState === 'visible' && refresh(), PR_POLL_MS);
    } else if (!on && timer) {
      clearInterval(timer);
      timer = null;
    }
  });
  inject(DestroyRef).onDestroy(() => {
    if (timer) clearInterval(timer);
  });
}

/** Whether a tab is the one on screen: active in its scope, and its scope is the workspace shown. */
export function tabVisible(tab: () => Tab, scope: () => string): () => boolean {
  const app = inject(AppState);
  const tabs = inject(TabsState);
  return () => app.scope() === scope() && tabs.scope(scope()).activeTabId === tab().id;
}
