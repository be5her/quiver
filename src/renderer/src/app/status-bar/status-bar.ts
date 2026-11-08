import { NgComponentOutlet } from '@angular/common';
import { Component, computed, inject } from '@angular/core';
import { arrangeActivityBar, defaultActivityBarLayout } from '@quiver/core';
import { AppState, Icon } from '@quiver/ui';
import { Moon, Plug, Sun } from 'lucide';
import { modules } from '../modules';
import { ShellActions } from '../shell-actions';
import { AgentsItem } from './agents-item';
import { EnvironmentPicker } from './environment-picker';
import { RecordingItem } from './recording-item';
import { UpdateItem } from './update-item';

const moduleIds = modules.map((m) => m.id);

/**
 * The workspace folder, the environment and the modules' own items (`ModuleUI.statusItems`) on the left; updates,
 * recording, agent activity, MCP and the theme on the right.
 */
@Component({
  selector: 'footer[qStatusBar]',
  imports: [AgentsItem, EnvironmentPicker, Icon, NgComponentOutlet, RecordingItem, UpdateItem],
  templateUrl: './status-bar.html',
  host: { class: 'flex items-center h-6 px-2 gap-3 text-[11px] border-t border-edge bg-surface text-muted shrink-0 select-none' },
})
export class StatusBar {
  private readonly app = inject(AppState);
  protected readonly shell = inject(ShellActions);

  protected readonly icons = { Moon, Plug, Sun };
  protected readonly workspace = this.app.activeWorkspace;
  protected readonly mcp = this.app.mcpStatus;
  protected readonly theme = this.app.resolvedTheme;
  /** The items of the modules available now and shown in the activity bar (or drawn when hidden too), in its order. */
  protected readonly moduleItems = computed(() => {
    const layout = this.app.config()?.activityBar ?? defaultActivityBarLayout();
    const { all, visible } = arrangeActivityBar(moduleIds, layout);
    return all.flatMap((id) => {
      const mod = modules.find((m) => m.id === id);
      if (!mod?.statusItems || (mod.availability === 'workspace' && !this.app.hasWorkspace())) return [];
      return visible.includes(id) || mod.statusItemsWhenHidden ? mod.statusItems : [];
    });
  });
}
