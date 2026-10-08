import { Component, computed, inject } from '@angular/core';
import type { DbConnectionSummary, DbHistoryEntry, SavedQuery } from '@quiver/core';
import { Icon, IconButton, SectionHeader, Spinner, Toasts, TreeState, invokeResource } from '@quiver/ui';
import { ChevronDown, ChevronRight, Pencil, Plus, Terminal, Trash2 } from 'lucide';
import { ConnectionNode } from './connection-node';
import { DbActions } from './db-actions';
import { firstLine } from './db-format';
import { DbRow } from './db-row';
import { NewConnectionMenu } from './new-connection-menu';

/** Connections with their schema, saved queries and the query history. */
@Component({
  selector: 'q-db-sidebar',
  imports: [ConnectionNode, DbRow, Icon, IconButton, NewConnectionMenu, SectionHeader, Spinner],
  templateUrl: './db-sidebar.html',
  host: { class: 'flex flex-col h-full min-h-0 overflow-y-auto text-sm' },
})
export class DbSidebar {
  private readonly tree = inject(TreeState);
  private readonly toasts = inject(Toasts);
  protected readonly db = inject(DbActions);

  protected readonly icons = { ChevronDown, ChevronRight, Pencil, Plus, Terminal, Trash2 };
  protected readonly firstLine = firstLine;
  protected readonly connections = invokeResource<DbConnectionSummary[]>('db.connection.list', () => ({}), { refreshOn: ['db-connections'] });
  protected readonly queries = invokeResource<SavedQuery[]>('db.query.list', () => ({}), { refreshOn: ['db-queries'] });
  protected readonly history = invokeResource<DbHistoryEntry[]>('db.history.list', () => ({ limit: 30 }), { refreshOn: ['db-history'] });
  protected readonly queriesOpen = computed(() => this.tree.isExpanded('db/section/queries', true));
  protected readonly historyOpen = computed(() => this.tree.isExpanded('db/section/history'));

  protected toggleQueries(): void {
    this.tree.toggle('db/section/queries', true);
  }

  protected toggleHistory(): void {
    this.tree.toggle('db/section/history');
  }

  protected newQuery(): void {
    this.db.openQueryTab({ connectionId: this.connections.value()?.[0]?.id ?? null });
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
