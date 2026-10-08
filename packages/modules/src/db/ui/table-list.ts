import { Component, inject, input } from '@angular/core';
import { dbDataCollection, type DbTable } from '@quiver/core';
import { Icon, IconButton, Spinner, invokeResource } from '@quiver/ui';
import { Eye, RefreshCw, Table2, Terminal } from 'lucide';
import { DbActions } from './db-actions';
import { DbError } from './db-error';
import { DbRow } from './db-row';

/** The tables and views of a database (or of a SQLite file), each opening its table tab. */
@Component({
  selector: 'q-db-table-list',
  imports: [DbError, DbRow, Icon, IconButton, Spinner],
  templateUrl: './table-list.html',
  host: { class: 'contents' },
})
export class TableList {
  protected readonly db = inject(DbActions);

  readonly connectionId = input.required<string>();
  readonly database = input<string | null>(null);
  readonly depth = input(1);

  protected readonly icons = { Eye, RefreshCw, Table2, Terminal };
  protected readonly tables = invokeResource<DbTable[]>('db.schema.tables', () => ({ connectionId: this.connectionId(), database: this.database() }), {
    refreshOn: () => [dbDataCollection(this.connectionId())],
  });

  protected queryTable(event: MouseEvent, table: DbTable): void {
    event.stopPropagation();
    this.db.openQueryTab({ connectionId: this.connectionId(), database: this.database(), text: `SELECT * FROM ${table.name} LIMIT 100;`, title: table.name });
  }

  protected rows(table: DbTable): string | undefined {
    return table.rows !== null ? table.rows.toLocaleString() : undefined;
  }
}
