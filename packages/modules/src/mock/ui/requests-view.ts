import { Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import type { MockCapturedRequest, MockServerSummary } from '@quiver/core';
import { EmptyState, HostBridge, Icon, IconButton, Input, METHOD_COLORS, Toasts, formatBytes, formatMs, injectHostEvent, invokeResource, statusColor } from '@quiver/ui';
import { RefreshCw, Trash2 } from 'lucide';
import { OUTCOME_CLASS, OUTCOME_LABEL } from './mock-format';
import { MockRequestDetail } from './request-detail';

/** The requests a server captured, newest first, and the one being inspected. */
@Component({
  selector: 'q-mock-requests-view',
  imports: [EmptyState, Icon, IconButton, Input, MockRequestDetail],
  templateUrl: './requests-view.html',
  host: { class: 'flex h-full min-h-0' },
})
export class MockRequestsView {
  private readonly host = inject(HostBridge);
  private readonly toasts = inject(Toasts);

  readonly server = input.required<MockServerSummary>();
  readonly createRoute = output<MockCapturedRequest>();

  protected readonly icons = { RefreshCw, Trash2 };
  protected readonly methodColors = METHOD_COLORS;
  protected readonly outcomeClass = OUTCOME_CLASS;
  protected readonly outcomeLabel = OUTCOME_LABEL;
  protected readonly statusColor = statusColor;
  protected readonly formatMs = formatMs;
  protected readonly formatBytes = formatBytes;

  private readonly serverId = computed(() => this.server().id);
  protected readonly items = invokeResource<MockCapturedRequest[]>('mock.request.list', () => ({ serverId: this.serverId(), limit: 300 }));
  protected readonly selectedId = signal<string | null>(null);
  protected readonly filter = signal('');
  protected readonly filtered = computed(() => {
    const items = this.items.value() ?? [];
    const needle = this.filter().trim().toLowerCase();
    return needle ? items.filter((r) => `${r.method} ${r.url} ${r.outcome} ${r.response.status}`.toLowerCase().includes(needle)) : items;
  });
  protected readonly selected = computed(() => this.items.value()?.find((r) => r.id === this.selectedId()) ?? null);

  constructor() {
    injectHostEvent('mock.changed', (p) => p.serverId === this.serverId() && p.reason === 'requests' && this.items.reload());

    effect(() => {
      const error = this.items.error();
      if (error) untracked(() => this.toasts.error(error));
    });
  }

  protected typed(event: Event): void {
    this.filter.set((event.target as HTMLInputElement).value);
  }

  protected time(at: string | number): string {
    return new Date(at).toLocaleTimeString();
  }

  protected async clear(): Promise<void> {
    try {
      await this.host.invoke('mock.request.clear', { serverId: this.serverId() });
      this.selectedId.set(null);
    } catch (err) {
      this.toasts.error(err);
    }
  }
}
