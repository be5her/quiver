import { Component, computed, inject, input } from '@angular/core';
import type { DbConnectionSummary } from '@quiver/core';
import { Icon, IconButton, Toasts, TreeState } from '@quiver/ui';
import { ChevronDown, ChevronRight, KeyRound, Pencil, Terminal, Trash2 } from 'lucide';
import { DatabaseList } from './database-list';
import { DbActions } from './db-actions';
import { DbRow } from './db-row';
import { AccessBadge, KindIcon } from './kind-icon';
import { TableList } from './table-list';

/** A connection in the tree: databases (MySQL), tables (SQLite) or keys and console (Redis) underneath. */
@Component({
  selector: 'q-db-connection-node',
  imports: [AccessBadge, DatabaseList, DbRow, Icon, IconButton, KindIcon, TableList],
  templateUrl: './connection-node.html',
  host: { class: 'block' },
})
export class ConnectionNode {
  private readonly tree = inject(TreeState);
  private readonly toasts = inject(Toasts);
  protected readonly db = inject(DbActions);

  readonly connection = input.required<DbConnectionSummary>();

  protected readonly icons = { ChevronDown, ChevronRight, KeyRound, Pencil, Terminal, Trash2 };
  protected readonly open = computed(() => this.tree.isExpanded(`conn/${this.connection().id}`));

  protected toggle(): void {
    this.tree.toggle(`conn/${this.connection().id}`);
  }

  protected browseKeys(event: MouseEvent): void {
    event.stopPropagation();
    this.db.openRedisTab(this.connection());
  }

  protected newQuery(event: MouseEvent): void {
    event.stopPropagation();
    const conn = this.connection();
    this.db.openQueryTab({ connectionId: conn.id, database: conn.database || null });
  }

  protected edit(event: MouseEvent): void {
    event.stopPropagation();
    this.db.openConnectionTab(this.connection());
  }

  protected remove(event: MouseEvent): void {
    event.stopPropagation();
    this.db.deleteConnection(this.connection()).catch((err) => this.toasts.error(err));
  }
}
