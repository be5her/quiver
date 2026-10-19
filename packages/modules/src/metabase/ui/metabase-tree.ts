import { Component, computed, effect, inject, input, untracked } from '@angular/core';
import type { MetabaseCollection, MetabaseConnectionSummary, MetabaseDashboard, MetabaseDatabase, MetabaseItem, MetabaseTable } from '@quiver/core';
import { Icon, IconButton, Spinner, TreeState, invokeResource, type InvokeResource } from '@quiver/ui';
import { ChevronDown, ChevronRight, Database, FileChartColumn, Folder, LayoutDashboard, SquareTerminal, Table2 } from 'lucide';
import { DbRow } from '../../db/ui/db-row';
import { MetabaseActions } from './metabase-actions';
import { MetabaseError } from './metabase-error';
import { selectFromTable } from './metabase-format';

/** Lists that failed for want of a session load again once the connection is signed in. */
function reloadOnSignIn(conn: () => MetabaseConnectionSummary, list: InvokeResource<unknown>): void {
  // The input is read in the effect only: it is not set yet while the constructor runs.
  let was: MetabaseConnectionSummary['session']['state'] | undefined;
  effect(() => {
    const state = conn().session.state;
    if (was !== undefined && state === 'signed-in' && was !== 'signed-in' && untracked(list.error)) untracked(() => list.reload());
    was = state;
  });
}

/** Indent of a row at `depth`, for the spinner and error lines that are not `qDbRow`s. */
function indent(depth: number): number {
  return 8 + depth * 14;
}

/** The questions on a dashboard; each opens as a plain question. */
@Component({
  selector: 'q-mb-dashboard-cards',
  imports: [DbRow, Icon, MetabaseError, Spinner],
  template: `
    @if (dashboard.error(); as error) {
      <div [style.padding-left.px]="indent(depth())"><q-mb-error [error]="error" [connectionId]="conn().id" compact (retry)="dashboard.reload()" /></div>
    } @else if (dashboard.value(); as d) {
      @for (card of d.cards; track card.id) {
        <div qDbRow [depth]="depth()" [label]="card.name" data-testid="mb-tree-item" data-model="card" (click)="metabase.openQuestion(conn(), card)" (keydown.enter)="metabase.openQuestion(conn(), card)">
          <svg rowPrefix [qIcon]="icons.FileChartColumn" class="size-3.5 text-muted shrink-0"></svg>
        </div>
      } @empty {
        <p class="text-xs text-muted h-7 flex items-center" [style.padding-left.px]="indent(depth())">No questions on this dashboard</p>
      }
    } @else {
      <div class="flex items-center h-7" [style.padding-left.px]="indent(depth())"><svg qSpinner class="size-3.5"></svg></div>
    }
  `,
  host: { class: 'contents' },
})
export class MetabaseDashboardCards {
  protected readonly metabase = inject(MetabaseActions);

  readonly conn = input.required<MetabaseConnectionSummary>();
  readonly dashboardId = input.required<number>();
  readonly depth = input(2);

  protected readonly icons = { FileChartColumn };
  protected readonly indent = indent;
  protected readonly dashboard = invokeResource<MetabaseDashboard>('metabase.dashboard.get', () => ({ connectionId: this.conn().id, dashboardId: this.dashboardId() }));
}

