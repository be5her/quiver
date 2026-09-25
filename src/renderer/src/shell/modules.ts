import type { ComponentType } from 'react';
import { uiModules } from '@quiver/modules/ui';
import type { ModuleUI, TabProps } from '@quiver/ui';
import { SettingsTab } from './SettingsTab';

/** Tabs the shell itself owns, outside any module. */
export const shellTabs: Record<string, ComponentType<TabProps>> = {
  'shell.settings': SettingsTab,
};

export const modules: ModuleUI[] = uiModules;

export function resolveTabComponent(type: string): ComponentType<TabProps> | undefined {
  if (shellTabs[type]) return shellTabs[type];
  for (const mod of modules) {
    if (mod.tabs[type]) return mod.tabs[type];
  }
  return undefined;
}

export function moduleById(id: string | undefined): ModuleUI | undefined {
  return modules.find((m) => m.id === id);
}
