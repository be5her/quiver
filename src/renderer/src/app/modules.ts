import type { Type } from '@angular/core';
import { uiModules } from '@quiver/modules/ui';
import type { ModuleUI, TabComponent } from '@quiver/ui';
import { SettingsTab } from './settings/settings-tab';

/** Tabs the shell itself owns, outside any module. */
export const shellTabs: Record<string, Type<TabComponent>> = {
  'shell.settings': SettingsTab,
};

export const modules: ModuleUI[] = uiModules;

export function resolveTabComponent(type: string): Type<TabComponent> | undefined {
  if (shellTabs[type]) return shellTabs[type];
  for (const mod of modules) {
    if (mod.tabs[type]) return mod.tabs[type];
  }
  return undefined;
}

export function moduleById(id: string | undefined): ModuleUI | undefined {
  return modules.find((m) => m.id === id);
}
