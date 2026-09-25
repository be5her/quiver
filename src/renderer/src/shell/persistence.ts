import { invoke, useAppStore, useTabsStore, type Tab } from '@quiver/ui';
import { useEffect } from 'react';

interface PersistedTabs {
  tabs: Tab[];
  activeTabId: string | null;
}

const STATE_KEY = 'ui.tabs';

/**
 * Restores a workspace's tabs when it becomes active for the first time, and
 * writes them back (debounced) whenever they change. Global-scope tabs are not persisted.
 */
export function useTabPersistence(): void {
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId);
  const workspaces = useAppStore((s) => s.workspaces);

  useEffect(() => {
    if (!activeWorkspaceId) return;
    if (useTabsStore.getState().scopes[activeWorkspaceId]?.hydrated) return;
    let cancelled = false;
    invoke<{ value: PersistedTabs | null }>('workspace.state.get', { key: STATE_KEY }, activeWorkspaceId)
      .then(({ value }) => {
        if (cancelled) return;
        // Drafts (history replays) are not persisted, so drop tabs that would load nothing.
        const tabs = (value?.tabs ?? []).filter((t) => !(t.type === 'api.request' && String(t.data?.id ?? '').startsWith('history-')));
        useTabsStore.getState().hydrate(activeWorkspaceId, tabs, value?.activeTabId ?? null);
      })
      .catch(() => useTabsStore.getState().hydrate(activeWorkspaceId, [], null));
    return () => {
      cancelled = true;
    };
  }, [activeWorkspaceId]);

  useEffect(() => {
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const unsubscribe = useTabsStore.subscribe((state, prev) => {
      for (const [scope, data] of Object.entries(state.scopes)) {
        if (!data.hydrated || data === prev.scopes[scope]) continue;
        if (!workspaces.some((w) => w.id === scope)) continue;
        clearTimeout(timers.get(scope));
        timers.set(
          scope,
          setTimeout(() => {
            const persisted: PersistedTabs = {
              tabs: data.tabs.map((t) => ({ ...t, data: t.data ? stripDraft(t.data) : undefined, dirty: undefined })),
              activeTabId: data.activeTabId,
            };
            void invoke('workspace.state.set', { key: STATE_KEY, value: persisted }, scope).catch(() => {});
          }, 400),
        );
      }
    });
    return () => {
      unsubscribe();
      timers.forEach((t) => clearTimeout(t));
    };
  }, [workspaces]);
}

function stripDraft(data: Record<string, unknown>): Record<string, unknown> {
  if (!('draft' in data)) return data;
  const { draft: _draft, ...rest } = data;
  return rest;
}
