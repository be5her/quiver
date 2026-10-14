import { Component, inject, input } from '@angular/core';
import { clusterLabel, sameProxy, type TeleportClusterStatus, type TeleportTunnel } from '@quiver/core';
import { Icon, IconButton, SectionHeader, Toasts } from '@quiver/ui';
import { Square } from 'lucide';
import { TeleportActions } from './teleport-actions';

/** Every running tunnel, app-wide. */
@Component({
  selector: 'q-teleport-tunnels',
  imports: [Icon, IconButton, SectionHeader],
  template: `
    <q-section-header title="Tunnels" />
    @for (t of tunnels(); track t.id) {
      @let cluster = clusterOf(t);
      <div class="group flex items-center gap-2 px-3 h-7 hover:bg-elevated min-w-0" [title]="tooltip(t)" data-testid="teleport-tunnel">
        <span class="size-1.5 rounded-full bg-success shrink-0"></span>
        <span class="truncate text-xs flex-1"
          >@if (t.kind === 'teleport') {<ng-container>{{ t.target }} </ng-container><span class="text-muted">as {{ t.dbUser }}</span>@if (cluster) {<span class="text-muted"> · {{ label(cluster) }}</span>}} @else {<span class="font-mono">{{ t.target }}</span>}</span
        >
        <span class="text-[11px] font-mono text-muted shrink-0">:{{ t.port }}</span>
        <button qIconButton label="Stop tunnel" size="sm" class="hidden group-hover:inline-flex" (click)="stop(t)"><svg [qIcon]="stopIcon" class="size-3"></svg></button>
      </div>
    }
  `,
  host: { class: 'block mt-2' },
})
export class TeleportTunnels {
  private readonly actions = inject(TeleportActions);
  private readonly toasts = inject(Toasts);

  readonly tunnels = input.required<TeleportTunnel[]>();
  readonly clusters = input.required<TeleportClusterStatus[]>();

  protected readonly stopIcon = Square;
  protected readonly label = clusterLabel;

  protected clusterOf(tunnel: TeleportTunnel): TeleportClusterStatus | undefined {
    return this.clusters().find((c) => sameProxy(c.proxy, tunnel.proxy));
  }

  protected tooltip(tunnel: TeleportTunnel): string {
    return tunnel.output.slice(-5).join('\n') || tunnel.target;
  }

  protected stop(tunnel: TeleportTunnel): void {
    this.actions.stopTunnel(tunnel).catch((err) => this.toasts.error(err));
  }
}
