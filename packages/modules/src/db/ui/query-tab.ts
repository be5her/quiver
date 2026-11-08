import { Component, computed, effect, inject, input, signal, untracked, viewChild, type OnInit } from '@angular/core';
import {
  DB_QUERY_CANCELLED,
  findVariableSpans,
  isDynamicVariable,
  isSelectLike,
  redisScriptIsReadOnly,
  resolveTemplate,
  scriptIsReadOnly,
  statementAt,
  toErrorPayload,
  wrapForPage,
  type DbQueryResult,
  type DbTableColumns,
  type ErrorPayload,
  type SavedQuery,
  type SqlKind,
} from '@quiver/core';
import {
  Badge,
  Button,
  CodeEditor,
  Dialogs,
  HostBridge,
  Segment,
  Segmented,
  Select,
  TabsState,
  Toasts,
  invokeResource,
  type SQLNamespace,
  type Tab,
  type TabComponent,
  type VariableScope,
} from '@quiver/ui';
import { Check, CircleStop, GitBranch, Play, Save, Undo2 } from 'lucide';
import { ApiVariables } from '../../api/ui/api-variables';
import { DbActions, type DbConnectionRow } from './db-actions';
import { DbError } from './db-error';
import { AccessBadge } from './kind-icon';
import { ExportMenu, type ExportSource } from './export-menu';
import { firstLine, formatCount, formatDuration } from './db-format';
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

/** Completion namespace from the columns overview: tables with their columns and types. */
function completionSchema(tables: DbTableColumns[] | undefined, kind: SqlKind): SQLNamespace | undefined {
  if (!tables) return undefined;
  const quote = kind === 'mysql' ? '`' : '"';
  return Object.fromEntries(
    tables.map((t) => [
      t.name,
      t.columns.map((c) => ({
        label: c.name,
        type: 'property',
        detail: c.type,
        apply: /^[A-Za-z_][A-Za-z0-9_]*$/.test(c.name) ? undefined : `${quote}${c.name.replace(new RegExp(quote, 'g'), quote + quote)}${quote}`,
      })),
    ]),
  );
}

/**
 * A SQL (or Redis console) editor on a connection, with its results. Ctrl+Enter runs the selection or
 * everything, Ctrl+Shift+Enter the statement under the cursor; Ctrl+S saves it with the project.
 * `{{parameters}}` resolve from the API variables, the rest are asked for on each run and remembered.
 * The text is kept in the tab, so it survives restarts.
 */
@Component({
  selector: 'q-query-tab',
  imports: [AccessBadge, ApiVariables, Badge, Button, CodeEditor, DbError, ExportMenu, KindIcon, QueryResultView, Segment, Segmented, Select],
  templateUrl: './query-tab.html',
  host: { class: 'flex flex-col h-full min-h-0', '(keydown)': 'shortcut($event)' },
})
export class QueryTab implements TabComponent, OnInit {
  private readonly host = inject(HostBridge);
  private readonly tabs = inject(TabsState);
  private readonly toasts = inject(Toasts);
  private readonly dialogs = inject(Dialogs);
  private readonly db = inject(DbActions);
  private readonly editor = viewChild(CodeEditor);

  readonly tab = input.required<Tab>();
  readonly scope = input.required<string>();

  protected readonly icons = { Check, CircleStop, GitBranch, Play, Save, Undo2 };
  protected readonly maxRowsOptions = MAX_ROWS_OPTIONS;
  protected readonly text = signal('');
  protected readonly connectionId = signal<string | null>(null);
  protected readonly database = signal<string | null>(null);
  protected readonly saved = signal<SavedQuery | null>(null);
  protected readonly maxRows = signal(500);
  protected readonly running = signal(false);
  protected readonly cancelling = signal(false);
  protected readonly loadingMore = signal(false);
  protected readonly results = signal<DbQueryResult[] | null>(null);
  protected readonly error = signal<ErrorPayload | null>(null);
  protected readonly activeResult = signal('0');
  /** The last values given to `{{parameters}}`, offered again on the next run. */
  protected readonly params = signal<Record<string, string>>({});
  /** The query text as it last ran (parameters resolved), for "save all rows". */
  private readonly lastRun = signal<string | null>(null);
  private queryId: string | undefined;

