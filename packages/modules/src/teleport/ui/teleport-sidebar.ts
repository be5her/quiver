import { Component, computed, inject } from '@angular/core';
import type { DbConnectionSummary, TeleportStatus } from '@quiver/core';
import { AppState, HostBridge, Icon, IconButton, SectionHeader, Spinner, Toasts, UiActions, invokeResource } from '@quiver/ui';
import { Plus, RefreshCw } from 'lucide';
import { TeleportActions } from './teleport-actions';
import { TeleportCluster } from './teleport-cluster';
import { TeleportPinned } from './teleport-pinned';
import { TeleportTunnels } from './teleport-tunnels';

/**
 * App-wide Teleport access: one section per cluster (a tsh profile), pinned resources on top,
 * databases behind `tsh proxy db` tunnels and Kubernetes clusters with a read-only query view.
 */
@Component({
  selector: 'q-teleport-sidebar',
  imports: [Icon, IconButton, SectionHeader, Spinner, TeleportCluster, TeleportPinned, TeleportTunnels],
  templateUrl: './teleport-sidebar.html',
  host: { class: 'flex flex-col h-full min-h-0 overflow-y-auto text-sm' },
})
export class TeleportSidebar {
  private readonly app = inject(AppState);
  private readonly host = inject(HostBridge);
  private readonly toasts = inject(Toasts);
  private readonly uiActions = inject(UiActions);
  protected readonly actions = inject(TeleportActions);

  protected readonly icons = { Plus, RefreshCw };
  protected readonly status = invokeResource<TeleportStatus>('teleport.status', () => ({}), { workspaceId: null, refreshOnEvents: ['teleport.changed', 'config.changed'] });
  protected readonly connections = invokeResource<DbConnectionSummary[]>('db.connection.list', () => ({}), { enabled: () => this.app.hasWorkspace(), refreshOn: ['db-connections'] });
  protected readonly tshSource = computed(() => {
    const source = this.status.value()?.tshSource;
    return source === 'connect' ? 'Teleport Connect' : source === 'path' ? 'PATH' : 'settings';
  });

  protected refreshNow(): void {
    this.host.invoke('teleport.status', { refresh: true }, null).then(
      () => this.status.reload(),
      (err) => this.toasts.error(err),
    );
  }

  protected openSettings(): void {
    this.uiActions.run('settings.open');
  }
}
