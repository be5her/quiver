import { Component, computed, effect, inject, input, signal, untracked, viewChild, type OnInit } from '@angular/core';
import { toErrorPayload, type DbConnectionSummary, type DbQueryResult, type DbTable, type ErrorPayload, type SavedQuery } from '@quiver/core';
import {
  Badge,
  Button,
  CodeEditor,
  Dialogs,
  HostBridge,
  Icon,
  IconButton,
  Segment,
  Segmented,
  Select,
  TabsState,
  Toasts,
  invokeResource,
  type SQLNamespace,
  type Tab,
  type TabComponent,
} from '@quiver/ui';
import { Copy, Play, Save } from 'lucide';
import { DbError } from './db-error';
import { firstLine, formatCount, formatDuration, rowsToCsv, rowsToJson } from './db-format';
import { KindIcon } from './kind-icon';
import { QueryResultView } from './query-result-view';

const MAX_ROWS_OPTIONS = [100, 500, 1000, 5000];

function resultLabel(r: DbQueryResult): string {
  if (r.kind === 'rows') return `${formatCount(r.rowCount)} rows`;
  if (r.kind === 'affected') return `${formatCount(r.affectedRows ?? 0)} affected`;
  return 'reply';
}

function summarize(results: DbQueryResult[] | null): string | null {
  if (!results?.length) return null;
  const total = results.reduce((n, r) => n + r.durationMs, 0);
  if (results.length === 1) {
    const r = results[0];
    if (r.kind === 'rows') return `${formatCount(r.rowCount)} row${r.rowCount === 1 ? '' : 's'}${r.truncated ? ' (truncated)' : ''} · ${formatDuration(r.durationMs)}`;
    if (r.kind === 'affected') return `${formatCount(r.affectedRows ?? 0)} affected · ${formatDuration(r.durationMs)}`;
    return `reply · ${formatDuration(r.durationMs)}`;
  }
  return `${results.length} statements · ${formatDuration(total)}`;
}

/**
 * A SQL (or Redis console) editor on a connection, with its results. Ctrl+Enter runs the selection or
 * everything; Ctrl+S saves it with the project. The text is kept in the tab, so it survives restarts.
 */
@Component({
  selector: 'q-query-tab',
  imports: [Badge, Button, CodeEditor, DbError, Icon, IconButton, KindIcon, QueryResultView, Segment, Segmented, Select],
  templateUrl: './query-tab.html',
  host: { class: 'flex flex-col h-full min-h-0', '(keydown)': 'shortcut($event)' },
})
export class QueryTab implements TabComponent, OnInit {
  private readonly host = inject(HostBridge);
  private readonly tabs = inject(TabsState);
  private readonly toasts = inject(Toasts);
  private readonly dialogs = inject(Dialogs);
  private readonly editor = viewChild(CodeEditor);

  readonly tab = input.required<Tab>();
  readonly scope = input.required<string>();

  protected readonly icons = { Copy, Play, Save };
  protected readonly maxRowsOptions = MAX_ROWS_OPTIONS;
  protected readonly jsonIcon = '{}';
  protected readonly text = signal('');
  protected readonly connectionId = signal<string | null>(null);
  protected readonly database = signal<string | null>(null);
  protected readonly saved = signal<SavedQuery | null>(null);
  protected readonly maxRows = signal(500);
  protected readonly running = signal(false);
  protected readonly results = signal<DbQueryResult[] | null>(null);
  protected readonly error = signal<ErrorPayload | null>(null);
  protected readonly activeResult = signal('0');
  private queryId: string | undefined;

  protected readonly connections = invokeResource<DbConnectionSummary[]>('db.connection.list', () => ({}), { refreshOn: ['db-connections'] });
  protected readonly connection = computed(() => this.connections.value()?.find((c) => c.id === this.connectionId()) ?? null);
  protected readonly kind = computed(() => this.connection()?.kind ?? null);
  protected readonly databases = invokeResource<string[]>('db.schema.databases', () => ({ connectionId: this.connectionId() }), { enabled: () => this.kind() === 'mysql' });
  private readonly tables = invokeResource<DbTable[]>('db.schema.tables', () => ({ connectionId: this.connectionId(), database: this.database() }), {
    enabled: () => (this.kind() === 'mysql' ? Boolean(this.database() || this.connection()?.database) : this.kind() === 'sqlite'),
  });
  protected readonly sqlSchema = computed<SQLNamespace | undefined>(() => {
    const tables = this.tables.value();
    return tables ? Object.fromEntries(tables.map((t) => [t.name, []])) : undefined;
  });
  protected readonly dirty = computed(() => {
    const saved = this.saved();
    return saved ? this.text() !== saved.text || (this.connectionId() ?? null) !== saved.connectionId || (this.database() ?? null) !== saved.database : false;
  });
  protected readonly current = computed(() => this.results()?.[Number(this.activeResult())] ?? null);
  protected readonly summary = computed(() => summarize(this.results()));
  protected readonly resultTabs = computed(() => (this.results() ?? []).map((r, i) => ({ value: String(i), label: `${i + 1}: ${resultLabel(r)}` })));
  protected readonly placeholder = computed(() =>
    this.kind() === 'redis'
      ? 'One command per line, e.g.\nSCAN 0 MATCH user:* COUNT 100\nHGETALL user:1'
      : 'SELECT * FROM table_name LIMIT 100;\n\nCtrl+Enter runs the selection, or everything when nothing is selected.',
  );

