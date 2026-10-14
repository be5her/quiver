import { Service, signal, untracked } from '@angular/core';
import { moveItem, newId } from '@quiver/core';

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

/** Shared frozen instance, so a scope that has no tabs yet reads the same value every time. */
const EMPTY_SCOPE: TabScope = Object.freeze({ tabs: [], activeTabId: null, hydrated: false }) as TabScope;

/** Stable identity for "one tab per item" behaviour. */
export function singletonKey(tab: Pick<Tab, 'type' | 'data'>): string {
  const key = tab.data && ('id' in tab.data ? tab.data.id : (tab.data.key ?? ''));
  return `${tab.type}:${String(key ?? '')}`;
}

/** The open tabs of every scope (each workspace, plus the global scope). */
@Service()
export class TabsState {
  private readonly state = signal<Record<string, TabScope>>({});

  readonly scopes = this.state.asReadonly();

  /** The tabs of one scope; reactive when read in a template or computed. */
  scope(scope: string): TabScope {
    return this.state()[scope] ?? EMPTY_SCOPE;
  }

  openTab(scope: string, tab: Omit<Tab, 'id'> & { id?: string }, options?: { singletonKey?: string }): Tab {
    const current = untracked(this.state)[scope] ?? EMPTY_SCOPE;
    if (options?.singletonKey) {
      const existing = current.tabs.find((t) => singletonKey(t) === options.singletonKey);
      if (existing) {
        this.withScope(scope, (sc) => ({ ...sc, activeTabId: existing.id }));
        return existing;
      }
    }
    const created: Tab = { ...tab, id: tab.id ?? newId() };
    this.withScope(scope, (sc) => ({ ...sc, tabs: [...sc.tabs, created], activeTabId: created.id }));
    return created;
  }

  closeTab(scope: string, id: string): void {
    this.withScope(scope, (sc) => {
      const index = sc.tabs.findIndex((t) => t.id === id);
      if (index < 0) return sc;
      const tabs = sc.tabs.filter((t) => t.id !== id);
      let activeTabId = sc.activeTabId;
      if (activeTabId === id) activeTabId = tabs[Math.min(index, tabs.length - 1)]?.id ?? null;
      return { ...sc, tabs, activeTabId };
    });
  }

  closeOthers(scope: string, id: string): void {
    this.withScope(scope, (sc) => ({ ...sc, tabs: sc.tabs.filter((t) => t.id === id), activeTabId: id }));
  }

  closeAll(scope: string): void {
    this.withScope(scope, (sc) => ({ ...sc, tabs: [], activeTabId: null }));
  }

  setActiveTab(scope: string, id: string | null): void {
    this.withScope(scope, (sc) => ({ ...sc, activeTabId: id }));
  }

  /** Reorder: the tab ends up at index `to`. */
  moveTab(scope: string, id: string, to: number): void {
    this.withScope(scope, (sc) => {
      const from = sc.tabs.findIndex((t) => t.id === id);
      return from < 0 || from === to ? sc : { ...sc, tabs: moveItem(sc.tabs, from, to) };
    });
  }

  updateTab(scope: string, id: string, patch: Partial<Tab>): void {
    this.withScope(scope, (sc) => ({ ...sc, tabs: sc.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)) }));
  }

  hydrate(scope: string, tabs: Tab[], activeTabId: string | null): void {
    this.withScope(scope, () => ({ tabs, activeTabId: activeTabId ?? tabs[0]?.id ?? null, hydrated: true }));
  }

  /** Close the tabs that match, e.g. after deleting the item they show. */
  closeWhere(scope: string, predicate: (tab: Tab) => boolean): void {
    this.withScope(scope, (sc) => {
      const tabs = sc.tabs.filter((t) => !predicate(t));
      const activeTabId = tabs.some((t) => t.id === sc.activeTabId) ? sc.activeTabId : (tabs[0]?.id ?? null);
      return { ...sc, tabs, activeTabId };
    });
  }

  private withScope(scope: string, fn: (current: TabScope) => TabScope): void {
    this.state.update((scopes) => {
      const current = scopes[scope] ?? EMPTY_SCOPE;
      const next = fn(current);
      return next === current ? scopes : { ...scopes, [scope]: next };
    });
  }
}
