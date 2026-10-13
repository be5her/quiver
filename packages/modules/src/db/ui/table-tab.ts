import { Component, computed, inject, input, signal } from '@angular/core';
import { dbDataCollection, type DbColumn, type DbForeignKey, type DbTableDetail, type SqlKind } from '@quiver/core';
import { Badge, Button, CodeEditor, Segment, Segmented, Spinner, invokeResource, type SQLNamespace, type Tab, type TabComponent } from '@quiver/ui';
import { Terminal } from 'lucide';
import { DbActions, type DbConnectionRow } from './db-actions';
import { DbError } from './db-error';
import { KindIcon } from './kind-icon';
import { TableDataView } from './table-data-view';

type View = 'data' | 'structure';

/** Column completions for the WHERE filter; names that are not plain identifiers are inserted quoted. */
function filterSchema(table: string, columns: DbColumn[] | undefined, kind: SqlKind): SQLNamespace | undefined {
  if (!columns) return undefined;
  const quote = kind === 'mysql' ? '`' : '"';
  return {
    [table]: columns.map((c) => ({
      label: c.name,
      type: 'property',
      detail: c.type,
      apply: /^[A-Za-z_][A-Za-z0-9_]*$/.test(c.name) ? undefined : `${quote}${c.name.replace(new RegExp(quote, 'g'), quote + quote)}${quote}`,
    })),
  };
}

/** A table: its rows, or its columns, keys, indexes and definition. */
@Component({
  selector: 'q-table-tab',
  imports: [Badge, Button, CodeEditor, DbError, KindIcon, Segment, Segmented, Spinner, TableDataView],
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
  /** A filter handed in by foreign-key navigation; `whereAt` makes the same text apply again. */
  protected readonly where = computed(() => {
    const where = this.tab().data?.['where'];
    return typeof where === 'string' ? where : null;
  });
  protected readonly whereAt = computed(() => Number(this.tab().data?.['whereAt'] ?? 0));
  protected readonly view = signal<View>('data');
  // The columns feed the Structure view, the WHERE filter's autocompletion and the grid's keys.
  protected readonly detail = invokeResource<DbTableDetail>('db.schema.table', () => ({ connectionId: this.connectionId(), table: this.table(), database: this.database() }), {
    refreshOn: () => [dbDataCollection(this.connectionId())],
  });
  private readonly connections = invokeResource<DbConnectionRow[]>('db.connection.list', () => ({}), { refreshOn: ['db-connections'] });
  protected readonly connection = computed(() => this.connections.value()?.find((c) => c.id === this.connectionId()) ?? null);
  protected readonly kind = computed<SqlKind>(() => {
    const kind = this.connection()?.kind;
    return kind && kind !== 'redis' ? kind : 'mysql';
  });
  protected readonly schema = computed(() => filterSchema(this.table(), this.detail.value()?.columns, this.kind()));

  protected openQuery(): void {
    const table = this.table();
    this.db.openQueryTab({ connectionId: this.connectionId(), database: this.database(), text: `SELECT * FROM ${table} LIMIT 100;`, title: table });
  }

  /** Open the table on the other side of a key. */
  protected openKeyTable(key: DbForeignKey, side: 'table' | 'refTable'): void {
    const table = side === 'table' ? key.table : key.refTable;
    const database = side === 'table' ? key.database : key.refDatabase;
    this.db.openTableTab(this.connectionId(), table, this.kind() === 'sqlite' ? null : database);
  }
}
