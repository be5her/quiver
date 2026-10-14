import { Service, inject, untracked } from '@angular/core';
import { AppState, TabsState } from '@quiver/ui';
import type { ToolDescriptor } from './tools';

/** Opens a tool in its tab, one tab per tool. */
@Service()
export class ToolTabs {
  private readonly app = inject(AppState);
  private readonly tabs = inject(TabsState);

  open(tool: ToolDescriptor): void {
    this.tabs.openTab(untracked(this.app.scope), { type: 'tools.tool', title: tool.title, data: { id: tool.id } }, { singletonKey: `tools.tool:${tool.id}` });
  }
}
