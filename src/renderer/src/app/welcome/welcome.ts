import { Component, computed, inject } from '@angular/core';
import type { RecentWorkspace } from '@quiver/core';
import { AppState, Button, HostBridge, Icon, Kbd, invokeResource } from '@quiver/ui';
import { FolderOpen, X } from 'lucide';
import { QuiverMark } from '../quiver-mark';
import { ShellActions } from '../shell-actions';

/** What the content area shows without tabs: the workspace, or a way to open one, and recent folders. */
@Component({
  selector: 'q-welcome',
  imports: [Button, Icon, Kbd, QuiverMark],
  templateUrl: './welcome.html',
  host: { class: 'flex-1 flex items-center justify-center p-8 overflow-auto' },
})
export class Welcome {
  private readonly app = inject(AppState);
  private readonly host = inject(HostBridge);
  protected readonly shell = inject(ShellActions);

  protected readonly icons = { FolderOpen, X };
  protected readonly active = this.app.activeWorkspace;
  protected readonly recent = invokeResource<RecentWorkspace[]>('workspace.recent', () => ({}), { workspaceId: null });
  protected readonly openPaths = computed(() => new Set(this.app.workspaces().map((w) => w.path)));

  protected async forget(path: string): Promise<void> {
    await this.host.invoke('workspace.forgetRecent', { path }, null);
    this.recent.reload();
  }
}
