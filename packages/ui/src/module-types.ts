import type { LucideIcon } from 'lucide-react';
import type { ComponentType } from 'react';
import type { UIAction } from './stores/actions';
import type { Tab } from './stores/tabs';

export interface TabProps {
  tab: Tab;
  /** Scope key the tab lives in (workspace id or the global scope). */
  scope: string;
}

/**
 * The renderer half of a module. The shell reads this to draw the activity bar,
 * the sidebar, and to resolve tab components by type. This is also the future plugin contract.
 */
export interface ModuleUI {
  id: string;
  title: string;
  icon: LucideIcon;
  /** Sort position in the activity bar. */
  order: number;
  /** `workspace` modules are disabled until a folder is open. */
  availability: 'workspace' | 'always';
  Sidebar: ComponentType;
  /** Tab components keyed by full tab type, e.g. `api.request`. */
  tabs: Record<string, ComponentType<TabProps>>;
  actions?: UIAction[];
}

export function defineModuleUI(mod: ModuleUI): ModuleUI {
  return mod;
}
