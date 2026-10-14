import type { InputSignal, Type } from '@angular/core';
import type { IconNode } from './icon/icon';
import type { UIAction } from './state/ui-actions';
import type { Tab } from './state/tabs-state';

/** What every tab component receives from the shell. */
export interface TabComponent {
  readonly tab: InputSignal<Tab>;
  /** Scope key the tab lives in (workspace id or the global scope). */
  readonly scope: InputSignal<string>;
}

/**
 * The renderer half of a module. The shell reads this to draw the activity bar and the sidebar,
 * and to resolve tab components by type. This is also the future plugin contract.
 */
export interface ModuleUI {
  id: string;
  title: string;
  icon: IconNode;
  /** Sort position in the activity bar. */
  order: number;
  /** `workspace` modules are disabled until a folder is open. */
  availability: 'workspace' | 'always';
  sidebar: Type<unknown>;
  /** Tab components keyed by full tab type, e.g. `api.request`. */
  tabs: Record<string, Type<TabComponent>>;
  /** Palette entries. Called once in an injection context, so the actions can inject the module's services. */
  actions?: () => UIAction[];
}

export function defineModuleUI(mod: ModuleUI): ModuleUI {
  return mod;
}
