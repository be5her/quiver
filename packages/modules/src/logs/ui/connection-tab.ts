import { Component, DestroyRef, computed, effect, inject, input, linkedSignal, signal, untracked } from '@angular/core';
import {
  LOGS_RANGES,
  compareLogEntries,
  composeLogsQuery,
  describeLogsConnection,
  logLevelTone,
  logsConnectionAddress,
  logsConnectionReady,
  logsFollowRange,
  toErrorPayload,
  type ErrorPayload,
  type LogEntry,
  type LogsConnectionSummary,
  type LogsFieldCount,
  type LogsFilter,
  type LogsHits,
  type LogsQueryResult,
} from '@quiver/core';
import { Button, CodeEditor, HostBridge, Icon, IconButton, Select, Spinner, TabsState, Toasts, injectHostEvent, invokeResource, type Tab, type TabComponent } from '@quiver/ui';
import { Copy, LogIn, Logs, Pause, Play, Radio, Settings2, X } from 'lucide';
import { LogsActions } from './logs-actions';
import { LogsEntryDetail } from './logs-entry-detail';
import { type LogsScope, LogsFilterPicker } from './logs-filter-picker';
import { clockTime, connectionStateLabel, dayTime, levelDot, levelText, oneLine, sessionDot } from './logs-format';
import { LogsHistogram } from './logs-histogram';
import { LogsSetup } from './logs-setup';

const LIMITS = [100, 500, 1000, 5000];
/** How often a followed view asks for new entries. */
const FOLLOW_MS = 5000;
/** Entries a followed view keeps; older ones drop off the bottom. */
const FOLLOW_KEEP = 5000;
const LEVEL_FIELD = 'level';

interface TabState {
  query: string;
  filters: LogsFilter[];
  range: string;
  limit: number;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * One VictoriaLogs data source through Grafana, or a VictoriaLogs server directly: a LogsQL line, filters that are one click from any
 * field, a histogram, the entries newest first and the one picked in full. The query, filters, range
 * and limit live in the tab, so they come back with it.
 */
@Component({
  selector: 'q-logs-connection-tab',
  imports: [Button, CodeEditor, Icon, IconButton, LogsEntryDetail, LogsFilterPicker, LogsHistogram, LogsSetup, Select, Spinner],
  templateUrl: './connection-tab.html',
  host: { class: 'contents' },
})
export class LogsConnectionTab implements TabComponent {
  private readonly host = inject(HostBridge);
  private readonly tabs = inject(TabsState);
  private readonly toasts = inject(Toasts);
  protected readonly logs = inject(LogsActions);

  readonly tab = input.required<Tab>();
  readonly scope = input.required<string>();

  protected readonly icons = { Copy, LogIn, Logs, Pause, Play, Radio, Settings2, X };
  protected readonly ranges = LOGS_RANGES;
  protected readonly limits = LIMITS;
  protected readonly clockTime = clockTime;
  protected readonly dayTime = dayTime;
  protected readonly levelText = levelText;
  protected readonly levelDot = levelDot;
  protected readonly oneLine = oneLine;

  private readonly connectionId = computed(() => String(this.tab().data?.['id'] ?? ''));
  protected readonly summary = invokeResource<LogsConnectionSummary>('logs.connection.get', () => ({ id: this.connectionId() }), { refreshOn: ['logs-connections'] });
  protected readonly loadError = computed(() => this.summary.error()?.message ?? null);
  protected readonly configured = computed(() => {
    const c = this.summary.value();
    return Boolean(c && logsConnectionReady(c));
  });
  /** A VictoriaLogs server queried directly: no sign-in, so no Sign in buttons. */
  protected readonly direct = computed(() => this.summary.value()?.kind === 'victorialogs');
  protected readonly settingsOpen = signal(false);
  protected readonly showSetup = computed(() => this.settingsOpen() || (this.summary.value() !== undefined && !this.configured()));
  protected readonly where = computed(() => describeLogsConnection(this.summary.value() ?? { grafanaUrl: '', datasourceName: '' }));
  protected readonly dot = computed(() => {
    const c = this.summary.value();
    return c ? sessionDot(c.session) : '';
  });
  protected readonly sessionText = computed(() => {
    const c = this.summary.value();
    return c ? connectionStateLabel(c) : '';
  });

