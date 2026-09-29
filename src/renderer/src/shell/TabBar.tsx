import { cn, openContextMenu, selectScope, selectScopeTabs, useAppStore, useTabsStore, type Tab } from '@quiver/ui';
import { X } from 'lucide-react';
import type { MouseEvent } from 'react';
import { closeTabs } from './actions';

/** The right-click menu of a tab, after VS Code's. */
function showTabMenu(e: MouseEvent, scope: string, tabs: Tab[], tab: Tab): void {
  const index = tabs.findIndex((t) => t.id === tab.id);
  const others = tabs.filter((t) => t.id !== tab.id).map((t) => t.id);
  const right = tabs.slice(index + 1).map((t) => t.id);
  const saved = tabs.filter((t) => !t.dirty).map((t) => t.id);
  // When the active tab goes away, land on the one that was right-clicked, as VS Code does.
  const keep = (ids: string[]) => () => {
    const activeClosing = ids.includes(useTabsStore.getState().scopes[scope]?.activeTabId ?? '');
    void closeTabs(scope, ids).then(() => {
      const current = useTabsStore.getState().scopes[scope];
      if (activeClosing && current?.tabs.some((t) => t.id === tab.id)) useTabsStore.getState().setActiveTab(scope, tab.id);
    });
  };
  openContextMenu(e, [
    { label: 'Close', shortcut: 'Ctrl+W', onSelect: () => void closeTabs(scope, [tab.id]), testId: 'tab-menu-close' },
    { label: 'Close Others', onSelect: keep(others), disabled: others.length === 0, testId: 'tab-menu-close-others' },
    { label: 'Close to the Right', onSelect: keep(right), disabled: right.length === 0, testId: 'tab-menu-close-right' },
    { label: 'Close Saved', onSelect: keep(saved), disabled: saved.length === 0, testId: 'tab-menu-close-saved' },
    { label: 'Close All', onSelect: () => void closeTabs(scope, tabs.map((t) => t.id)), testId: 'tab-menu-close-all' },
  ]);
}

export function TabBar() {
  const scope = useAppStore(selectScope);
  const { tabs, activeTabId } = useTabsStore(selectScopeTabs(scope));
  const setActiveTab = useTabsStore((s) => s.setActiveTab);
  const closeTab = useTabsStore((s) => s.closeTab);
  const closeOthers = useTabsStore((s) => s.closeOthers);

  if (!tabs.length) return null;

  return (
    <div className="flex items-stretch h-9 border-b border-edge bg-surface overflow-x-auto overflow-y-hidden shrink-0" role="tablist">
      {tabs.map((tab) => {
        const active = tab.id === activeTabId;
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={active}
            tabIndex={0}
            onClick={() => setActiveTab(scope, tab.id)}
            onKeyDown={(e) => e.key === 'Enter' && setActiveTab(scope, tab.id)}
            onAuxClick={(e) => e.button === 1 && closeTab(scope, tab.id)}
            onDoubleClick={(e) => e.altKey && closeOthers(scope, tab.id)}
            onContextMenu={(e) => showTabMenu(e, scope, tabs, tab)}
            className={cn(
              'group flex items-center gap-2 pl-3 pr-1.5 max-w-52 min-w-0 border-r border-edge text-xs cursor-pointer select-none',
              active ? 'bg-canvas text-fg shadow-[inset_0_2px_0_var(--accent)]' : 'text-muted hover:text-fg hover:bg-elevated/50',
            )}
            title={tab.title}
            data-testid="tab"
            data-title={tab.title}
          >
            <span className="truncate">{tab.title}</span>
            {tab.dirty && !active && <span className="size-1.5 rounded-full bg-warning shrink-0" />}
            <button
              type="button"
              aria-label="Close tab"
              onClick={(e) => {
                e.stopPropagation();
                closeTab(scope, tab.id);
              }}
              className={cn('rounded p-0.5 hover:bg-elevated text-muted hover:text-fg shrink-0', active ? '' : 'opacity-0 group-hover:opacity-100')}
            >
              {tab.dirty && active ? <span className="block size-1.5 m-0.5 rounded-full bg-warning group-hover:hidden" /> : null}
              <X className={cn('size-3', tab.dirty && active && 'hidden group-hover:block')} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
