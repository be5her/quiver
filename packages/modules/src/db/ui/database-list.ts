import { Component, inject, input } from '@angular/core';
import { dbDataCollection, type DbConnectionSummary } from '@quiver/core';
import { Icon, IconButton, Spinner, TreeState, invokeResource } from '@quiver/ui';
import { ChevronDown, ChevronRight, Terminal } from 'lucide';
import { DbActions } from './db-actions';
import { DbError } from './db-error';
import { DbRow } from './db-row';
import { TableList } from './table-list';

/** The databases of a MySQL connection, each expanding to its tables. */
@Component({
  selector: 'q-db-database-list',
  imports: [DbError, DbRow, Icon, IconButton, Spinner, TableList],
  template: `
    @if (databases.error(); as error) {
      <div [style.padding-left.px]="18"><q-db-error [error]="error" compact (retry)="databases.reload()" /></div>
    } @else if (databases.value(); as list) {
      @for (database of list; track database) {
        @let open = isOpen(database);
        <div>
          <div qDbRow [depth]="1" [label]="database" [bold]="connection().database === database" (click)="toggle(database)" (keydown.enter)="toggle(database)">
            <svg rowPrefix [qIcon]="open ? icons.ChevronDown : icons.ChevronRight" class="size-3.5 text-muted shrink-0"></svg>
            <button qIconButton label="New query on this database" size="sm" (click)="newQuery($event, database)"><svg [qIcon]="icons.Terminal" class="size-3.5"></svg></button>
          </div>
          @if (open) {
            <q-db-table-list [connectionId]="connection().id" [database]="database" [depth]="2" />
          }
        </div>
      }
    } @else {
      <div class="flex items-center h-7" [style.padding-left.px]="26"><svg qSpinner class="size-3.5"></svg></div>
    }
  `,
  host: { class: 'contents' },
})
export class DatabaseList {
  private readonly db = inject(DbActions);
  private readonly tree = inject(TreeState);

  readonly connection = input.required<DbConnectionSummary>();

  protected readonly icons = { ChevronDown, ChevronRight, Terminal };
  protected readonly databases = invokeResource<string[]>('db.schema.databases', () => ({ connectionId: this.connection().id }), {
    refreshOn: () => [dbDataCollection(this.connection().id)],
  });

  protected isOpen(database: string): boolean {
    return this.tree.isExpanded(`db/${this.connection().id}/${database}`);
  }

  protected toggle(database: string): void {
    this.tree.toggle(`db/${this.connection().id}/${database}`);
  }

  protected newQuery(event: MouseEvent, database: string): void {
    event.stopPropagation();
    this.db.openQueryTab({ connectionId: this.connection().id, database });
  }
}