  // What the controls hold, restored from the tab once it is known.
  private readonly restored = computed(() => this.tab().id);
  protected readonly query = linkedSignal({ source: this.restored, computation: () => this.stored().query ?? '*' });
  protected readonly filters = linkedSignal<string, LogsFilter[]>({ source: this.restored, computation: () => this.stored().filters ?? [] });
  protected readonly range = linkedSignal({ source: this.restored, computation: () => this.stored().range ?? '15m' });
  protected readonly limit = linkedSignal({ source: this.restored, computation: () => this.stored().limit ?? 500 });

  /** The query the results, the histogram and the pickers belong to: the last one that ran. */
  protected readonly applied = signal<LogsScope | null>(null);
  protected readonly running = signal(false);
  protected readonly result = signal<LogsQueryResult | null>(null);
  protected readonly entries = signal<LogEntry[]>([]);
  protected readonly error = signal<ErrorPayload | null>(null);
  protected readonly follow = signal(false);
  protected readonly selectedId = signal<string | null>(null);
  protected readonly selected = computed(() => this.entries().find((e) => e.id === this.selectedId()) ?? null);
  protected readonly composed = computed(() => composeLogsQuery(this.query(), this.filters()));
  protected readonly wide = computed(() => {
    const scope = this.applied();
    return scope ? Number(scope.to) - Number(scope.from) > 86_400_000 : false;
  });

  protected readonly hits = invokeResource<LogsHits>('logs.hits', () => this.applied(), { enabled: () => this.applied() !== null });
  /** Level chips count the other filters only, so every level stays one click away. */
  protected readonly levels = invokeResource<LogsFieldCount[]>(
    'logs.values',
    () => {
      const scope = this.applied();
      return scope && { ...scope, filters: scope.filters.filter((f) => f.field !== LEVEL_FIELD), field: LEVEL_FIELD, limit: 12 };
    },
    { enabled: () => this.applied() !== null },
  );
  protected readonly levelChips = computed(() =>
    (this.levels.value() ?? [])
      .filter((l) => l.name)
      .map((l) => ({ ...l, tone: logLevelTone(l.name), on: this.filters().some((f) => f.field === LEVEL_FIELD && f.value === l.name && !f.exclude) })),
  );

  private autoRan = false;
  private following: ReturnType<typeof setInterval> | null = null;
  private polling = false;

  constructor() {
    injectHostEvent('logs.changed', (p) => p.reason === 'session' && this.summary.reload());

    // Ask Grafana once whether this machine is signed in (or a direct server whether it answers); the answer comes back as a session event.
    let checked = false;
    effect(() => {
      const c = this.summary.value();
      if (checked || !c || !logsConnectionAddress(c)) return;
      checked = true;
      untracked(() => void this.host.invoke('logs.session', { id: c.id }).catch(() => {}));
    });

    // A configured connection runs its query when the tab opens.
    effect(() => {
      const c = this.summary.value();
      if (this.autoRan || !c || !this.configured() || c.session.state === 'signing-in') return;
      this.autoRan = true;
      untracked(() => void this.run());
    });

    effect(() => {
      const name = this.summary.value()?.name;
      const tab = this.tab();
      if (name && tab.title !== name) untracked(() => this.tabs.updateTab(this.scope(), tab.id, { title: name }));
    });

    effect(() => {
      if (this.follow()) untracked(() => this.startFollowing());
      else this.stopFollowing();
    });
    inject(DestroyRef).onDestroy(() => this.stopFollowing());
  }

  protected async run(): Promise<void> {
    const c = this.summary.value();
    if (!c || !this.configured()) return;
    const span = LOGS_RANGES.find((r) => r.id === this.range()) ?? LOGS_RANGES[1];
    const to = Date.now();
    const from = to - spanMs(span.id);
    const scope: LogsScope = { id: c.id, query: this.query(), filters: this.filters(), from: String(from), to: String(to) };
    // The histogram and the level chips follow, since the scope they read changed.
    this.applied.set(scope);
    this.persist();
    this.running.set(true);
    this.error.set(null);
    try {
      const out = await this.host.invoke<LogsQueryResult>('logs.query', { ...scope, limit: this.limit() });
      if (this.applied() !== scope) return;
      this.result.set(out);
      this.entries.set(out.entries);
      if (this.selectedId() && !out.entries.some((e) => e.id === this.selectedId())) this.selectedId.set(null);
    } catch (err) {
      if (this.applied() !== scope) return;
      this.error.set(toErrorPayload(err));
      this.result.set(null);
      this.entries.set([]);
      this.follow.set(false);
    } finally {
      if (this.applied() === scope) this.running.set(false);
    }
  }