  constructor() {
    // Fall back to the first connection so a fresh tab is immediately runnable.
    effect(() => {
      const first = this.connections.value()?.[0];
      if (!this.connectionId() && first) this.connectionId.set(first.id);
    });

    // Keep the editor's state in the tab (debounced), so it is restored with the workspace.
    effect((onCleanup) => {
      const state = { queryId: this.queryId, connectionId: this.connectionId(), database: this.database(), text: this.text() };
      const timer = setTimeout(() => {
        const tab = untracked(this.tab);
        const next = { ...tab.data, id: tab.data?.['id'], ...state };
        if (JSON.stringify(next) !== JSON.stringify(tab.data)) this.tabs.updateTab(untracked(this.scope), tab.id, { data: next });
      }, 300);
      onCleanup(() => clearTimeout(timer));
    });

    effect(() => {
      const dirty = this.dirty();
      const tab = this.tab();
      if (tab.dirty !== dirty) untracked(() => this.tabs.updateTab(this.scope(), tab.id, { dirty }));
    });

    // An unsaved query is named after its first line.
    effect(() => {
      if (this.saved()) return;
      const title = firstLine(this.text(), 32) || 'Query';
      const tab = this.tab();
      if (tab.title !== title) untracked(() => this.tabs.updateTab(this.scope(), tab.id, { title }));
    });
  }

  ngOnInit(): void {
    const data = this.tab().data ?? {};
    this.queryId = typeof data['queryId'] === 'string' ? data['queryId'] : undefined;
    this.text.set(typeof data['text'] === 'string' ? data['text'] : '');
    this.connectionId.set(typeof data['connectionId'] === 'string' ? data['connectionId'] : null);
    this.database.set(typeof data['database'] === 'string' ? data['database'] : null);
    if (this.queryId) void this.loadSaved(this.queryId, data);
  }

  protected shortcut(event: KeyboardEvent): void {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      void this.save();
    }
  }

  protected pickConnection(event: Event): void {
    this.connectionId.set((event.target as HTMLSelectElement).value || null);
  }

  protected pickDatabase(event: Event): void {
    this.database.set((event.target as HTMLSelectElement).value || null);
  }

  protected pickMaxRows(event: Event): void {
    this.maxRows.set(Number((event.target as HTMLSelectElement).value));
  }

  protected async run(): Promise<void> {
    const connectionId = this.connectionId();
    if (!connectionId || this.running()) return;
    const query = (this.editor()?.selectedText() || this.text()).trim();
    if (!query) return;
    this.running.set(true);
    this.error.set(null);
    try {
      const out = await this.host.invoke<DbQueryResult[]>('db.query.run', { connectionId, query, database: this.database() || undefined, maxRows: this.maxRows() });
      this.results.set(out);
      this.activeResult.set(String(Math.max(0, out.length - 1)));
    } catch (err) {
      this.error.set(toErrorPayload(err));
    } finally {
      this.running.set(false);
    }
  }

  protected async save(): Promise<void> {
    const saved = this.saved();
    let name = saved?.name;
    if (!name) {
      name = (await this.dialogs.prompt({ title: 'Save query', label: 'Name', defaultValue: firstLine(this.text(), 40), confirmLabel: 'Save' }))?.trim();
      if (!name) return;
    }
    const connectionId = this.connectionId();
    const database = this.database();
    const text = this.text();
    try {
      const stored = await this.host.invoke<SavedQuery>('db.query.save', { query: { id: saved?.id, name, connectionId, database, text } });
      this.saved.set(stored);
      this.queryId = stored.id;
      const tab = this.tab();
      this.tabs.updateTab(this.scope(), tab.id, { title: stored.name, data: { ...tab.data, id: stored.id, queryId: stored.id, connectionId, database, text } });
      this.toasts.notify('Query saved', 'success');
    } catch (err) {
      this.toasts.error(err);
    }
  }

  protected copyRows(format: 'json' | 'csv'): void {
    const current = this.current();
    if (current?.kind !== 'rows') return;
    const text = format === 'json' ? rowsToJson(current.columns, current.rows) : rowsToCsv(current.columns, current.rows);
    void navigator.clipboard.writeText(text).then(() => this.toasts.notify(`Copied ${format.toUpperCase()}`, 'success'));
  }

  /** A saved query loads once; the tab's own text then wins, so unsaved edits survive restarts. */
  private async loadSaved(id: string, data: Record<string, unknown>): Promise<void> {
    try {
      const query = await this.host.invoke<SavedQuery>('db.query.get', { id });
      this.saved.set(query);
      if (typeof data['text'] !== 'string' || data['text'] === '') this.text.set(query.text);
      if (!data['connectionId']) this.connectionId.set(query.connectionId);
      if (!data['database']) this.database.set(query.database);
    } catch (err) {
      this.error.set(toErrorPayload(err));
    }
  }
}