/** A collection's questions, dashboards and sub-collections, each loaded when it is opened. */
@Component({
  selector: 'q-mb-item-list',
  imports: [DbRow, Icon, MetabaseDashboardCards, MetabaseError, Spinner],
  template: `
    @if (items.error(); as error) {
      <div [style.padding-left.px]="indent(depth())"><q-mb-error [error]="error" [connectionId]="conn().id" compact (retry)="items.reload()" /></div>
    } @else if (entries(); as list) {
      @for (entry of list; track entry.item.model + entry.item.id) {
        @let item = entry.item;
        @switch (item.model) {
          @case ('card') {
            <div qDbRow [depth]="depth()" [label]="item.name" data-testid="mb-tree-item" data-model="card" (click)="metabase.openQuestion(conn(), item)" (keydown.enter)="metabase.openQuestion(conn(), item)">
              <svg rowPrefix [qIcon]="icons.FileChartColumn" class="size-3.5 text-muted shrink-0"></svg>
            </div>
          }
          @default {
            @let open = isOpen(item);
            <div qDbRow [depth]="depth()" [label]="item.name" data-testid="mb-tree-item" [attr.data-model]="item.model" (click)="toggle(item)" (keydown.enter)="toggle(item)">
              <svg rowPrefix [qIcon]="open ? icons.ChevronDown : icons.ChevronRight" class="size-3.5 text-muted shrink-0"></svg>
              <svg rowPrefix [qIcon]="item.model === 'dashboard' ? icons.LayoutDashboard : icons.Folder" class="size-3.5 text-muted shrink-0"></svg>
            </div>
            @if (open) {
              @if (item.model === 'dashboard') {
                <q-mb-dashboard-cards [conn]="conn()" [dashboardId]="item.id" [depth]="depth() + 1" />
              } @else {
                <q-mb-item-list [conn]="conn()" [collectionId]="'' + item.id" [children]="entry.children" [depth]="depth() + 1" />
              }
            }
          }
        }
      } @empty {
        <p class="text-xs text-muted h-7 flex items-center" [style.padding-left.px]="indent(depth())">Empty collection</p>
      }
    } @else {
      <div class="flex items-center h-7" [style.padding-left.px]="indent(depth())"><svg qSpinner class="size-3.5"></svg></div>
    }
  `,
  host: { class: 'contents' },
})
export class MetabaseItemList {
  private readonly tree = inject(TreeState);
  protected readonly metabase = inject(MetabaseActions);

  readonly conn = input.required<MetabaseConnectionSummary>();
  /** Metabase's collection id, or `root`. */
  readonly collectionId = input('root');
  /** The sub-collections the collection tree gave this one; the root asks for the tree itself. */
  readonly children = input<MetabaseCollection[] | null>(null);
  readonly depth = input(2);

  protected readonly icons = { ChevronDown, ChevronRight, FileChartColumn, Folder, LayoutDashboard };
  protected readonly indent = indent;
  protected readonly items = invokeResource<MetabaseItem[]>('metabase.collection.items', () => ({ connectionId: this.conn().id, collectionId: this.collectionId() }));
  private readonly collectionTree = invokeResource<MetabaseCollection>('metabase.collections', () => ({ connectionId: this.conn().id }), { enabled: () => this.collectionId() === 'root' });
  /**
   * Sub-collections first, from the collection tree and from the items (whichever lists them), then the
   * questions and dashboards. Undefined until the items are in.
   */
  protected readonly entries = computed(() => {
    const items = this.items.value();
    if (!items) return undefined;
    const fromTree = this.collectionId() === 'root' ? (this.collectionTree.value()?.children ?? []) : (this.children() ?? []);
    const collections = new Map<string, { item: MetabaseItem; children: MetabaseCollection[] | null }>();
    for (const c of fromTree) collections.set(c.id, { item: { id: Number(c.id), model: 'collection', name: c.name, description: null, collectionId: this.collectionId() }, children: c.children });
    for (const item of items) if (item.model === 'collection' && !collections.has(String(item.id))) collections.set(String(item.id), { item, children: null });
    return [...collections.values(), ...items.filter((i) => i.model !== 'collection').map((item) => ({ item, children: null }))];
  });

  constructor() {
    reloadOnSignIn(this.conn, this.items);
  }

  private key(item: MetabaseItem): string {
    return `mb/${this.conn().id}/${item.model}/${item.id}`;
  }

  protected isOpen(item: MetabaseItem): boolean {
    return this.tree.isExpanded(this.key(item));
  }

  protected toggle(item: MetabaseItem): void {
    this.tree.toggle(this.key(item));
  }
}

