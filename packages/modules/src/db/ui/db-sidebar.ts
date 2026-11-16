import { Component, DestroyRef, ElementRef, computed, effect, inject, signal, untracked } from '@angular/core';
import { DB_CONNECTION_ORDER_KEY, moveDbConnection, type DbHistoryEntry, type SavedQuery } from '@quiver/core';
import { DropMarker, HostBridge, Icon, IconButton, SectionHeader, Spinner, Toasts, TreeState, dragReorder, invokeResource } from '@quiver/ui';
import { ArrowUpDown, ChevronDown, ChevronRight, Clock, Pencil, Plus, Search, Terminal, Trash2 } from 'lucide';
import { ConnectionNode } from './connection-node';
import { DbConnectionOrder } from './connection-order';
import { DbActions, type DbConnectionRow } from './db-actions';
import { firstLine } from './db-format';
import { DbRow } from './db-row';
import { NewConnectionMenu } from './new-connection-menu';
import { SchemaFilterDialog } from './schema-filter-dialog';
import { DbSchemaFilterState } from './schema-filter-state';

/** Connections with their schema, saved queries and the latest queries; the history tab has the rest. */
@Component({
  selector: 'q-db-sidebar',
  imports: [ConnectionNode, DbRow, DropMarker, Icon, IconButton, NewConnectionMenu, SchemaFilterDialog, SectionHeader, Spinner],
  templateUrl: './db-sidebar.html',
  host: { class: 'relative flex flex-col h-full min-h-0 overflow-y-auto text-sm' },
})
export class DbSidebar {
  private readonly tree = inject(TreeState);
  private readonly toasts = inject(Toasts);
  private readonly host = inject(HostBridge);
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);
  protected readonly db = inject(DbActions);
  protected readonly order = inject(DbConnectionOrder);
  protected readonly schemaFilters = inject(DbSchemaFilterState);

  protected readonly icons = { ArrowUpDown, ChevronDown, ChevronRight, Clock, Pencil, Plus, Search, Terminal, Trash2 };
  protected readonly firstLine = firstLine;
  protected readonly connections = invokeResource<DbConnectionRow[]>('db.connection.list', () => ({}), { refreshOn: ['db-connections'], refreshOnState: [DB_CONNECTION_ORDER_KEY] });
  /** The ids in the order a drop just asked for, shown until the host has written it. */
  private readonly dropped = signal<string[] | null>(null);
  protected readonly shown = computed(() => {
    const rows = this.connections.value() ?? [];
    const dropped = this.dropped();
    if (!dropped) return this.order.sorted(rows);
    const at = (id: string) => (dropped.includes(id) ? dropped.indexOf(id) : dropped.length);
    return [...rows].sort((a, b) => at(a.id) - at(b.id));
  });
  /** Dragging a connection by its row sets the manual order; in the other sorts the rows stay put. */
  protected readonly reorder = dragReorder('y', () => this.element.nativeElement, (id, to) => this.move(id, to));
  protected readonly queries = invokeResource<SavedQuery[]>('db.query.list', () => ({}), { refreshOn: ['db-queries'] });
  protected readonly history = invokeResource<DbHistoryEntry[]>('db.history.list', () => ({ limit: 5 }), { refreshOn: ['db-history'] });
  protected readonly queriesOpen = computed(() => this.tree.isExpanded('db/section/queries', true));
  protected readonly historyOpen = computed(() => this.tree.isExpanded('db/section/history'));

  constructor() {
    // The click that ends a drag lands on the row, which must not also expand or collapse it.
    const swallow = (event: MouseEvent) => {
      if (!this.reorder.suppressClick()) return;
      event.stopPropagation();
      event.preventDefault();
    };
    const el = this.element.nativeElement;
    el.addEventListener('click', swallow, true);
    const detach = this.order.attach({ shown: this.shown, move: (id, to) => this.move(id, to) });
    inject(DestroyRef).onDestroy(() => {
      el.removeEventListener('click', swallow, true);
      detach();
      // The filter dialog is drawn here: it goes with the sidebar, and with its connection when that is deleted.
      this.schemaFilters.close();
    });
    effect(() => {
      const editing = this.schemaFilters.editing();
      const list = this.connections.current();
      if (editing && list && !list.some((c) => c.id === editing.id)) untracked(() => this.schemaFilters.close());
    });
    // Once the list (which comes in the manual order) reads back in the order that was dropped, it shows itself.
    effect(() => {
      const dropped = this.dropped();
      const rows = this.connections.value();
      if (!dropped || !rows) return;
      const listed = rows.map((c) => c.id).filter((id) => dropped.includes(id));
      if (listed.join() === dropped.filter((id) => rows.some((c) => c.id === id)).join()) this.dropped.set(null);
    });
  }

  /** Start dragging a connection by its own row (its drag handle), not by the tables and keys underneath it. */
  protected dragStart(event: PointerEvent, id: string): void {
    if (!this.order.manual() || !(event.target as HTMLElement).closest('[data-drag-handle]')) return;
    this.reorder.pointerDown(event, id);
  }

  private move(id: string, to: number): void {
    const before = untracked(this.shown).map((c) => c.id);
    const ids = moveDbConnection(before, id, to);
    if (ids.join() === before.join()) return;
    this.dropped.set(ids);
    // Should the list read back otherwise (an agent reordered meanwhile), it wins after a moment.
    const settle = () => setTimeout(() => this.dropped.update((d) => (d === ids ? null : d)), 2000);
    this.host.invoke('db.connection.reorder', { connectionIds: ids }).then(
      () => {
        this.connections.reload();
        settle();
      },
      (err) => {
        this.dropped.set(null);
        this.toasts.error(err);
      },
    );
  }

  protected toggleQueries(): void {
    this.tree.toggle('db/section/queries', true);
  }

  protected toggleHistory(): void {
    this.tree.toggle('db/section/history');
  }

  protected newQuery(): void {
    this.db.openQueryTab({ connectionId: this.shown()[0]?.id ?? null });
  }

  protected renameQuery(event: MouseEvent, query: SavedQuery): void {
    event.stopPropagation();
    this.db.renameQuery(query).catch((err) => this.toasts.error(err));
  }

  protected deleteQuery(event: MouseEvent, query: SavedQuery): void {
    event.stopPropagation();
    this.db.deleteQuery(query).catch((err) => this.toasts.error(err));
  }

  protected replay(entry: DbHistoryEntry): void {
    this.db.openQueryTab({ connectionId: entry.connectionId, database: entry.database, text: entry.text });
  }
}
