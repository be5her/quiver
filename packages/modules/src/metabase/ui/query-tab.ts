import { Component, computed, effect, inject, input, linkedSignal, signal, untracked, viewChild } from '@angular/core';
import { toErrorPayload, type DbQueryResult, type ErrorPayload, type MetabaseConnectionSummary, type MetabaseDatabase, type MetabaseTable, type SqlKind } from '@quiver/core';
import { Button, CodeEditor, HostBridge, Icon, Select, Spinner, TabsState, invokeResource, type SQLNamespace, type SqlDialect, type Tab, type TabComponent } from '@quiver/ui';
import { ChartColumnBig, Play } from 'lucide';
import type { MetabaseExportSource } from './export-menu';
import { MetabaseError } from './metabase-error';
import { tablesSchema } from './metabase-format';
import { MetabaseResult } from './metabase-result';

/** What the tab keeps, so the query and its database come back with the workspace; results are run again on demand. */
interface QueryTabState {
  connectionId: string;
  databaseId: number | null;
  sql: string;
}

/** Metabase's driver names that the editor and the grid have a dialect for. */
function sqlKindOf(engine: string | undefined): SqlKind | null {
  if (engine === 'postgres' || engine === 'redshift') return 'postgres';
  if (engine === 'mysql' || engine === 'mariadb') return 'mysql';
  if (engine === 'sqlite') return 'sqlite';
  return null;
}

/**
 * Native SQL on one of Metabase's databases, run as Metabase's database user. Ctrl+Enter runs the
 * selection or everything; completion knows the database's tables and fields.
 */
@Component({
  selector: 'q-mb-query-tab',
  imports: [Button, CodeEditor, Icon, MetabaseError, MetabaseResult, Select, Spinner],
  template: `
    <div class="flex items-center gap-2 px-3 h-10 border-b border-edge shrink-0">
      <svg [qIcon]="icons.ChartColumnBig" class="size-4 text-accent shrink-0"></svg>
      <span class="text-sm font-medium truncate max-w-48">{{ connection.value()?.name ?? 'Metabase' }}</span>
      <select qSelect class="h-7 text-xs max-w-64" aria-label="Database" data-testid="mb-database" [disabled]="!databases.value()?.length" (change)="pickDatabase($event)">
        @if (databaseId() === null) {
          <option value="" selected>Pick a database</option>
        }
        @for (d of databases.value() ?? []; track d.id) {
          <option [value]="d.id" [selected]="d.id === databaseId()">{{ d.name }}</option>
        }
      </select>
      @if (databases.isLoading() || tables.isLoading()) {
        <svg qSpinner class="size-3.5"></svg>
      }
      <button
        qButton
        variant="primary"
        size="sm"
        [icon]="icons.Play"
        [loading]="running()"
        [disabled]="databaseId() === null || !sql().trim()"
        title="Ctrl+Enter runs the selection, or everything when nothing is selected"
        data-testid="mb-run"
        (click)="run()"
      >
        Run
      </button>
      <span class="flex-1"></span>
    </div>
    @if (databases.error(); as error) {
      <div class="border-b border-edge shrink-0"><q-mb-error [error]="error" [connectionId]="connectionId()" compact (retry)="databases.reload()" /></div>
    }
    <div class="flex flex-col flex-1 min-h-0">
      <div class="basis-[42%] min-h-[120px] p-2 border-b border-edge">
        <q-code-editor
          [(value)]="sql"
          language="sql"
          [sqlDialect]="dialect()"
          [sqlSchema]="sqlSchema()"
          placeholder="SELECT * FROM orders LIMIT 100&#10;&#10;Ctrl+Enter runs the selection, or everything when nothing is selected."
          autofocus
          data-testid="mb-query-editor"
          (run)="run()"
          (runCurrent)="run()"
        />
      </div>
      <q-mb-result
        [connectionId]="connectionId()"
        [result]="result()"
        [error]="error()"
        [running]="running()"
        [sqlKind]="sqlKind()"
        [exportName]="exportName()"
        [exportSource]="exportSource()"
        (retry)="run()"
      />
    </div>
  `,
  host: { class: 'flex flex-col h-full min-h-0' },
})
export class MetabaseQueryTab implements TabComponent {
  private readonly host = inject(HostBridge);
  private readonly tabs = inject(TabsState);
  private readonly editor = viewChild(CodeEditor);