  protected readonly connections = invokeResource<DbConnectionRow[]>('db.connection.list', () => ({}), { refreshOn: ['db-connections'] });
  protected readonly connection = computed(() => this.connections.value()?.find((c) => c.id === this.connectionId()) ?? null);
  protected readonly kind = computed(() => this.connection()?.kind ?? null);
  protected readonly sqlKind = computed<SqlKind | null>(() => {
    const kind = this.kind();
    return kind && kind !== 'redis' ? kind : null;
  });
  protected readonly hasSchemas = computed(() => this.kind() === 'mysql' || this.kind() === 'postgres');
  protected readonly databases = invokeResource<string[]>('db.schema.databases', () => ({ connectionId: this.connectionId() }), { enabled: () => this.hasSchemas() });
  private readonly columns = invokeResource<DbTableColumns[]>('db.schema.columns', () => ({ connectionId: this.connectionId(), database: this.database() }), {
    enabled: () => (this.kind() === 'mysql' ? Boolean(this.database() || this.connection()?.database) : this.sqlKind() !== null),
    refreshOn: () => (this.connectionId() ? [`db-data:${this.connectionId()}`] : []),
  });
  private readonly variables = invokeResource<VariableScope>('api.variables.list', () => ({}), { refreshOn: ['environments'], refreshOnState: ['api.activeEnvironment'], refreshOnEvents: ['config.changed'] });
  protected readonly sqlSchema = computed<SQLNamespace | undefined>(() => completionSchema(this.columns.value(), this.sqlKind() ?? 'mysql'));
  protected readonly dirty = computed(() => {
    const saved = this.saved();
    return saved ? this.text() !== saved.text || (this.connectionId() ?? null) !== saved.connectionId || (this.database() ?? null) !== saved.database : false;
  });
  protected readonly current = computed(() => this.results()?.[Number(this.activeResult())] ?? null);
  protected readonly summary = computed(() => summarize(this.results()));
  protected readonly resultTabs = computed(() => (this.results() ?? []).map((r, i) => ({ value: String(i), label: `${i + 1}: ${resultLabel(r)}` })));
  /** A truncated SELECT can fetch its next page. */
  protected readonly canLoadMore = computed(() => {
    const r = this.current();
    return Boolean(r && r.kind === 'rows' && r.truncated && this.sqlKind() && isSelectLike(r.statement));
  });
  protected readonly canCancel = computed(() => this.running() && (this.kind() === 'mysql' || this.kind() === 'postgres'));
  protected readonly inTransaction = computed(() => Boolean(this.connection()?.inTransaction));
  protected readonly exportSource = computed<ExportSource | null>(() => {
    const query = this.lastRun();
    return query && this.sqlKind() ? { query, database: this.database() } : null;
  });
  protected readonly placeholder = computed(() =>
    this.kind() === 'redis'
      ? 'One command per line, e.g.\nSCAN 0 MATCH user:* COUNT 100\nHGETALL user:1'
      : 'SELECT * FROM table_name WHERE id = {{id}} LIMIT 100;\n\nCtrl+Enter runs the selection, or everything when nothing is selected; Ctrl+Shift+Enter runs the statement under the cursor.',
  );
  protected readonly editorDialect = computed<SqlKind | 'standard'>(() => this.sqlKind() ?? 'standard');

