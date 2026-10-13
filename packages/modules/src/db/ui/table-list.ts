import { Component, computed, inject, input, signal } from '@angular/core';
import { dbDataCollection, type DbTable } from '@quiver/core';
import { Icon, IconButton, Input, Spinner, invokeResource } from '@quiver/ui';
import { Eye, RefreshCw, Search, Table2, Terminal } from 'lucide';
import { DbActions } from './db-actions';
import { DbError } from './db-error';
import { DbRow } from './db-row';

/** Lists longer than this get a filter above them. */
const FILTER_FROM = 10;

/** The tables and views of a database (or of a SQLite file), each opening its table tab. */
@Component({
  selector: 'q-db-table-list',
  imports: [DbError, DbRow, Icon, IconButton, Input, Spinner],
  templateUrl: './table-list.html',
  host: { class: 'contents' },
})
export class TableList {
  protected readonly db = inject(DbActions);

  readonly connectionId = input.required<string>();
  readonly database = input<string | null>(null);
  readonly depth = input(1);

  protected readonly icons = { Eye, RefreshCw, Search, Table2, Terminal };
  protected readonly tables = invokeResource<DbTable[]>('db.schema.tables', () => ({ connectionId: this.connectionId(), database: this.database() }), {
    refreshOn: () => [dbDataCollection(this.connectionId())],
  });
  protected readonly filter = signal('');
  /** Shown while the list is long, and while a filter is typed even if a reload shortened it. */
  protected readonly filterable = computed(() => (this.tables.value()?.length ?? 0) > FILTER_FROM || this.filter() !== '');
  protected readonly shown = computed(() => {
    const list = this.tables.value() ?? [];
    const needle = this.filter().trim().toLowerCase();
    return needle ? list.filter((t) => t.name.toLowerCase().includes(needle)) : list;
  });

  protected typed(event: Event): void {
    this.filter.set((event.target as HTMLInputElement).value);
  }

  protected clearFilter(event: Event): void {
    if (!this.filter()) return;
    event.stopPropagation();
    this.filter.set('');
  }

  /** Enter in the filter opens the first table that matches. */
  protected openFirst(): void {
    const first = this.shown()[0];
    if (first) this.db.openTableTab(this.connectionId(), first.name, this.database());
  }

  protected queryTable(event: MouseEvent, table: DbTable): void {
    event.stopPropagation();
    this.db.openQueryTab({ connectionId: this.connectionId(), database: this.database(), text: `SELECT * FROM ${table.name} LIMIT 100;`, title: table.name });
  }

  protected rows(table: DbTable): string | undefined {
    return table.rows !== null ? table.rows.toLocaleString() : undefined;
  }
}
