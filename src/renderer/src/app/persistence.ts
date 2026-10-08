import { DestroyRef, Service, effect, inject, untracked } from '@angular/core';
import { AppState, HostBridge, TabsState, TreeState, type Tab } from '@quiver/ui';

interface PersistedTabs {
  tabs: Tab[];
  activeTabId: string | null;
}

const TABS_KEY = 'ui.tabs';
const TREE_KEY = 'ui.tree';
const SAVE_DELAY = 400;

function stripDraft(data: Record<string, unknown>): Record<string, unknown> {
  if (!('draft' in data)) return data;
  const { draft: _draft, ...rest } = data;
  return rest;
}

/**
 * Each workspace's tabs and open sidebar nodes, kept per machine under `.quiver/local`: restored when
 * the workspace is shown for the first time, and written back (debounced) whenever they change.
 * Global-scope tabs are not persisted.
 */
@Service()
export class ShellPersistence {
  private readonly app = inject(AppState);
  private readonly host = inject(HostBridge);
  private readonly tabs = inject(TabsState);
  private readonly tree = inject(TreeState);
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor() {
    inject(DestroyRef).onDestroy(() => this.timers.forEach((t) => clearTimeout(t)));
    this.restoreTabs();
    this.saveTabs();
    this.restoreTree();
    this.saveTree();
  }

  private restoreTabs(): void {
    effect((onCleanup) => {
      const id = this.app.activeWorkspaceId();
      if (!id || untracked(() => this.tabs.scope(id)).hydrated) return;
      let cancelled = false;
      onCleanup(() => (cancelled = true));
      this.host
        .invoke<{ value: PersistedTabs | null }>('workspace.state.get', { key: TABS_KEY }, id)
        .then(({ value }) => {
          if (cancelled) return;
          // Drafts (history replays) are not persisted, so drop tabs that would load nothing.
          const tabs = (value?.tabs ?? []).filter((t) => !(t.type === 'api.request' && String(t.data?.['id'] ?? '').startsWith('history-')));
          this.tabs.hydrate(id, tabs, value?.activeTabId ?? null);
        })
        .catch(() => this.tabs.hydrate(id, [], null));
    });
  }

  private saveTabs(): void {
    const seen = new Map<string, unknown>();
    effect(() => {
      const scopes = this.tabs.scopes();
      const workspaces = this.app.workspaces();
      for (const [scope, data] of Object.entries(scopes)) {
        if (!data.hydrated || seen.get(scope) === data) continue;
        seen.set(scope, data);
        if (!workspaces.some((w) => w.id === scope)) continue;
        const persisted: PersistedTabs = {
          tabs: data.tabs.map((t) => ({ ...t, data: t.data ? stripDraft(t.data) : undefined, dirty: undefined })),
          activeTabId: data.activeTabId,
        };
        this.later(`tabs:${scope}`, () => this.host.invoke('workspace.state.set', { key: TABS_KEY, value: persisted }, scope));
      }
    });
  }

  private restoreTree(): void {
    effect((onCleanup) => {
      const id = this.app.activeWorkspaceId();
      if (!id || untracked(this.tree.scopes)[id]?.hydrated) return;
      let cancelled = false;
      onCleanup(() => (cancelled = true));
      this.host
        .invoke<{ value: Record<string, boolean> | null }>('workspace.state.get', { key: TREE_KEY }, id)
        .then(({ value }) => {
          if (!cancelled) this.tree.hydrate(id, value && typeof value === 'object' ? value : {});
        })
        .catch(() => this.tree.hydrate(id, {}));
    });
  }

  private saveTree(): void {
    const seen = new Map<string, unknown>();
    effect(() => {
      const scopes = this.tree.scopes();
      const workspaces = this.app.workspaces();
      for (const [scope, data] of Object.entries(scopes)) {
        // Saving before the stored state is loaded would overwrite it with a partial one.
        if (!data.hydrated || seen.get(scope) === data) continue;
        seen.set(scope, data);
        if (!workspaces.some((w) => w.id === scope)) continue;
        this.later(`tree:${scope}`, () => this.host.invoke('workspace.state.set', { key: TREE_KEY, value: data.expanded }, scope));
      }
    });
  }

  private later(key: string, save: () => Promise<unknown>): void {
    clearTimeout(this.timers.get(key));
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        void save().catch(() => {});
      }, SAVE_DELAY),
    );
  }
}
