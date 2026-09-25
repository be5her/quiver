import { newId } from '@quiver/core';
import { create } from 'zustand';

export interface Tab {
  id: string;
  /** Registered by a module (or the shell) as `<module>.<kind>`. */
  type: string;
  title: string;
  /** Free-form payload the tab component reads, e.g. `{ requestId }`. */
  data?: Record<string, unknown>;
  dirty?: boolean;
}

export interface TabScope {
  tabs: Tab[];
  activeTabId: string | null;
  /** Whether persisted tabs were restored for this scope. */
  hydrated: boolean;
}

interface TabsState {
  scopes: Record<string, TabScope>;
  openTab(scope: string, tab: Omit<Tab, 'id'> & { id?: string }, options?: { singletonKey?: string }): Tab;
  closeTab(scope: string, id: string): void;
  closeOthers(scope: string, id: string): void;
  closeAll(scope: string): void;
  setActiveTab(scope: string, id: string | null): void;
  updateTab(scope: string, id: string, patch: Partial<Tab>): void;
  hydrate(scope: string, tabs: Tab[], activeTabId: string | null): void;
  /** Close tabs of the given type whose data matches, e.g. after deleting the underlying item. */
  closeWhere(scope: string, predicate: (tab: Tab) => boolean): void;
}

/** Shared frozen instance: selectors must return a stable reference for missing scopes. */
const EMPTY_SCOPE: TabScope = Object.freeze({ tabs: [], activeTabId: null, hydrated: false }) as TabScope;
const emptyScope = (): TabScope => EMPTY_SCOPE;

function withScope(state: TabsState, scope: string, fn: (s: TabScope) => TabScope): Partial<TabsState> {
  const current = state.scopes[scope] ?? emptyScope();
  return { scopes: { ...state.scopes, [scope]: fn(current) } };
}

export const useTabsStore = create<TabsState>((set, get) => ({
  scopes: {},

  openTab: (scope, tab, options) => {
    const current = get().scopes[scope] ?? emptyScope();
    if (options?.singletonKey) {
      const existing = current.tabs.find((t) => singletonKey(t) === options.singletonKey);
      if (existing) {
        set((s) => withScope(s, scope, (sc) => ({ ...sc, activeTabId: existing.id })));
        return existing;
      }
    }
    const created: Tab = { ...tab, id: tab.id ?? newId() };
    set((s) => withScope(s, scope, (sc) => ({ ...sc, tabs: [...sc.tabs, created], activeTabId: created.id })));
    return created;
  },

  closeTab: (scope, id) =>
    set((s) =>
      withScope(s, scope, (sc) => {
        const index = sc.tabs.findIndex((t) => t.id === id);
        if (index < 0) return sc;
        const tabs = sc.tabs.filter((t) => t.id !== id);
        let activeTabId = sc.activeTabId;
        if (activeTabId === id) activeTabId = tabs[Math.min(index, tabs.length - 1)]?.id ?? null;
        return { ...sc, tabs, activeTabId };
      }),
    ),

  closeOthers: (scope, id) =>
    set((s) => withScope(s, scope, (sc) => ({ ...sc, tabs: sc.tabs.filter((t) => t.id === id), activeTabId: id }))),

  closeAll: (scope) => set((s) => withScope(s, scope, (sc) => ({ ...sc, tabs: [], activeTabId: null }))),

  setActiveTab: (scope, id) => set((s) => withScope(s, scope, (sc) => ({ ...sc, activeTabId: id }))),

  updateTab: (scope, id, patch) =>
    set((s) => withScope(s, scope, (sc) => ({ ...sc, tabs: sc.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)) }))),

  hydrate: (scope, tabs, activeTabId) =>
    set((s) => withScope(s, scope, () => ({ tabs, activeTabId: activeTabId ?? tabs[0]?.id ?? null, hydrated: true }))),

  closeWhere: (scope, predicate) =>
    set((s) =>
      withScope(s, scope, (sc) => {
        const tabs = sc.tabs.filter((t) => !predicate(t));
        const activeTabId = tabs.some((t) => t.id === sc.activeTabId) ? sc.activeTabId : (tabs[0]?.id ?? null);
        return { ...sc, tabs, activeTabId };
      }),
    ),
}));

/** Stable identity for "one tab per item" behaviour. */
export function singletonKey(tab: Pick<Tab, 'type' | 'data'>): string {
  const key = tab.data && ('id' in tab.data ? tab.data.id : (tab.data.key ?? ''));
  return `${tab.type}:${String(key ?? '')}`;
}

export const selectScopeTabs = (scope: string) => (s: TabsState): TabScope => s.scopes[scope] ?? emptyScope();
