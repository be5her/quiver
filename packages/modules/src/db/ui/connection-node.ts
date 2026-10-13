import { Component, computed, inject, input } from '@angular/core';
import { ContextMenu, Icon, IconButton, TreeState } from '@quiver/ui';
import { ChevronDown, ChevronRight, Ellipsis, KeyRound, Terminal } from 'lucide';
import { DatabaseList } from './database-list';
import { DbActions, type DbConnectionRow } from './db-actions';
import { DbRow } from './db-row';
import { AccessBadge, KindIcon } from './kind-icon';
import { TableList } from './table-list';

/**
 * A connection in the tree: databases (MySQL, PostgreSQL schemas), tables (SQLite) or keys and console
 * (Redis) underneath. One Open action on hover; the rest sits in the right-click (or "…") menu.
 */
@Component({
  selector: 'q-db-connection-node',
  imports: [AccessBadge, DatabaseList, DbRow, Icon, IconButton, KindIcon, TableList],
  templateUrl: './connection-node.html',
  host: { class: 'block' },
})
export class ConnectionNode {
  private readonly tree = inject(TreeState);
  private readonly contextMenu = inject(ContextMenu);
  protected readonly db = inject(DbActions);

  readonly connection = input.required<DbConnectionRow>();

  protected readonly icons = { ChevronDown, ChevronRight, Ellipsis, KeyRound, Terminal };
  protected readonly open = computed(() => this.tree.isExpanded(`conn/${this.connection().id}`));
  protected readonly openLabel = computed(() => (this.connection().kind === 'redis' ? 'Browse keys' : 'New query'));

  protected toggle(): void {
    this.tree.toggle(`conn/${this.connection().id}`);
  }

  protected openMain(event: MouseEvent): void {
    event.stopPropagation();
    this.db.openConnection(this.connection());
  }

  protected menu(event: MouseEvent): void {
    event.stopPropagation();
    this.contextMenu.open(event, this.db.connectionMenu(this.connection()));
  }
}
