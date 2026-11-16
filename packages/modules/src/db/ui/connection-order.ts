import { Service, computed, inject, signal, untracked } from '@angular/core';
import { DB_CONNECTION_SORTS, DB_CONNECTION_SORT_LABELS, dbConnectionsLastUsed, isDbConnectionSort, sortDbConnections, type DbConnection, type DbConnectionSort, type DbHistoryEntry } from '@quiver/core';
import { AppState, ContextMenu, HostBridge, Toasts, invokeResource } from '@quiver/ui';

/** The workspace state key (per machine, under `.quiver/local`) the chosen sort is kept in. */
export const CONNECTION_SORT_KEY = 'db.connectionSort';

/**
 * How the Databases module lists connections: the team's manual order (committed, set by dragging in the sidebar),
 * by name, by type, or by the last query run on this machine. One choice for the sidebar and the connection pickers,
 * kept per machine with the workspace's UI state.
 */
@Service()
export class DbConnectionOrder {
  private readonly host = inject(HostBridge);
  private readonly app = inject(AppState);
  private readonly toasts = inject(Toasts);
  private readonly contextMenu = inject(ContextMenu);

  private readonly saved = invokeResource<{ value: unknown }>('workspace.state.get', () => ({ key: CONNECTION_SORT_KEY }), {
    enabled: () => this.app.hasWorkspace(),
    refreshOnState: [CONNECTION_SORT_KEY],
  });
  /** Picked in this window, per workspace, so the list answers before the write is read back. */
  private readonly picked = signal<Record<string, DbConnectionSort>>({});

  readonly sort = computed<DbConnectionSort>(() => {
    const id = this.app.activeWorkspaceId();
    const mine = id ? this.picked()[id] : undefined;
    if (mine) return mine;
    const value = this.saved.current()?.value;
    return isDbConnectionSort(value) ? value : 'manual';
  });
  readonly manual = computed(() => this.sort() === 'manual');
  readonly label = computed(() => (this.manual() ? 'Sort connections (manual order: drag to arrange)' : `Sort connections (by ${DB_CONNECTION_SORT_LABELS[this.sort()].toLowerCase()})`));

  /** The query history is only read while connections are listed by last use. */
  private readonly history = invokeResource<DbHistoryEntry[]>('db.history.list', () => ({ limit: 2000 }), {
    enabled: () => this.app.hasWorkspace() && this.sort() === 'recent',
    refreshOn: ['db-history'],
  });
  private readonly lastUsed = computed(() => dbConnectionsLastUsed(this.history.current() ?? []));

  /** `connections` in the chosen order; reactive, for use in a `computed`. */
  sorted<C extends Pick<DbConnection, 'id' | 'name' | 'kind' | 'order'>>(connections: readonly C[]): C[] {
    const sort = this.sort();
    return sortDbConnections(connections, sort, sort === 'recent' ? this.lastUsed() : {});
  }

  set(sort: DbConnectionSort): void {
    const id = untracked(this.app.activeWorkspaceId);
    if (!id) return;
    this.picked.update((p) => ({ ...p, [id]: sort }));
    this.host.invoke('workspace.state.set', { key: CONNECTION_SORT_KEY, value: sort }, id).catch((err) => this.toasts.error(err));
  }

  /** The sort menu of the Connections header. */
  openMenu(event: MouseEvent): void {
    const current = untracked(this.sort);
    this.contextMenu.open(
      event,
      DB_CONNECTION_SORTS.map((sort) => ({
        label: DB_CONNECTION_SORT_LABELS[sort],
        checked: sort === current,
        select: () => this.set(sort),
        testId: `db-connection-sort-${sort}`,
      })),
    );
  }
}
