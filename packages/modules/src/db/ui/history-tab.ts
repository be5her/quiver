import { Component, computed, inject, input, signal } from '@angular/core';
import type { DbHistoryEntry } from '@quiver/core';
import { Autofocus, Button, EmptyState, Icon, IconButton, Input, Select, Spinner, Toasts, invokeResource, type Tab, type TabComponent } from '@quiver/ui';
import { Copy, Play, Save, Search, Trash2 } from 'lucide';
import { DbActions, type DbConnectionRow } from './db-actions';
import { firstLine, formatAgo, formatCount, formatDuration } from './db-format';

const LIMIT = 500;

/** Every query run in the workspace, searchable, filtered by connection and outcome; each opens in a query tab or becomes a saved query. */
@Component({
  selector: 'q-db-history-tab',
  imports: [Autofocus, Button, EmptyState, Icon, IconButton, Input, Select, Spinner],
  templateUrl: './history-tab.html',
  host: { class: 'flex flex-col h-full min-h-0' },
})
export class HistoryTab implements TabComponent {
  private readonly toasts = inject(Toasts);
  protected readonly db = inject(DbActions);

  readonly tab = input.required<Tab>();
  readonly scope = input.required<string>();

  protected readonly icons = { Copy, Play, Save, Search, Trash2 };
  protected readonly search = signal('');
  protected readonly connectionId = signal('');
  protected readonly outcome = signal<'all' | 'ok' | 'failed'>('all');
  protected readonly firstLine = firstLine;
  protected readonly formatAgo = formatAgo;
  protected readonly formatDuration = formatDuration;
  protected readonly formatCount = formatCount;
  protected readonly connections = invokeResource<DbConnectionRow[]>('db.connection.list', () => ({}), { refreshOn: ['db-connections'] });
  protected readonly entries = invokeResource<DbHistoryEntry[]>(
    'db.history.list',
    () => ({
      limit: LIMIT,
      search: this.search().trim() || undefined,
      connectionId: this.connectionId() || undefined,
      ok: this.outcome() === 'all' ? undefined : this.outcome() === 'ok',
    }),
    { refreshOn: ['db-history'] },
  );
  protected readonly count = computed(() => {
    const n = this.entries.value()?.length ?? 0;
    return n >= LIMIT ? `latest ${formatCount(LIMIT)}` : `${formatCount(n)} quer${n === 1 ? 'y' : 'ies'}`;
  });

  protected typed(event: Event): void {
    this.search.set((event.target as HTMLInputElement).value);
  }

  protected pickConnection(event: Event): void {
    this.connectionId.set((event.target as HTMLSelectElement).value);
  }

  protected pickOutcome(event: Event): void {
    this.outcome.set((event.target as HTMLSelectElement).value as 'all' | 'ok' | 'failed');
  }

  protected open(entry: DbHistoryEntry): void {
    this.db.openQueryTab({ connectionId: entry.connectionId, database: entry.database, text: entry.text });
  }

  protected copy(event: MouseEvent, entry: DbHistoryEntry): void {
    event.stopPropagation();
    this.toasts.copy(entry.text, 'Copied query');
  }

  protected save(event: MouseEvent, entry: DbHistoryEntry): void {
    event.stopPropagation();
    void this.db.saveFromHistory(entry);
  }

  protected outcomeOf(entry: DbHistoryEntry): string {
    if (!entry.ok) return entry.error ?? 'failed';
    return entry.rowCount === null ? 'ok' : `${formatCount(entry.rowCount)} row${entry.rowCount === 1 ? '' : 's'}`;
  }
}
