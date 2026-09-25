import { selectScope, selectScopeTabs, useAppStore, useTabsStore } from '@quiver/ui';
import { resolveTabComponent } from './modules';
import { Welcome } from './Welcome';

/**
 * Every open tab stays mounted (hidden when inactive) so editors, responses and
 * scroll positions survive switching, in both directions, without re-fetching.
 */
export function TabContent() {
  const scope = useAppStore(selectScope);
  const { tabs, activeTabId } = useTabsStore(selectScopeTabs(scope));

  if (!tabs.length) return <Welcome />;

  return (
    <div className="relative flex-1 min-h-0">
      {tabs.map((tab) => {
        const Component = resolveTabComponent(tab.type);
        const active = tab.id === activeTabId;
        return (
          <div key={tab.id} className={active ? 'absolute inset-0 flex flex-col' : 'hidden'} data-tab-type={tab.type}>
            {Component ? <Component tab={tab} scope={scope} /> : <div className="p-4 text-sm text-muted">No renderer for tab type "{tab.type}".</div>}
          </div>
        );
      })}
    </div>
  );
}
