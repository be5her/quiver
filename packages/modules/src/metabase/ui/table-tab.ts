import { Component, computed, effect, inject, input, linkedSignal, signal, untracked } from '@angular/core';
import {
  METABASE_FILTER_LABELS,
  METABASE_FILTER_OPS,
  METABASE_UNARY_OPS,
  type DbQueryResult,
  type MetabaseDatabase,
  type MetabaseField,
  type MetabaseFilterOp,
  type MetabaseTable,
  type MetabaseTableFilter,
  type MetabaseTableOrder,
} from '@quiver/core';
import { Button, Icon, IconButton, Input, Select, Spinner, TabsState, invokeResource, type Tab, type TabComponent } from '@quiver/ui';
import { ChevronLeft, ChevronRight, Plus, RefreshCw, SquareTerminal, Table2, X } from 'lucide';
import { formatCount, formatDuration } from '../../db/ui/db-format';
import { ResultGrid, type FilterBy, type GridSort } from '../../db/ui/result-grid';
import { MetabaseExportMenu, type MetabaseExportSource } from './export-menu';
import { MetabaseActions } from './metabase-actions';
import { MetabaseError } from './metabase-error';
import { selectFromTable } from './metabase-format';

const PAGE_SIZES = [50, 100, 500, 1000] as const;
const DEFAULT_LIMIT = 100;
const NUMERIC_TYPES = new Set(['type/Integer', 'type/BigInteger', 'type/Float', 'type/Decimal', 'type/Number']);

/** What the tab keeps in `data.state`, so the view comes back as it was; the rows are fetched again. */
interface TableTabState {
  filters: MetabaseTableFilter[];
  orderBy: MetabaseTableOrder | null;
  page: number;
  limit: number;
}

function isNumeric(field: MetabaseField | undefined): boolean {
  return !!field && NUMERIC_TYPES.has(field.baseType);
}

/**
 * A table's rows through Metabase's query builder (MBQL), so it works for users without native SQL
 * permission: filters picked from the table's fields, a sort by a header click, and paging. The
 * filters, order and page live in the tab; the rows load on open and on every change.
 */
