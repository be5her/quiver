import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { sameProxy, type DbConnectionSummary, type TeleportClusterStatus, type TeleportDatabase, type TeleportStatus, type TeleportTunnel } from '@quiver/core';
import { Badge, Button, HostBridge, Icon, IconButton, Spinner, Toasts, invokeResource } from '@quiver/ui';
import { Pin, PinOff, Plug, Square } from 'lucide';
import { DbError } from '../../db/ui';
import { TeleportActions } from './teleport-actions';
import { PROTOCOL_COLORS, connectionFor } from './teleport-display';
import { TeleportSubHeader } from './teleport-sub-header';
import { TeleportViewState } from './teleport-view-state';

interface DbRow {
  db: TeleportDatabase;
  connection: DbConnectionSummary | undefined;
  tunnel: TeleportTunnel | null;
  pinned: boolean;
}

/** The databases of one cluster: connect through a tunnel, stop it, pin. */
@Component({
  selector: 'q-teleport-databases',
  imports: [Badge, Button, DbError, Icon, IconButton, Spinner, TeleportSubHeader],
  templateUrl: './teleport-databases.html',
  host: { class: 'block mt-1' },
})
export class TeleportDatabases {
  private readonly host = inject(HostBridge);
  private readonly toasts = inject(Toasts);
  private readonly actions = inject(TeleportActions);
  private readonly view = inject(TeleportViewState);

  readonly cluster = input.required<TeleportClusterStatus>();
  readonly status = input.required<TeleportStatus>();
  readonly connections = input<DbConnectionSummary[]>();

  protected readonly icons = { Pin, PinOff, Plug, Square };
  protected readonly protocolColors = PROTOCOL_COLORS;
  protected readonly busy = signal<string | null>(null);
  protected readonly dbs = invokeResource<TeleportDatabase[]>('teleport.db.list', () => ({ proxy: this.cluster().proxy }), { workspaceId: null, refreshOnEvents: ['teleport.changed'] });
  protected readonly rows = computed<DbRow[]>(() => {
    const status = this.status();
    return (this.dbs.value() ?? []).map((db) => ({
      db,
      connection: connectionFor(this.connections(), db.proxy, db.name),
      tunnel: db.tunnel ?? status.tunnels.find((t) => t.kind === 'teleport' && t.target === db.name && sameProxy(t.proxy, db.proxy)) ?? null,
      pinned: status.pins.some((p) => p.kind === 'db' && p.name === db.name && sameProxy(p.proxy, db.proxy)),
    }));
  });

  constructor() {
    // The Pinned section shows protocol and tunnel state from these lists.
    effect(() => {
      const dbs = this.dbs.value();
      if (dbs) this.view.setDbs(this.cluster().proxy, dbs);
    });
  }

  protected refresh(): void {
    this.host.invoke('teleport.db.list', { proxy: this.cluster().proxy, refresh: true }, null).then(
      () => this.dbs.reload(),
      (err) => this.toasts.error(err),
    );
  }

  /** A running tunnel with its connection opens the connection; otherwise connect. */
  protected open(row: DbRow): void {
    if (row.connection && row.tunnel) this.actions.revealConnection(row.connection);
    else void this.connect(row.db);
  }

  protected async connect(db: TeleportDatabase, event?: MouseEvent): Promise<void> {
    event?.stopPropagation();
    if (this.busy()) return;
    this.busy.set(db.name);
    try {
      await this.actions.connectDatabase(db.proxy, db.name, db.allowedUsers, this.connections());
    } catch (err) {
      this.toasts.error(err);
    } finally {
      this.busy.set(null);
    }
  }

  protected stop(event: MouseEvent, db: TeleportDatabase): void {
    event.stopPropagation();
    this.actions.stopDatabase(db.proxy, db.name).catch((err) => this.toasts.error(err));
  }

  protected togglePin(event: MouseEvent, row: DbRow): void {
    event.stopPropagation();
    this.actions.setPin({ proxy: row.db.proxy, kind: 'db', name: row.db.name }, !row.pinned).catch((err) => this.toasts.error(err));
  }

  protected title(db: TeleportDatabase): string {
    return [db.description, db.uri].filter(Boolean).join('\n');
  }
}
