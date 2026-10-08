import { Component, computed, inject, input, signal } from '@angular/core';
import { dbDataCollection, type DbColumn, type DbConnectionSummary, type DbTableDetail } from '@quiver/core';
import { Badge, Button, CodeEditor, Segment, Segmented, Spinner, invokeResource, type SQLNamespace, type Tab, type TabComponent } from '@quiver/ui';
import { Terminal } from 'lucide';
import { DbActions } from './db-actions';
import { DbError } from './db-error';
import { TableDataView } from './table-data-view';

type View = 'data' | 'structure';

/** Column completions for the WHERE filter; names that are not plain identifiers are inserted quoted. */
function filterSchema(table: string, columns: DbColumn[] | undefined): SQLNamespace | undefined {
  if (!columns) return undefined;
  return {
    [table]: columns.map((c) => ({
      label: c.name,
      type: 'property',
      detail: c.type,
      apply: /^[A-Za-z_][A-Za-z0-9_]*$/.test(c.name) ? undefined : `\`${c.name.replace(/`/g, '``')}\``,
    })),
  };
}

/** A table: its rows, or its columns, indexes and definition. */
@Component({
  selector: 'q-table-tab',
  imports: [Badge, Button, CodeEditor, DbError, Segment, Segmented, Spinner, TableDataView],
  templateUrl: './table-tab.html',
  host: { class: 'flex flex-col h-full min-h-0' },
})
export class TableTab implements TabComponent {
  private readonly db = inject(DbActions);

  readonly tab = input.required<Tab>();
  readonly scope = input.required<string>();

  protected readonly queryIcon = Terminal;
  protected readonly connectionId = computed(() => String(this.tab().data?.['connectionId'] ?? ''));
  protected readonly table = computed(() => String(this.tab().data?.['table'] ?? ''));
  protected readonly database = computed(() => {
    const database = this.tab().data?.['database'];
    return typeof database === 'string' ? database : null;
  });
  protected readonly view = signal<View>('data');
  // The columns feed both the Structure view and the WHERE filter's autocompletion.
  protected readonly detail = invokeResource<DbTableDetail>('db.schema.table', () => ({ connectionId: this.connectionId(), table: this.table(), database: this.database() }), {
    refreshOn: () => [dbDataCollection(this.connectionId())],
  });
  private readonly connections = invokeResource<DbConnectionSummary[]>('db.connection.list', () => ({}), { refreshOn: ['db-connections'] });
  protected readonly sqlite = computed(() => this.connections.value()?.find((c) => c.id === this.connectionId())?.kind === 'sqlite');
  protected readonly schema = computed(() => filterSchema(this.table(), this.detail.value()?.columns));

  protected openQuery(): void {
    const table = this.table();
    this.db.openQueryTab({ connectionId: this.connectionId(), database: this.database(), text: `SELECT * FROM ${table} LIMIT 100;`, title: table });
  }
}
