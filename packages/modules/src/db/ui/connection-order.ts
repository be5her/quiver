import { Service, computed, effect, inject, signal, untracked } from '@angular/core';
import {
  DB_CONNECTION_SORTS,
  DB_CONNECTION_SORT_KEY,
  DB_CONNECTION_SORT_LABELS,
  dbConnectionsLastUsed,
  isDbConnectionSort,
  sortDbConnections,
  type DbConnection,
  type DbConnectionSort,
  type DbHistoryEntry,
} from '@quiver/core';
import { AppState, ContextMenu, HostBridge, Toasts, invokeResource, type ContextMenuItem } from '@quiver/ui';

type Listed = Pick<DbConnection, 'id' | 'name' | 'kind'>;

/**
 * How the Databases module lists connections: your manual order (set by dragging in the sidebar, or Move up and
 * Move down), by name, by type, or by the last query run on this machine. One choice for the sidebar, the connection
 * pickers and "New query", kept per machine with the workspace's UI state, as the manual order is.
 *
 * `db.connection.list` already answers in the manual order, so the lists given here are taken to be in it.
 */
@Service()
export class DbConnectionOrder {
  private readonly host = inject(HostBridge);
  private readonly app = inject(AppState);
  private readonly toasts = inject(Toasts);
  private readonly contextMenu = inject(ContextMenu);

  private readonly saved = invokeResource<{ value: unknown }>('workspace.state.get', () => ({ key: DB_CONNECTION_SORT_KEY }), {
    enabled: () => this.app.hasWorkspace(),
    refreshOnState: [DB_CONNECTION_SORT_KEY],
  });
  /** Picked in this window, per workspace, so the list answers before the write is read back; dropped once it is. */
  private readonly picked = signal<Record<string, DbConnectionSort>>({});

  readonly sort = computed<DbConnectionSort>(() => {
    const id = this.app.activeWorkspaceId();
    const mine = id ? this.picked()[id] : undefined;
    return mine ?? this.savedSort();
  });
  readonly manual = computed(() => this.sort() === 'manual');
  readonly label = computed(() => (this.manual() ? 'Sort connections (manual order: drag to arrange)' : `Sort connections (by ${DB_CONNECTION_SORT_LABELS[this.sort()].toLowerCase()})`));

  /** The query history is only read while connections are listed by last use. */
  private readonly history = invokeResource<DbHistoryEntry[]>('db.history.list', () => ({ limit: 2000 }), {
    enabled: () => this.app.hasWorkspace() && this.sort() === 'recent',
    refreshOn: ['db-history'],
  });
  private readonly lastUsed = computed(() => dbConnectionsLastUsed(this.history.current() ?? []));

  /** The sidebar's rows and its move, for Move up and Move down in a connection's menu. */
  private tree: { shown: () => readonly { id: string }[]; move: (id: string, to: number) => void } | null = null;

  constructor() {
    // Once the saved sort reads back what was picked here, it rules again: a change made in another window or by
    // `workspace.state.set` then shows without a reload.
    effect(() => {
      const id = this.app.activeWorkspaceId();
      const saved = this.saved.current();
      if (!id || !saved) return;
      const mine = untracked(this.picked)[id];
      if (mine && mine === this.savedSort()) {
        this.picked.update(({ [id]: _done, ...rest }) => rest);
      }
    });
  }

  private savedSort(): DbConnectionSort {
    const value = this.saved.current()?.value;
    return isDbConnectionSort(value) ? value : 'manual';
  }

  /** `connections` (in the manual order) in the chosen order; reactive, for use in a `computed`. */
  sorted<C extends Listed>(connections: readonly C[]): C[] {
    const sort = this.sort();
    return sortDbConnections(connections, sort, { order: connections.map((c) => c.id), lastUsed: sort === 'recent' ? this.lastUsed() : {} });
  }

  /** The same, for a one-off action: reads the saved sort and the history when they have not loaded yet. */
  async sortedNow<C extends Listed>(connections: readonly C[]): Promise<C[]> {
    const id = untracked(this.app.activeWorkspaceId);
    let sort = untracked(this.sort);
    if (id && !untracked(this.picked)[id] && !untracked(this.saved.current)) {
      const stored = await this.host.invoke<{ value: unknown }>('workspace.state.get', { key: DB_CONNECTION_SORT_KEY }).catch(() => ({ value: null }));
      sort = isDbConnectionSort(stored.value) ? stored.value : 'manual';
    }
    let lastUsed: Record<string, string> = {};
    if (sort === 'recent') {
      const history = untracked(this.history.current) ?? (await this.host.invoke<DbHistoryEntry[]>('db.history.list', { limit: 2000 }).catch(() => []));
      lastUsed = dbConnectionsLastUsed(history);
    }
    return sortDbConnections(connections, sort, { order: connections.map((c) => c.id), lastUsed });
  }

  set(sort: DbConnectionSort): void {
    const id = untracked(this.app.activeWorkspaceId);
    if (!id) return;
    this.picked.update((p) => ({ ...p, [id]: sort }));
    this.host.invoke('workspace.state.set', { key: DB_CONNECTION_SORT_KEY, value: sort }, id).catch((err) => this.toasts.error(err));
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

  /** Called by the sidebar, which shows the rows and saves a move; `detach` when it goes. */
  attach(tree: { shown: () => readonly { id: string }[]; move: (id: string, to: number) => void }): () => void {
    this.tree = tree;
    return () => {
      if (this.tree === tree) this.tree = null;
    };
  }

  /** Move up and Move down for a connection's menu: in the manual order only, the keyboard's way to arrange. */
  moveItems(connectionId: string): ContextMenuItem[] {
    const tree = this.tree;
    if (!tree || !untracked(this.manual)) return [];
    const ids = untracked(tree.shown).map((c) => c.id);
    const at = ids.indexOf(connectionId);
    if (at < 0 || ids.length < 2) return [];
    return [
      { label: 'Move up', disabled: at === 0, select: () => tree.move(connectionId, at - 1), testId: 'db-connection-move-up' },
      { label: 'Move down', disabled: at === ids.length - 1, select: () => tree.move(connectionId, at + 1), testId: 'db-connection-move-down' },
    ];
  }
}
