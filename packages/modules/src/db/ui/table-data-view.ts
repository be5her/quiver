import { Component, booleanAttribute, computed, input, signal } from '@angular/core';
import { dbDataCollection, type DbTableRows } from '@quiver/core';
import { CodeEditor, Icon, IconButton, Spinner, invokeResource, type SQLNamespace } from '@quiver/ui';
import { ChevronLeft, ChevronRight, RefreshCw } from 'lucide';
import { DbError } from './db-error';
import { formatCount, formatDuration } from './db-format';
import { ResultGrid, type GridSort } from './result-grid';

const PAGE = 100;

/** A table's rows a page at a time, sorted by a column and filtered with a WHERE clause. */
@Component({
  selector: 'q-table-data-view',
  imports: [CodeEditor, DbError, Icon, IconButton, ResultGrid, Spinner],
  templateUrl: './table-data-view.html',
  host: { class: 'flex flex-col h-full min-h-0' },
})
export class TableDataView {
  readonly connectionId = input.required<string>();
  readonly table = input.required<string>();
  readonly database = input<string | null>(null);
  /** WHERE completions: the table's columns. */
  readonly schema = input<SQLNamespace>();
  readonly sqlite = input(false, { transform: booleanAttribute });

  protected readonly icons = { ChevronLeft, ChevronRight, RefreshCw };
  protected readonly offset = signal(0);
  protected readonly sort = signal<GridSort | null>(null);
  protected readonly where = signal('');
  protected readonly applied = signal('');
  protected readonly rows = invokeResource<DbTableRows>('db.table.rows', () => ({
    connectionId: this.connectionId(),
    table: this.table(),
    database: this.database(),
    limit: PAGE,
    offset: this.offset(),
    orderBy: this.sort()?.column ?? null,
    direction: this.sort()?.direction,
    where: this.applied() || null,
  }), { refreshOn: () => [dbDataCollection(this.connectionId())] });
  protected readonly range = computed(() => {
    const data = this.rows.value();
    if (!data) return '';
    const shown = data.rows.length ? `${formatCount(data.offset + 1)}–${formatCount(data.offset + data.rows.length)}` : '0';
    const total = data.total !== null ? ` of ${data.approximate ? '~' : ''}${formatCount(data.total)}` : '';
    return `${shown}${total} · ${formatDuration(data.durationMs)}`;
  });
  protected readonly hasNext = computed(() => {
    const data = this.rows.value();
    if (!data) return false;
    return data.total !== null ? data.offset + PAGE < data.total : data.rows.length === PAGE;
  });

  protected applyFilter(): void {
    this.offset.set(0);
    this.applied.set(this.where().trim());
  }

  protected previousPage(): void {
    this.offset.update((offset) => Math.max(0, offset - PAGE));
  }

  protected nextPage(): void {
    this.offset.update((offset) => offset + PAGE);
  }

  /** Ascending, then descending, then unsorted. */
  protected sortBy(column: string): void {
    this.offset.set(0);
    this.sort.update((s) => (s?.column === column ? (s.direction === 'asc' ? { column, direction: 'desc' } : null) : { column, direction: 'asc' }));
  }
}