@Component({
  selector: 'q-mb-table-tab',
  imports: [Button, Icon, IconButton, Input, MetabaseError, MetabaseExportMenu, ResultGrid, Select, Spinner],
  template: `
    <div class="flex items-center gap-2 px-3 h-10 border-b border-edge shrink-0">
      <svg [qIcon]="icons.Table2" class="size-4 text-accent shrink-0"></svg>
      <span class="text-sm font-medium truncate max-w-80" data-testid="mb-table-name">{{ title() }}</span>
      @if (database(); as d) {
        <span class="text-xs text-muted truncate" data-testid="mb-table-database">{{ d.name }}</span>
      }
      <span class="flex-1"></span>
      <label class="text-xs text-muted shrink-0" for="mb-page-size">Rows</label>
      <select qSelect id="mb-page-size" class="h-7 text-xs w-20" aria-label="Rows per page" data-testid="mb-page-size" (change)="pickLimit($event)">
        @for (size of pageSizes(); track size) {
          <option [value]="size" [selected]="size === limit()">{{ size }}</option>
        }
      </select>
      <button
        qButton
        size="sm"
        variant="ghost"
        [icon]="icons.SquareTerminal"
        [disabled]="!table() || !database()"
        title="Open a native SQL query on this table (needs SQL permission on Metabase)"
        data-testid="mb-table-sql"
        (click)="openSql()"
      >
        SQL
      </button>
      <button qIconButton label="Refresh" size="sm" data-testid="mb-table-reload" (click)="reload()"><svg [qIcon]="icons.RefreshCw" class="size-3.5"></svg></button>
    </div>
    <div class="flex items-center gap-2 px-3 py-1.5 border-b border-edge shrink-0 flex-wrap text-xs" data-testid="mb-filters">
      <select qSelect class="h-7 text-xs max-w-48" aria-label="Filter field" data-testid="mb-filter-field" [disabled]="!fields().length" (change)="pickField($event)">
        @for (f of fields(); track f.id) {
          <option [value]="f.id" [selected]="f.id === draftField()?.id">{{ f.displayName || f.name }}</option>
        }
      </select>
      <select qSelect class="h-7 text-xs w-36" aria-label="Filter operator" data-testid="mb-filter-op" (change)="pickOp($event)">
        @for (op of ops; track op) {
          <option [value]="op" [selected]="op === draftOp()">{{ labels[op] }}</option>
        }
      </select>
      @if (!unary()) {
        <!-- qInput is full width; the wrapper gives it its size in the bar. -->
        <div class="w-48">
          <input
            qInput
            class="h-7 text-xs"
            aria-label="Filter value"
            placeholder="Value (Enter adds)"
            data-testid="mb-filter-value"
            [type]="draftNumeric() ? 'number' : 'text'"
            [value]="draftValue()"
            (input)="draftValue.set($any($event.target).value)"
            (keydown.enter)="addFilter()"
          />
        </div>
      }
      <button qButton size="sm" variant="secondary" [icon]="icons.Plus" [disabled]="!canAdd()" data-testid="mb-filter-add" (click)="addFilter()">Add</button>
      @for (filter of filters(); track $index) {
        <span class="inline-flex items-center gap-1 h-6 pl-2 pr-1 rounded-full border border-edge bg-surface text-fg" data-testid="mb-filter-chip">
          <span>{{ chipText(filter) }}</span>
          <button type="button" class="rounded-full p-0.5 text-muted hover:text-fg hover:bg-elevated" aria-label="Remove filter" data-testid="mb-filter-chip-remove" (click)="removeFilter($index)">
            <svg [qIcon]="icons.X" class="size-3"></svg>
          </button>
        </span>
      }
    </div>
    <div class="flex-1 min-h-0 relative">
      @if (error(); as error) {
        <q-mb-error [error]="error" [connectionId]="connectionId()" (retry)="reload()" />
      } @else if (rows.value(); as r) {
        <div class="h-full" data-testid="mb-table-result" [attr.data-rows]="r.rows.length" [attr.data-loading]="rows.isLoading() ? '' : null">
          <q-result-grid
            [columns]="r.columns"
            [rows]="r.rows"
            [sort]="gridSort()"
            sortable
            filterable
            [emptyMessage]="filters().length ? 'No rows match the filters' : page() > 1 ? 'No rows on this page' : 'Table is empty'"
            (sortBy)="sortBy($event)"
            (filterBy)="filterBy($event)"
          />
        </div>
        @if (rows.isLoading()) {
          <div class="absolute inset-0 flex items-center justify-center bg-canvas/40" data-testid="mb-table-loading"><svg qSpinner></svg></div>
        }
      } @else {
        <div class="flex items-center justify-center h-full"><svg qSpinner></svg></div>
      }
    </div>
    <div class="flex items-center gap-2 px-3 h-8 border-t border-edge shrink-0 text-xs text-muted">
      @if (rows.value(); as r) {
        @if (!error()) {
          <span data-testid="mb-rowcount">{{ range(r) }}</span>
        }
      }
      <span class="flex-1"></span>
      <button qIconButton label="Previous page" size="sm" data-testid="mb-page-prev" [disabled]="page() <= 1" (click)="previousPage()"><svg [qIcon]="icons.ChevronLeft" class="size-3.5"></svg></button>
      <button qIconButton label="Next page" size="sm" data-testid="mb-page-next" [disabled]="!hasNext()" (click)="nextPage()"><svg [qIcon]="icons.ChevronRight" class="size-3.5"></svg></button>
      @if (rows.value(); as r) {
        @if (!error() && r.rows.length > 0) {
          <q-mb-export-menu [connectionId]="connectionId()" [columns]="r.columns" [rows]="r.rows" [name]="name()" [source]="exportSource()" />
        }
      }
    </div>
  `,
  host: { class: 'flex flex-col h-full min-h-0', 'data-testid': 'mb-table' },
})
export class MetabaseTableTab implements TabComponent {
  private readonly tabs = inject(TabsState);
  private readonly metabase = inject(MetabaseActions);

  readonly tab = input.required<Tab>();
  readonly scope = input.required<string>();

  protected readonly icons = { ChevronLeft, ChevronRight, Plus, RefreshCw, SquareTerminal, Table2, X };
  protected readonly ops = METABASE_FILTER_OPS;
  protected readonly labels = METABASE_FILTER_LABELS;

