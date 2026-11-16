import { Component, computed, inject, input, signal } from '@angular/core';
import { dbDataCollection, schemaNoun, visibleSchemas, type DbConnectionSummary } from '@quiver/core';
import { Icon, IconButton, Input, Spinner, TreeState, invokeResource } from '@quiver/ui';
import { ChevronDown, ChevronRight, Funnel, FunnelX, Search, Terminal } from 'lucide';
import { DbActions } from './db-actions';
import { DbError } from './db-error';
import { DbRow } from './db-row';
import { DbSchemaFilterState } from './schema-filter-state';
import { TableList } from './table-list';

/** Lists longer than this get a filter above them, as tables do. */
const FILTER_FROM = 10;

/**
 * The databases of a MySQL connection, or the schemas of a PostgreSQL one, each expanding to its tables. Only the
 * picked ones show while the connection has a schema filter (a row on top says how many, and edits or clears it),
 * and a long list gets a quick type-to-filter box.
 */
@Component({
  selector: 'q-db-database-list',
  imports: [DbError, DbRow, Icon, IconButton, Input, Spinner, TableList],
  template: `
    @if (databases.error(); as error) {
      <div [style.padding-left.px]="18"><q-db-error [error]="error" compact (retry)="databases.reload()" /></div>
    } @else if (databases.value(); as list) {
      @if (picked()) {
        <div
          qDbRow
          [depth]="1"
          [label]="visible().length + ' of ' + list.length + ' ' + noun()"
          data-testid="db-schema-filter-row"
          (click)="editFilter()"
          (keydown.enter)="editFilter()"
        >
          <svg rowPrefix [qIcon]="icons.Funnel" class="size-3.5 text-accent shrink-0"></svg>
          <button qIconButton [label]="'Show all ' + noun()" size="sm" data-testid="db-schema-filter-clear-row" (click)="clearFilter($event)"><svg [qIcon]="icons.FunnelX" class="size-3.5"></svg></button>
        </div>
      }
      @if (filterable()) {
        <div class="relative flex items-center h-7 pr-1" [style.padding-left.px]="22">
          <svg [qIcon]="icons.Search" class="size-3 text-muted absolute top-1/2 -translate-y-1/2 pointer-events-none" [style.left.px]="29"></svg>
          <input
            qInput
            [value]="quick()"
            [placeholder]="'Filter ' + visible().length + ' ' + noun()"
            [attr.aria-label]="'Filter ' + noun()"
            class="h-6 pl-6 text-xs"
            data-testid="db-schema-quick-filter"
            (input)="typed($event)"
            (keydown.escape)="clearQuick($event)"
            (keydown.enter)="openFirst()"
          />
        </div>
      }
      @for (database of shown(); track database) {
        @let open = isOpen(database);
        <div>
          <div qDbRow [depth]="1" [label]="database" [bold]="isDefault(database)" data-testid="db-schema-row" (click)="toggle(database)" (keydown.enter)="toggle(database)">
            <svg rowPrefix [qIcon]="open ? icons.ChevronDown : icons.ChevronRight" class="size-3.5 text-muted shrink-0"></svg>
            <button qIconButton label="New query on this database" size="sm" (click)="newQuery($event, database)"><svg [qIcon]="icons.Terminal" class="size-3.5"></svg></button>
          </div>
          @if (open) {
            <q-db-table-list [connectionId]="connection().id" [database]="database" [depth]="2" />
          }
        </div>
      } @empty {
        @if (quick().trim()) {
          <p class="text-xs text-muted py-1" [style.padding-left.px]="26">No {{ noun() }} match</p>
        } @else if (picked()) {
          <p class="text-xs text-muted py-1" [style.padding-left.px]="26">None of the picked {{ noun() }} is on the server</p>
        }
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
  private readonly filters = inject(DbSchemaFilterState);

  readonly connection = input.required<DbConnectionSummary>();

  protected readonly icons = { ChevronDown, ChevronRight, Funnel, FunnelX, Search, Terminal };
  protected readonly databases = invokeResource<string[]>('db.schema.databases', () => ({ connectionId: this.connection().id }), {
    refreshOn: () => [dbDataCollection(this.connection().id)],
  });
  protected readonly noun = computed(() => schemaNoun(this.connection().kind));
  protected readonly picked = computed(() => this.filters.pickedFor(this.connection().id));
  /** The schemas the saved filter lets through. */
  protected readonly visible = computed(() => visibleSchemas(this.databases.value() ?? [], this.picked()));
  /** The quick filter typed above the list; not kept. */
  protected readonly quick = signal('');
  protected readonly filterable = computed(() => this.visible().length > FILTER_FROM || this.quick() !== '');
  protected readonly shown = computed(() => {
    const needle = this.quick().trim().toLowerCase();
    return needle ? this.visible().filter((name) => name.toLowerCase().includes(needle)) : this.visible();
  });

  /** The schema queries run in when none is picked. */
  protected isDefault(database: string): boolean {
    const conn = this.connection();
    return conn.kind === 'postgres' ? database === 'public' : conn.database === database;
  }

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

  protected editFilter(): void {
    this.filters.open(this.connection());
  }

  protected clearFilter(event: MouseEvent): void {
    event.stopPropagation();
    this.filters.set(this.connection().id, null);
  }

  protected typed(event: Event): void {
    this.quick.set((event.target as HTMLInputElement).value);
  }

  protected clearQuick(event: Event): void {
    if (!this.quick()) return;
    event.stopPropagation();
    this.quick.set('');
  }

  /** Enter in the quick filter opens the first schema that matches. */
  protected openFirst(): void {
    const first = this.shown()[0];
    if (first && !this.isOpen(first)) this.toggle(first);
  }
}