  protected async signInAndRun(): Promise<void> {
    const c = this.summary.value();
    if (c && (await this.logs.signIn(c))) void this.run();
  }

  protected addFilter(filter: LogsFilter): void {
    this.filters.update((list) => [...list.filter((f) => !(f.field === filter.field && f.value === filter.value)), filter]);
    void this.run();
  }

  protected toggleFilter(index: number): void {
    this.filters.update((list) => list.map((f, i) => (i === index ? { ...f, exclude: !f.exclude } : f)));
    void this.run();
  }

  protected removeFilter(index: number): void {
    this.filters.update((list) => list.filter((_f, i) => i !== index));
    void this.run();
  }

  protected toggleLevel(level: string): void {
    const on = this.filters().some((f) => f.field === LEVEL_FIELD && f.value === level && !f.exclude);
    this.filters.update((list) => {
      const others = list.filter((f) => f.field !== LEVEL_FIELD || f.exclude);
      return on ? others : [...others, { field: LEVEL_FIELD, value: level, exclude: false }];
    });
    void this.run();
  }

  protected pickRange(event: Event): void {
    this.range.set((event.target as HTMLSelectElement).value);
    void this.run();
  }

  protected pickLimit(event: Event): void {
    this.limit.set(Number((event.target as HTMLSelectElement).value));
    void this.run();
  }

  protected pick(id: string): void {
    this.selectedId.update((current) => (current === id ? null : id));
  }

  /** Pipe results (stats, field values) have no message: their columns stand in for it. */
  protected fieldsLine(entry: LogEntry): string {
    return Object.entries(entry.fields)
      .map(([k, v]) => `${k}=${v}`)
      .join('  ');
  }

  protected copyQuery(): void {
    this.toasts.copy(this.result()?.query ?? this.composed(), 'Query copied');
  }

  protected setupSaved(saved: LogsConnectionSummary): void {
    const first = !this.configured() && logsConnectionReady(saved);
    this.summary.reload();
    // The first data source picked makes the connection usable: it runs once the summary has it.
    if (first) this.autoRan = false;
  }

  protected closeSetup(): void {
    this.settingsOpen.set(false);
    void this.run();
  }

  private stored(): Partial<TabState> {
    return untracked(() => (this.tab().data?.['state'] as Partial<TabState> | undefined) ?? {});
  }

  private persist(): void {
    const tab = this.tab();
    const state: TabState = { query: this.query(), filters: this.filters(), range: this.range(), limit: this.limit() };
    if (!sameJson(tab.data?.['state'], state)) this.tabs.updateTab(this.scope(), tab.id, { data: { ...tab.data, state } });
  }

  private startFollowing(): void {
    if (this.following) return;
    this.following = setInterval(() => void this.poll(), FOLLOW_MS);
    void this.poll();
  }

  private stopFollowing(): void {
    if (this.following) clearInterval(this.following);
    this.following = null;
  }

  /**
   * Ask for what arrived since the newest entry on screen and put it on top. The poll looks a little
   * past this machine's clock, so a writer whose clock runs ahead neither hides its entries nor ends
   * the range before it starts once one of them is on screen.
   */
  private async poll(): Promise<void> {
    const scope = this.applied();
    if (!scope || this.polling || this.running()) return;
    this.polling = true;
    try {
      const { from, to } = logsFollowRange(this.entries()[0]?.ns ?? null, scope.from);
      const out = await this.host.invoke<LogsQueryResult>('logs.query', { ...scope, from, to, limit: this.limit() });
      if (this.applied() !== scope || !this.follow()) return;
      const known = new Set(this.entries().map((e) => e.id));
      const fresh = out.entries.filter((e) => !known.has(e.id));
      if (fresh.length) this.entries.update((list) => [...fresh, ...list].sort(compareLogEntries).slice(0, FOLLOW_KEEP));
    } catch (err) {
      this.follow.set(false);
      this.toasts.error(err);
    } finally {
      this.polling = false;
    }
  }
}

function spanMs(id: string): number {
  const n = Number.parseInt(id, 10);
  const unit = id.slice(String(n).length);
  return n * ({ m: 60_000, h: 3_600_000, d: 86_400_000 }[unit] ?? 60_000);
}
