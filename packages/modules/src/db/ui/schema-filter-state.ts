import { Service, effect, inject, linkedSignal, signal, untracked } from '@angular/core';
import { DB_SCHEMA_FILTER_KEY, parseSchemaFilters, withSchemaFilter, type DbConnectionSummary } from '@quiver/core';
import { AppState, HostBridge, Toasts, invokeResource } from '@quiver/ui';

/**
 * Which schemas (PostgreSQL) or databases (MySQL) the tree shows under each connection: a view preference kept per
 * machine in the workspace's UI state (`db.schemaFilter`), like the tree's open nodes, never in the committed
 * connection. Only the tree reads it; the schema commands, the query tab's picker and completion and the schema
 * search still see every schema. Deleting a connection drops its entry (`db.connection.delete`).
 */
@Service()
export class DbSchemaFilterState {
  private readonly host = inject(HostBridge);
  private readonly app = inject(AppState);
  private readonly toasts = inject(Toasts);

  private readonly saved = invokeResource<{ value: unknown }>('workspace.state.get', () => ({ key: DB_SCHEMA_FILTER_KEY }), {
    enabled: () => this.app.hasWorkspace(),
    refreshOnState: [DB_SCHEMA_FILTER_KEY],
  });
  /** The saved filters, set here first so the tree answers before the write is read back. */
  private readonly filters = linkedSignal(() => parseSchemaFilters(this.saved.current()?.value));
  /** The connection whose filter dialog is open. */
  private readonly editingConnection = signal<DbConnectionSummary | null>(null);

  readonly editing = this.editingConnection.asReadonly();

  constructor() {
    // The dialog belongs to a connection of the workspace on screen; switching away closes it.
    let shown = untracked(this.app.activeWorkspaceId);
    effect(() => {
      const id = this.app.activeWorkspaceId();
      if (id !== shown) untracked(() => this.editingConnection.set(null));
      shown = id;
    });
  }

  /** The schemas picked for a connection, or null when it shows them all. Reactive. */
  pickedFor(connectionId: string): string[] | null {
    return this.filters()[connectionId] ?? null;
  }

  /** Show only `picked` under the connection, or every schema again with null. */
  set(connectionId: string, picked: readonly string[] | null): void {
    const workspaceId = untracked(this.app.activeWorkspaceId);
    if (!workspaceId) return;
    const next = withSchemaFilter(untracked(this.filters), connectionId, picked);
    this.filters.set(next);
    this.host.invoke('workspace.state.set', { key: DB_SCHEMA_FILTER_KEY, value: next }, workspaceId).catch((err) => this.toasts.error(err));
  }

  open(connection: DbConnectionSummary): void {
    this.editingConnection.set(connection);
  }

  close(): void {
    this.editingConnection.set(null);
  }
}