  constructor() {
    // Fall back to the first connection so a fresh tab is immediately runnable.
    effect(() => {
      const first = this.connections.value()?.[0];
      if (!this.connectionId() && first) this.connectionId.set(first.id);
    });
    // Keep the editor's state in the tab (debounced), so it is restored with the workspace.
    effect((onCleanup) => {
      const state = { queryId: this.queryId, connectionId: this.connectionId(), database: this.database(), text: this.text(), params: this.params() };
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
    if (data['params'] && typeof data['params'] === 'object') this.params.set(data['params'] as Record<string, string>);
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
    this.database.set(null);
  }

  protected pickDatabase(event: Event): void {
    this.database.set((event.target as HTMLSelectElement).value || null);
  }

  protected pickMaxRows(event: Event): void {
    this.maxRows.set(Number((event.target as HTMLSelectElement).value));
  }

  /** The selection, everything, or (for `current`) the statement under the cursor. */
  private textToRun(mode: 'all' | 'current'): string {
    const editor = this.editor();
    if (mode === 'current') return statementAt(this.text(), editor?.cursorOffset() ?? 0)?.text ?? '';
    return (editor?.selectedText() || this.text()).trim();
  }

  /** Fill `{{parameters}}` from the API variables; ask for the rest, offering the last values. Null when the user cancels. */
  private async resolveParameters(query: string): Promise<string | null> {
    const names = [...new Set(findVariableSpans(query).map((s) => s.name))];
    if (!names.length) return query;
    const known: Record<string, string> = {};
    for (const v of this.variables.value()?.variables ?? []) if (v.value !== null) known[v.name] = v.value;
    const params = { ...this.params() };
    for (const name of names) {
      if (name in known || isDynamicVariable(name)) continue;
      const value = await this.dialogs.prompt({ title: `Value for {{${name}}}`, label: name, defaultValue: params[name] ?? '', confirmLabel: 'Run' });
      if (value === null) return null;
      params[name] = value;
    }
    this.params.set(params);
    return resolveTemplate(query, { ...known, ...params });
  }

  protected async run(mode: 'all' | 'current' = 'all'): Promise<void> {
    const connectionId = this.connectionId();
    const connection = this.connection();
    if (!connectionId || !connection || this.running()) return;
    const raw = this.textToRun(mode);
    if (!raw) return;
    const query = await this.resolveParameters(raw);
    if (query === null) return;
    const writes = connection.kind === 'redis' ? !redisScriptIsReadOnly(query) : !scriptIsReadOnly(query);
    if (writes && !(await this.db.confirmWrite(connection, `The script "${firstLine(query, 60)}" can change data.`))) return;
    this.running.set(true);
    this.error.set(null);
    try {
      const out = await this.host.invoke<DbQueryResult[]>('db.query.run', { connectionId, query, database: this.database() || undefined, maxRows: this.maxRows() });
      this.results.set(out);
      this.lastRun.set(query);
      this.activeResult.set(String(Math.max(0, out.length - 1)));
    } catch (err) {
      const payload = toErrorPayload(err);
      if (payload.code === DB_QUERY_CANCELLED) this.toasts.notify('Query cancelled', 'info');
      else this.error.set(payload);
    } finally {
      this.running.set(false);
      this.cancelling.set(false);
    }
  }

  protected async cancel(): Promise<void> {
    const connectionId = this.connectionId();
    if (!connectionId || !this.running() || this.cancelling()) return;
    this.cancelling.set(true);
    try {
      const { supported, cancelled } = await this.host.invoke<{ supported: boolean; cancelled: boolean }>('db.query.cancel', { connectionId });
      if (!supported) this.toasts.notify('This database cannot interrupt a running statement', 'info');
      else if (!cancelled) this.toasts.notify('Nothing was running any more', 'info');
    } catch (err) {
      this.toasts.error(err);
      this.cancelling.set(false);
    }
  }

  /** Fetch the next page of a truncated SELECT by wrapping it as a subquery with LIMIT and OFFSET. */
  protected async loadMore(): Promise<void> {
    const index = Number(this.activeResult());
    const current = this.results()?.[index];
    const connectionId = this.connectionId();
    if (!current || current.kind !== 'rows' || !connectionId || this.loadingMore()) return;
    this.loadingMore.set(true);
    try {
      const limit = this.maxRows();
      const [page] = await this.host.invoke<DbQueryResult[]>('db.query.run', {
        connectionId,
        query: wrapForPage(current.statement, limit, current.rows.length),
        database: this.database() || undefined,
        maxRows: limit,
        record: false,
      });
      const rows = [...current.rows, ...(page?.rows ?? [])];
      const merged: DbQueryResult = { ...current, rows, rowCount: rows.length, truncated: Boolean(page && page.rows.length >= limit), durationMs: current.durationMs + (page?.durationMs ?? 0) };
      this.results.update((all) => (all ? all.map((r, i) => (i === index ? merged : r)) : all));
    } catch (err) {
      this.toasts.error(err);
    } finally {
      this.loadingMore.set(false);
    }
  }

  protected async transaction(action: 'begin' | 'commit' | 'rollback'): Promise<void> {
    const connection = this.connection();
    if (!connection) return;
    if (action === 'commit' && !(await this.db.confirmWrite(connection, 'Committing makes every change of the transaction permanent.'))) return;
    try {
      await this.host.invoke('db.transaction', { connectionId: connection.id, action });
      this.toasts.notify(action === 'begin' ? `Transaction started on ${connection.name}; every tab on it is inside until commit or rollback` : action === 'commit' ? 'Committed' : 'Rolled back', action === 'rollback' ? 'info' : 'success');
    } catch (err) {
      this.toasts.error(err);
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