  private readonly restored = computed(() => this.tab().id);
  protected readonly connectionId = computed(() => String(this.tab().data?.['connectionId'] ?? ''));
  private readonly databaseId = computed(() => Number(this.tab().data?.['databaseId']));
  private readonly tableId = computed(() => Number(this.tab().data?.['tableId']));
  protected readonly name = computed(() => String(this.tab().data?.['name'] ?? this.tab().title ?? 'table'));

  protected readonly filters = linkedSignal<string, MetabaseTableFilter[]>({ source: this.restored, computation: () => this.stored().filters ?? [] });
  protected readonly orderBy = linkedSignal<string, MetabaseTableOrder | null>({ source: this.restored, computation: () => this.stored().orderBy ?? null });
  protected readonly page = linkedSignal<string, number>({ source: this.restored, computation: () => Math.max(1, Math.floor(this.stored().page ?? 1)) });
  protected readonly limit = linkedSignal<string, number>({ source: this.restored, computation: () => this.stored().limit ?? DEFAULT_LIMIT });
  /** The usual sizes, plus a restored one that is not among them. */
  protected readonly pageSizes = computed(() => {
    const sizes: number[] = [...PAGE_SIZES];
    if (!sizes.includes(this.limit())) sizes.push(this.limit());
    return sizes.sort((a, b) => a - b);
  });

  private readonly databases = invokeResource<MetabaseDatabase[]>('metabase.databases', () => ({ connectionId: this.connectionId() }));
  private readonly tables = invokeResource<MetabaseTable[]>('metabase.tables', () => ({ connectionId: this.connectionId(), databaseId: this.databaseId() }), {
    enabled: () => Number.isFinite(this.databaseId()),
  });
  protected readonly database = computed(() => this.databases.value()?.find((d) => d.id === this.databaseId()) ?? null);
  protected readonly table = computed(() => this.tables.value()?.find((t) => t.id === this.tableId()) ?? null);
  protected readonly fields = computed(() => this.table()?.fields ?? []);
  protected readonly title = computed(() => {
    const t = this.table();
    if (!t) return this.name();
    return t.schema ? `${t.schema}.${t.name}` : t.name;
  });

  protected readonly rows = invokeResource<DbQueryResult>(
    'metabase.table.rows',
    () => ({
      connectionId: this.connectionId(),
      databaseId: this.databaseId(),
      tableId: this.tableId(),
      limit: this.limit(),
      page: this.page(),
      ...(this.orderBy() ? { orderBy: this.orderBy() } : {}),
      filters: this.filters(),
    }),
    { enabled: () => !!this.connectionId() && Number.isFinite(this.databaseId()) && Number.isFinite(this.tableId()) },
  );
  /** The rows' error, or the table list's when the rows have none to show. */
  protected readonly error = computed(() => this.rows.error() ?? (this.rows.value() ? null : this.tables.error()));

  // ---------- the filter being composed ----------
  private readonly draftFieldId = linkedSignal<MetabaseField[], number | null>({
    source: this.fields,
    computation: (fields, previous) => (previous && fields.some((f) => f.id === previous.value) ? previous.value : (fields[0]?.id ?? null)),
  });
  protected readonly draftField = computed(() => this.fields().find((f) => f.id === this.draftFieldId()));
  protected readonly draftOp = signal<MetabaseFilterOp>('=');
  protected readonly draftValue = signal('');
  protected readonly unary = computed(() => METABASE_UNARY_OPS.has(this.draftOp()));
  protected readonly draftNumeric = computed(() => isNumeric(this.draftField()));
  protected readonly canAdd = computed(() => {
    if (!this.draftField()) return false;
    if (this.unary()) return true;
    const text = this.draftValue().trim();
    if (!text) return false;
    return !this.draftNumeric() || Number.isFinite(Number(text));
  });

  protected readonly gridSort = computed<GridSort | null>(() => {
    const order = this.orderBy();
    const columns = this.rows.value()?.columns;
    if (!order || !columns) return null;
    const column = columns.find((c) => this.fieldForColumn(c.name)?.id === order.fieldId);
    return column ? { column: column.name, direction: order.direction } : null;
  });
  protected readonly hasNext = computed(() => (this.rows.value()?.rows.length ?? 0) >= this.limit());
  protected readonly exportSource = computed<MetabaseExportSource | null>(() => {
    if (!Number.isFinite(this.tableId()) || !Number.isFinite(this.databaseId())) return null;
    const orderBy = this.orderBy();
    return { tableId: this.tableId(), databaseId: this.databaseId(), filters: this.filters(), ...(orderBy ? { orderBy } : {}) };
  });

