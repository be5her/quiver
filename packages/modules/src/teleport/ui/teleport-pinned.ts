import { Component, computed, inject, input, signal } from '@angular/core';
import { clusterLabel, sameProxy, type DbConnectionSummary, type TeleportPin, type TeleportStatus } from '@quiver/core';
import { Badge, Icon, IconButton, SectionHeader, Spinner, Toasts } from '@quiver/ui';
import { Boxes, Check, Database, PinOff, Square } from 'lucide';
import { TeleportActions } from './teleport-actions';
import { PROTOCOL_COLORS, connectionFor, isTerminalKube, isUsable } from './teleport-display';
import { TeleportViewState } from './teleport-view-state';

/** A pin with what the cluster sections know about it. */
interface PinRow {
  key: string;
  pin: TeleportPin;
  clusterName: string;
  usable: boolean;
  protocol: string | null;
  allowedUsers: string[] | undefined;
  kubeActive: boolean;
  tunnel: { port: number; dbUser: string } | null;
  connection: DbConnectionSummary | undefined;
}

/** Pinned databases and Kubernetes clusters of every cluster, one click from connecting or querying. */
@Component({
  selector: 'q-teleport-pinned',
  imports: [Badge, Icon, IconButton, SectionHeader, Spinner],
  templateUrl: './teleport-pinned.html',
  host: { class: 'block mb-1' },
})
export class TeleportPinned {
  private readonly toasts = inject(Toasts);
  private readonly actions = inject(TeleportActions);
  private readonly view = inject(TeleportViewState);

  readonly status = input.required<TeleportStatus>();
  readonly connections = input<DbConnectionSummary[]>();

  protected readonly icons = { Boxes, Check, Database, PinOff, Square };
  protected readonly protocolColors = PROTOCOL_COLORS;
  protected readonly busy = signal<string | null>(null);
  protected readonly rows = computed<PinRow[]>(() => {
    const status = this.status();
    const dbs = this.view.dbs();
    return status.pins.map((pin) => {
      const cluster = status.clusters.find((c) => sameProxy(c.proxy, pin.proxy));
      const db = pin.kind === 'db' ? Object.entries(dbs).find(([p]) => sameProxy(p, pin.proxy))?.[1]?.find((d) => d.name === pin.name) : undefined;
      const tunnel = status.tunnels.find((t) => t.kind === 'teleport' && t.target === pin.name && sameProxy(t.proxy, pin.proxy));
      return {
        key: `${pin.kind}:${pin.proxy}:${pin.name}`,
        pin,
        clusterName: cluster ? clusterLabel(cluster) : pin.proxy,
        usable: isUsable(cluster),
        protocol: db?.protocol ?? null,
        allowedUsers: db?.allowedUsers,
        kubeActive: pin.kind === 'kube' && isTerminalKube(cluster, pin.name),
        tunnel: tunnel ? { port: tunnel.port, dbUser: tunnel.dbUser ?? '' } : null,
        connection: pin.kind === 'db' ? connectionFor(this.connections(), pin.proxy, pin.name) : undefined,
      };
    });
  });

  /** A database connects (or opens its connection when its tunnel runs); a Kubernetes cluster opens its query view. */
  protected async open(row: PinRow): Promise<void> {
    if (this.busy()) return;
    this.busy.set(row.key);
    try {
      if (row.pin.kind === 'db') {
        if (row.connection && row.tunnel) this.actions.revealConnection(row.connection);
        else await this.actions.connectDatabase(row.pin.proxy, row.pin.name, row.allowedUsers, this.connections());
      } else if (row.usable) {
        this.actions.openKubeQuery(row.pin.proxy, row.pin.name);
      }
    } catch (err) {
      this.toasts.error(err);
    } finally {
      this.busy.set(null);
    }
  }

  protected stop(event: MouseEvent, row: PinRow): void {
    event.stopPropagation();
    this.actions.stopDatabase(row.pin.proxy, row.pin.name).catch((err) => this.toasts.error(err));
  }

  protected unpin(event: MouseEvent, row: PinRow): void {
    event.stopPropagation();
    this.actions.setPin(row.pin, false).catch((err) => this.toasts.error(err));
  }
}