/** A database's tables; one opens a query that selects from it. */
@Component({
  selector: 'q-mb-table-list',
  imports: [DbRow, Icon, MetabaseError, Spinner],
  template: `
    @if (tables.error(); as error) {
      <div [style.padding-left.px]="indent(depth())"><q-mb-error [error]="error" [connectionId]="conn().id" compact (retry)="tables.reload()" /></div>
    } @else if (tables.value(); as list) {
      @for (table of list; track table.id) {
        <div qDbRow [depth]="depth()" [label]="table.name" [hint]="table.schema ?? undefined" data-testid="mb-tree-item" data-model="table" (click)="open(table)" (keydown.enter)="open(table)">
          <svg rowPrefix [qIcon]="icons.Table2" class="size-3.5 text-muted shrink-0"></svg>
        </div>
      } @empty {
        <p class="text-xs text-muted h-7 flex items-center" [style.padding-left.px]="indent(depth())">No tables</p>
      }
    } @else {
      <div class="flex items-center h-7" [style.padding-left.px]="indent(depth())"><svg qSpinner class="size-3.5"></svg></div>
    }
  `,
  host: { class: 'contents' },
})
export class MetabaseTableList {
  private readonly metabase = inject(MetabaseActions);

  readonly conn = input.required<MetabaseConnectionSummary>();
  readonly database = input.required<MetabaseDatabase>();
  readonly depth = input(3);

  protected readonly icons = { Table2 };
  protected readonly indent = indent;
  protected readonly tables = invokeResource<MetabaseTable[]>('metabase.tables', () => ({ connectionId: this.conn().id, databaseId: this.database().id }));

  protected open(table: MetabaseTable): void {
    this.metabase.openQuery(this.conn(), { databaseId: this.database().id, sql: selectFromTable(table, this.database().engine), title: table.name });
  }
}

/** The databases Metabase knows, each expanding to its tables. */
@Component({
  selector: 'q-mb-database-list',
  imports: [DbRow, Icon, IconButton, MetabaseError, MetabaseTableList, Spinner],
  template: `
    @if (databases.error(); as error) {
      <div [style.padding-left.px]="indent(depth())"><q-mb-error [error]="error" [connectionId]="conn().id" compact (retry)="databases.reload()" /></div>
    } @else if (databases.value(); as list) {
      @for (database of list; track database.id) {
        @let open = isOpen(database);
        <div qDbRow [depth]="depth()" [label]="database.name" [hint]="database.engine" data-testid="mb-tree-database" (click)="toggle(database)" (keydown.enter)="toggle(database)">
          <svg rowPrefix [qIcon]="open ? icons.ChevronDown : icons.ChevronRight" class="size-3.5 text-muted shrink-0"></svg>
          <svg rowPrefix [qIcon]="icons.Database" class="size-3.5 text-muted shrink-0"></svg>
          <button qIconButton label="New query on this database" size="sm" (click)="newQuery($event, database)"><svg [qIcon]="icons.SquareTerminal" class="size-3.5"></svg></button>
        </div>
        @if (open) {
          <q-mb-table-list [conn]="conn()" [database]="database" [depth]="depth() + 1" />
        }
      } @empty {
        <p class="text-xs text-muted h-7 flex items-center" [style.padding-left.px]="indent(depth())">No databases you can query</p>
      }
    } @else {
      <div class="flex items-center h-7" [style.padding-left.px]="indent(depth())"><svg qSpinner class="size-3.5"></svg></div>
    }
  `,
  host: { class: 'contents' },
})
export class MetabaseDatabaseList {
  private readonly tree = inject(TreeState);
  private readonly metabase = inject(MetabaseActions);

  readonly conn = input.required<MetabaseConnectionSummary>();
  readonly depth = input(2);

  protected readonly icons = { ChevronDown, ChevronRight, Database, SquareTerminal };
  protected readonly indent = indent;
  protected readonly databases = invokeResource<MetabaseDatabase[]>('metabase.databases', () => ({ connectionId: this.conn().id }));

  constructor() {
    reloadOnSignIn(this.conn, this.databases);
  }

  private key(database: MetabaseDatabase): string {
    return `mb/${this.conn().id}/database/${database.id}`;
  }

  protected isOpen(database: MetabaseDatabase): boolean {
    return this.tree.isExpanded(this.key(database));
  }

  protected toggle(database: MetabaseDatabase): void {
    this.tree.toggle(this.key(database));
  }

  protected newQuery(event: MouseEvent, database: MetabaseDatabase): void {
    event.stopPropagation();
    this.metabase.openQuery(this.conn(), { databaseId: database.id });
  }
}