  constructor() {
    // Filters, order, page and page size live in the tab's data, so they come back with the workspace.
    effect(() => {
      const state: TableTabState = { filters: this.filters(), orderBy: this.orderBy(), page: this.page(), limit: this.limit() };
      untracked(() => {
        const tab = this.tab();
        if (JSON.stringify(tab.data?.['state']) !== JSON.stringify(state)) this.tabs.updateTab(this.scope(), tab.id, { data: { ...tab.data, state } });
      });
    });
  }

  /** Metabase names result columns by display name; back to the field by display name, else by name. */
  private fieldForColumn(column: string): MetabaseField | undefined {
    const fields = this.fields();
    return fields.find((f) => f.displayName === column) ?? fields.find((f) => f.name === column);
  }

  protected range(r: DbQueryResult): string {
    const n = r.rows.length;
    const offset = (this.page() - 1) * this.limit();
    const shown = n ? `rows ${formatCount(offset + 1)}–${formatCount(offset + n)}` : 'no rows';
    return `${shown} · ${formatDuration(r.durationMs)}`;
  }

  protected chipText(filter: MetabaseTableFilter): string {
    const field = this.fields().find((f) => f.id === filter.fieldId);
    const name = field ? field.displayName || field.name : `field ${filter.fieldId}`;
    const op = METABASE_FILTER_LABELS[filter.op];
    return METABASE_UNARY_OPS.has(filter.op) ? `${name} ${op}` : `${name} ${op} ${String(filter.value ?? '')}`;
  }

  protected reload(): void {
    if (this.tables.error()) this.tables.reload();
    this.rows.reload();
  }

  protected pickLimit(event: Event): void {
    this.limit.set(Number((event.target as HTMLSelectElement).value));
    this.page.set(1);
  }

  protected pickField(event: Event): void {
    this.draftFieldId.set(Number((event.target as HTMLSelectElement).value));
  }

  protected pickOp(event: Event): void {
    this.draftOp.set((event.target as HTMLSelectElement).value as MetabaseFilterOp);
  }

  protected addFilter(): void {
    const field = this.draftField();
    if (!field || !this.canAdd()) return;
    const op = this.draftOp();
    const text = this.draftValue().trim();
    const filter: MetabaseTableFilter = METABASE_UNARY_OPS.has(op) ? { fieldId: field.id, op } : { fieldId: field.id, op, value: isNumeric(field) ? Number(text) : text };
    this.setFilters([...this.filters(), filter]);
    this.draftValue.set('');
  }

  protected removeFilter(index: number): void {
    this.setFilters(this.filters().filter((_, i) => i !== index));
  }

  private setFilters(filters: MetabaseTableFilter[]): void {
    this.filters.set(filters);
    this.page.set(1);
  }

  protected previousPage(): void {
    this.page.update((p) => Math.max(1, p - 1));
  }

  protected nextPage(): void {
    this.page.update((p) => p + 1);
  }

  /** Ascending, then descending, then unsorted. */
  protected sortBy(column: string): void {
    const field = this.fieldForColumn(column);
    if (!field) return;
    this.orderBy.update((o) => (o?.fieldId === field.id ? (o.direction === 'asc' ? { fieldId: field.id, direction: 'desc' } : null) : { fieldId: field.id, direction: 'asc' }));
    this.page.set(1);
  }

  /** "Filter by this value" from the grid's menu: `is` that value, or `is null`. */
  protected filterBy({ column, value }: FilterBy): void {
    const field = this.fieldForColumn(column);
    if (!field) return;
    const filter: MetabaseTableFilter =
      value === null || value === undefined
        ? { fieldId: field.id, op: 'is-null' }
        : { fieldId: field.id, op: '=', value: typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string' ? value : JSON.stringify(value) };
    this.setFilters([...this.filters(), filter]);
  }

  protected openSql(): void {
    const table = this.table();
    const database = this.database();
    if (!table || !database) return;
    this.metabase.openQuery({ id: this.connectionId() }, { databaseId: database.id, sql: selectFromTable(table, database.engine), title: table.name });
  }

  private stored(): Partial<TableTabState> {
    return untracked(() => ((this.tab().data?.['state'] ?? {}) as Partial<TableTabState>));
  }
}
