import { Component, inject } from '@angular/core';
import { AppState, Icon } from '@quiver/ui';
import { Moon, Plug, Sun } from 'lucide';
import { ShellActions } from '../shell-actions';
import { EnvironmentPicker } from './environment-picker';
import { RecordingItem } from './recording-item';
import { UpdateItem } from './update-item';

/** The workspace folder and environment on the left; updates, recording, MCP and the theme on the right. */
@Component({
  selector: 'footer[qStatusBar]',
  imports: [EnvironmentPicker, Icon, RecordingItem, UpdateItem],
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
}