  readonly tab = input.required<Tab>();
  readonly scope = input.required<string>();

  protected readonly icons = { ChartColumnBig, Play };
  private readonly restored = computed(() => this.tab().id);
  protected readonly connectionId = computed(() => String(this.tab().data?.['connectionId'] ?? ''));
  protected readonly databaseId = linkedSignal<string, number | null>({ source: this.restored, computation: () => this.stored().databaseId ?? null });
  protected readonly sql = linkedSignal({ source: this.restored, computation: () => this.stored().sql ?? '' });
  protected readonly result = signal<DbQueryResult | null>(null);
  protected readonly error = signal<ErrorPayload | null>(null);
  protected readonly running = signal(false);
  /** The SQL and database of the last run, which "Save all rows" sends again. */
  private readonly ran = signal<{ databaseId: number; sql: string } | null>(null);

  protected readonly connection = invokeResource<MetabaseConnectionSummary>('metabase.connection.get', () => ({ id: this.connectionId() }), { refreshOn: ['metabase-connections'] });
  protected readonly databases = invokeResource<MetabaseDatabase[]>('metabase.databases', () => ({ connectionId: this.connectionId() }));
  protected readonly tables = invokeResource<MetabaseTable[]>('metabase.tables', () => ({ connectionId: this.connectionId(), databaseId: this.databaseId() }), {
    enabled: () => this.databaseId() !== null,
  });
  private readonly database = computed(() => this.databases.value()?.find((d) => d.id === this.databaseId()) ?? null);
  protected readonly sqlKind = computed(() => sqlKindOf(this.database()?.engine));
  protected readonly dialect = computed<SqlDialect>(() => this.sqlKind() ?? 'standard');
  protected readonly sqlSchema = computed<SQLNamespace | undefined>(() => tablesSchema(this.tables.value()));
  protected readonly exportName = computed(() => this.tab().title || 'query');
  protected readonly exportSource = computed<MetabaseExportSource | null>(() => this.ran());

  constructor() {
    // A tab opened without a database takes the first one Metabase lists.
    effect(() => {
      const first = this.databases.value()?.[0];
      if (this.databaseId() === null && first) this.databaseId.set(first.id);
    });
    // The text and database live in the tab (debounced), so they are restored with the workspace.
    effect((onCleanup) => {
      const state: QueryTabState = { connectionId: this.connectionId(), databaseId: this.databaseId(), sql: this.sql() };
      const timer = setTimeout(() => {
        const tab = untracked(this.tab);
        const next = { ...tab.data, ...state };
        if (JSON.stringify(next) !== JSON.stringify(tab.data)) this.tabs.updateTab(untracked(this.scope), tab.id, { data: next });
      }, 300);
      onCleanup(() => clearTimeout(timer));
    });
  }

  protected pickDatabase(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    this.databaseId.set(value === '' ? null : Number(value));
  }

  protected async run(): Promise<void> {
    const databaseId = this.databaseId();
    const sql = (this.editor()?.selectedText() || this.sql()).trim();
    if (databaseId === null || !sql || this.running()) return;
    this.running.set(true);
    this.error.set(null);
    try {
      this.result.set(await this.host.invoke<DbQueryResult>('metabase.query.run', { connectionId: this.connectionId(), databaseId, sql }));
      this.ran.set({ databaseId, sql });
    } catch (err) {
      this.error.set(toErrorPayload(err));
    } finally {
      this.running.set(false);
    }
  }

  private stored(): Partial<QueryTabState> {
    return untracked(() => (this.tab().data ?? {}) as Partial<QueryTabState>);
  }
}
