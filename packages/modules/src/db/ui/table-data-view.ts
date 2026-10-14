import { Component, booleanAttribute, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { buildTableEdits, dbDataCollection, quoteIdentifier, sqlLiteral, type DbTableApplyResult, type DbTableDetail, type DbTableEdit, type DbTableRows, type SqlKind } from '@quiver/core';
import { Button, CodeEditor, HostBridge, Icon, IconButton, Spinner, Toasts, invokeResource, type SQLNamespace } from '@quiver/ui';
import { Check, ChevronLeft, ChevronRight, Code, Plus, RefreshCw, Undo2 } from 'lucide';
import { DbActions } from './db-actions';
import { DbError } from './db-error';
import { ExportMenu, type ExportSource } from './export-menu';
import { formatCell, formatCount, formatDuration } from './db-format';
import { ResultGrid, type CellEdit, type FilterBy, type FollowKey, type GridSort } from './result-grid';

const PAGE = 100;

/** A pending change to a stored row: its key and the new values, both by column name. */
interface PendingRow {
  key: Record<string, unknown>;
  values: Record<string, unknown>;
}

interface InsertedRow {
  id: number;
  values: Record<string, unknown>;
}

/**
 * A table's rows a page at a time, sorted by a column and filtered with a WHERE clause. With a
 * primary key the grid is editable: changes, deletions and new rows are collected here, keyed by the
 * row's primary key so they survive a reload, shown as SQL on request, and applied in one transaction.
 */
@Component({
  selector: 'q-table-data-view',
  imports: [Button, CodeEditor, DbError, ExportMenu, Icon, IconButton, ResultGrid, Spinner],
  templateUrl: './table-data-view.html',
  host: { class: 'flex flex-col h-full min-h-0' },
})
export class TableDataView {
  private readonly host = inject(HostBridge);
  private readonly toasts = inject(Toasts);
  private readonly db = inject(DbActions);

  readonly connectionId = input.required<string>();
  readonly connectionName = input('');
  readonly table = input.required<string>();
  readonly database = input<string | null>(null);
  readonly kind = input<SqlKind>('mysql');
  /** WHERE completions: the table's columns. */
  readonly schema = input<SQLNamespace>();
  /** Primary key and foreign keys; null while loading. */
  readonly detail = input<DbTableDetail | null>(null);
  readonly production = input(false, { transform: booleanAttribute });
  /** A filter handed in from outside (foreign-key navigation); `whereAt` changes to apply the same text again. */
  readonly initialWhere = input<string | null>(null);
  readonly whereAt = input<number>(0);

  protected readonly icons = { Check, ChevronLeft, ChevronRight, Code, Plus, RefreshCw, Undo2 };
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

  // ---------- pending edits ----------
  private readonly changes = signal<Map<string, PendingRow>>(new Map());
  private readonly deleted = signal<Map<string, Record<string, unknown>>>(new Map());
  private readonly inserted = signal<InsertedRow[]>([]);
  private nextInsertId = 1;
  protected readonly showSql = signal(false);
  protected readonly applying = signal(false);

  protected readonly primaryKey = computed(() => this.detail()?.primaryKey ?? []);
  protected readonly editable = computed(() => this.primaryKey().length > 0);
  protected readonly readOnlyReason = computed(() => (this.detail() && !this.editable() ? 'Read-only: no primary key' : null));
  protected readonly foreignKeys = computed(() => this.detail()?.foreignKeys ?? []);
  private readonly columnNames = computed(() => (this.rows.value()?.columns ?? []).map((c) => c.name));
  /** Stored rows followed by the new ones, as the grid shows them. */
  protected readonly allRows = computed<unknown[][]>(() => {
    const data = this.rows.value();
    if (!data) return [];
    const names = this.columnNames();
    return [...data.rows, ...this.inserted().map((row) => names.map((name) => (name in row.values ? row.values[name] : null)))];
  });
  protected readonly insertedFrom = computed(() => (this.inserted().length ? (this.rows.value()?.rows.length ?? 0) : null));
  protected readonly gridChanges = computed(() => {
    const out: Record<number, Record<number, unknown>> = {};
    const data = this.rows.value();
    if (!data) return out;
    const names = this.columnNames();
    data.rows.forEach((row, i) => {
      const pending = this.changes().get(this.rowKey(row));
      if (!pending) return;
      const cells: Record<number, unknown> = {};
      for (const [name, value] of Object.entries(pending.values)) cells[names.indexOf(name)] = value;
      out[i] = cells;
    });
    this.inserted().forEach((row, i) => {
      const cells: Record<number, unknown> = {};
      for (const [name, value] of Object.entries(row.values)) cells[names.indexOf(name)] = value;
      out[data.rows.length + i] = cells;
    });
    return out;
  });
  protected readonly gridDeleted = computed(() => {
    const data = this.rows.value();
    if (!data) return [];
    const out: number[] = [];
    data.rows.forEach((row, i) => {
      if (this.deleted().has(this.rowKey(row))) out.push(i);
    });
    return out;
  });
  protected readonly edits = computed<DbTableEdit[]>(() => {
    const edits: DbTableEdit[] = [];
    for (const key of this.deleted().values()) edits.push({ kind: 'delete', key });
    for (const [rowKey, pending] of this.changes()) if (!this.deleted().has(rowKey)) edits.push({ kind: 'update', key: pending.key, values: pending.values });
    for (const row of this.inserted()) edits.push({ kind: 'insert', values: row.values });
    return edits;
  });
  protected readonly pendingCount = computed(() => this.edits().length);
  protected readonly statements = computed(() => {
    try {
      return buildTableEdits(this.kind(), this.table(), this.database(), this.edits());
    } catch (err) {
      return [`-- ${err instanceof Error ? err.message : String(err)}`];
    }
  });
  protected readonly sqlText = computed(() => this.statements().map((s) => `${s};`).join('\n'));
  protected readonly exportSource = computed<ExportSource>(() => ({ table: this.table(), database: this.database(), where: this.applied() || null, orderBy: this.sort()?.column ?? null, direction: this.sort()?.direction }));

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

  constructor() {
    effect(() => {
      const where = this.initialWhere();
      this.whereAt();
      if (where === null) return;
      untracked(() => {
        this.where.set(where);
        this.applied.set(where);
        this.offset.set(0);
      });
    });
  }

  private rowKey(row: unknown[]): string {
    const names = this.columnNames();
    return JSON.stringify(this.primaryKey().map((c) => row[names.indexOf(c)] ?? null));
  }

  private keyOf(row: unknown[]): Record<string, unknown> {
    const names = this.columnNames();
    return Object.fromEntries(this.primaryKey().map((c) => [c, row[names.indexOf(c)] ?? null]));
  }

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

  protected filterBy({ column, value }: FilterBy): void {
    const name = quoteIdentifier(this.kind(), column);
    const clause = value === null || value === undefined ? `${name} IS NULL` : `${name} = ${sqlLiteral(this.kind(), value)}`;
    this.where.set(clause);
    this.applyFilter();
  }

  /** Open the referenced table filtered to the row the key points at. */
  protected follow({ key, values }: FollowKey): void {
    const kind = this.kind();
    const where = key.refColumns.map((c, i) => `${quoteIdentifier(kind, c)} = ${sqlLiteral(kind, values[i])}`).join(' AND ');
    const database = kind === 'sqlite' ? null : (key.refDatabase ?? this.database());
    this.db.openTableTab(this.connectionId(), key.refTable, database, { where });
  }

  // ---------- editing ----------

  protected cellEdit({ row, col, value }: CellEdit): void {
    const data = this.rows.value();
    if (!data) return;
    const name = this.columnNames()[col];
    const stored = data.rows.length;
    if (row >= stored) {
      this.inserted.update((rows) => rows.map((r, i) => (i === row - stored ? { ...r, values: { ...r.values, [name]: value } } : r)));
      return;
    }
    const original = data.rows[row];
    const key = this.rowKey(original);
    this.changes.update((map) => {
      const next = new Map(map);
      const pending = next.get(key) ?? { key: this.keyOf(original), values: {} };
      const before = original[col];
      const unchanged = (before === null || before === undefined ? value === null : value !== null && formatCell(before) === formatCell(value));
      const values = { ...pending.values };
      if (unchanged) delete values[name];
      else values[name] = value;
      if (Object.keys(values).length) next.set(key, { ...pending, values });
      else next.delete(key);
      return next;
    });
  }

  protected toggleDelete(row: number): void {
    const data = this.rows.value();
    if (!data) return;
    const stored = data.rows.length;
    if (row >= stored) {
      this.inserted.update((rows) => rows.filter((_, i) => i !== row - stored));
      return;
    }
    const original = data.rows[row];
    const key = this.rowKey(original);
    this.deleted.update((map) => {
      const next = new Map(map);
      if (next.has(key)) next.delete(key);
      else next.set(key, this.keyOf(original));
      return next;
    });
  }

  protected addRow(): void {
    this.inserted.update((rows) => [...rows, { id: this.nextInsertId++, values: {} }]);
  }

  protected discard(): void {
    this.changes.set(new Map());
    this.deleted.set(new Map());
    this.inserted.set([]);
    this.showSql.set(false);
  }

  protected async apply(): Promise<void> {
    const edits = this.edits();
    if (!edits.length || this.applying()) return;
    const n = edits.length;
    if (!(await this.db.confirmWrite({ name: this.connectionName() || this.table(), production: this.production() }, `${n} change${n === 1 ? '' : 's'} will be applied to ${this.table()}.`))) return;
    this.applying.set(true);
    try {
      const result = await this.host.invoke<DbTableApplyResult>('db.table.apply', { connectionId: this.connectionId(), table: this.table(), database: this.database(), edits });
      this.toasts.notify(`Applied ${result.statements.length} change${result.statements.length === 1 ? '' : 's'} to ${this.table()}`, 'success');
      this.discard();
      this.rows.reload();
    } catch (err) {
      this.toasts.error(err);
    } finally {
      this.applying.set(false);
    }
  }
}
