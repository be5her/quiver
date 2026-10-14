import { Component, inject } from '@angular/core';
import { ToolTabs } from './tool-tabs';
import { TOOLS } from './tools';

@Component({
  selector: 'q-tools-sidebar',
  template: `
    @for (tool of tools; track tool.id) {
      <button type="button" class="w-full text-left px-3 py-1.5 hover:bg-elevated" (click)="toolTabs.open(tool)">
        <div class="text-sm text-fg">{{ tool.title }}</div>
        <div class="text-[11px] text-muted">{{ tool.description }}</div>
      </button>
    }
  `,
  host: { class: 'block py-1' },
})
export class ToolsSidebar {
  protected readonly toolTabs = inject(ToolTabs);
  protected readonly tools = TOOLS;
}
