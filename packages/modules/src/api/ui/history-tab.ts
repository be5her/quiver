import { Component, DestroyRef, computed, inject, input, signal } from '@angular/core';
import { HttpMethodSchema, historyStatusLabel, matchesHistory, shortRelativeTime, type HistoryEntry } from '@quiver/core';
import { Button, EmptyState, METHOD_COLORS, Select, Spinner, Toasts, formatMs, invokeResource, statusColor, type Tab, type TabComponent } from '@quiver/ui';
import { Save, Search, Trash2 } from 'lucide';
import { ApiActions } from './api-actions';

type StatusFilter = 'all' | '2xx' | '3xx' | '4xx' | '5xx' | 'failed' | 'cancelled';

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: 'Any status' },
  { value: '2xx', label: '2xx' },
  { value: '3xx', label: '3xx' },
  { value: '4xx', label: '4xx' },
  { value: '5xx', label: '5xx' },
  { value: 'failed', label: 'Failed' },
  { value: 'cancelled', label: 'Cancelled' },
];

function statusMatches(entry: HistoryEntry, filter: StatusFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'failed':
      return entry.status === null && entry.error !== 'Cancelled';
    case 'cancelled':
      return entry.status === null && entry.error === 'Cancelled';
    default:
      return entry.status !== null && Math.floor(entry.status / 100) === Number(filter[0]);
  }
}

/** Every request sent from this workspace (up to 500), searchable and filterable, opened as drafts or kept as requests. */
@Component({
  selector: 'q-api-history-tab',
  imports: [Button, EmptyState, Select, Spinner],
  templateUrl: './history-tab.html',
  host: { class: 'flex flex-col h-full min-h-0' },
})
export class HistoryTab implements TabComponent {
  private readonly toasts = inject(Toasts);
  protected readonly api = inject(ApiActions);

  readonly tab = input.required<Tab>();
  readonly scope = input.required<string>();

  protected readonly icons = { Save, Search, Trash2 };
  protected readonly methods = HttpMethodSchema.options;
  protected readonly statusFilters = STATUS_FILTERS;
  protected readonly methodColors = METHOD_COLORS;
  protected readonly statusColor = statusColor;
  protected readonly statusLabel = historyStatusLabel;
  protected readonly formatMs = formatMs;
  protected readonly history = invokeResource<HistoryEntry[]>('api.history.list', () => ({ limit: 500 }), { refreshOn: ['history'] });

  protected readonly search = signal('');
  protected readonly method = signal<string>('all');
  protected readonly status = signal<StatusFilter>('all');
  protected readonly entries = computed(() =>
    (this.history.value() ?? []).filter((e) => (this.method() === 'all' || e.method === this.method()) && statusMatches(e, this.status()) && matchesHistory(e, this.search())),
  );
  protected readonly total = computed(() => this.history.value()?.length ?? 0);

  private readonly now = signal(Date.now());

  constructor() {
    const timer = setInterval(() => this.now.set(Date.now()), 30_000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  protected text(event: Event): string {
    return (event.target as HTMLInputElement | HTMLSelectElement).value;
  }

  protected setStatus(event: Event): void {
    this.status.set(this.text(event) as StatusFilter);
  }

  protected age(entry: HistoryEntry): string {
    return shortRelativeTime(Date.parse(entry.at) - this.now());
  }

  protected time(entry: HistoryEntry): string {
    return new Date(entry.at).toLocaleString();
  }

  protected save(event: MouseEvent, entry: HistoryEntry): void {
    event.stopPropagation();
    this.api.saveHistoryEntry(entry).catch((err) => this.toasts.error(err));
  }

  protected clear(): void {
    this.api.clearHistory().catch((err) => this.toasts.error(err));
  }
}
