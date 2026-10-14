import { inject } from '@angular/core';
import { defineModuleUI } from '@quiver/ui';
import { Wrench } from 'lucide';
import { ToolTab } from './tool-tab';
import { ToolTabs } from './tool-tabs';
import { TOOLS } from './tools';
import { ToolsSidebar } from './tools-sidebar';

export const toolsModuleUI = defineModuleUI({
  id: 'tools',
  title: 'Tools',
  icon: Wrench,
  order: 90,
  availability: 'always',
  sidebar: ToolsSidebar,
  tabs: { 'tools.tool': ToolTab },
  actions: () => {
    const toolTabs = inject(ToolTabs);
    return TOOLS.map((tool) => ({ id: `tools.open.${tool.id}`, title: `Tool: ${tool.title}`, group: 'Tools', description: tool.description, run: () => toolTabs.open(tool) }));
  },
});
