import { Component, computed, inject, input, linkedSignal, signal } from '@angular/core';
import { type ApiRun, type ApiRunItem, type RunItemStatus } from '@quiver/core';
import { Button, Checkbox, EmptyState, HostBridge, METHOD_COLORS, Spinner, TabsState, Toasts, injectHostEvent, invokeResource, statusColor, type Tab, type TabComponent } from '@quiver/ui';
import { Play, RotateCw, Square } from 'lucide';
import { ApiActions } from './api-actions';

const STATUS_STYLES: Record<RunItemStatus, string> = {
  pending: 'bg-elevated text-muted',
  running: 'bg-accent/15 text-accent',
  passed: 'bg-success/15 text-success',
  failed: 'bg-danger/15 text-danger',
  error: 'bg-danger/15 text-danger',
  skipped: 'bg-elevated text-muted',
  cancelled: 'bg-warning/15 text-warning',
};

/**
 * A collection run: each request in order with its status, HTTP status, time and checks, updated
 * live while it runs, with Stop, Run again and a click on a row to open the request.
 */
@Component({
  selector: 'q-run-tab',
  imports: [Button, Checkbox, EmptyState, Spinner],
  templateUrl: './run-tab.html',
  host: { class: 'flex flex-col h-full min-h-0' },
})
export class RunTab implements TabComponent {
  private readonly host = inject(HostBridge);
  private readonly tabs = inject(TabsState);
  private readonly toasts = inject(Toasts);
  private readonly api = inject(ApiActions);

  readonly tab = input.required<Tab>();
  readonly scope = input.required<string>();

  protected readonly icons = { Play, RotateCw, Square };
  protected readonly methodColors = METHOD_COLORS;
  protected readonly statusColor = statusColor;
  private readonly collectionId = computed(() => String(this.tab().data?.['collectionId'] ?? ''));
  private readonly givenRunId = computed(() => (this.tab().data?.['runId'] as string | undefined) ?? null);
  /** Without a run named, the collection's latest. */
  private readonly latest = invokeResource<ApiRun[]>('api.run.list', () => ({ collectionId: this.collectionId(), limit: 1 }), {
    refreshOn: ['runs'],
    enabled: () => !this.givenRunId(),
  });
  protected readonly runId = computed(() => this.givenRunId() ?? this.latest.value()?.[0]?.id ?? null);
  private readonly fetched = invokeResource<ApiRun>('api.run.get', () => ({ runId: this.runId() }), { enabled: () => Boolean(this.runId()) });
  protected readonly run = computed(() => (this.runId() ? this.fetched.value() : undefined));
  protected readonly running = computed(() => this.run()?.status === 'running');
  protected readonly stopOnFail = linkedSignal(() => this.run()?.stopOnFail ?? false);
  protected readonly starting = signal(false);
  protected readonly done = computed(() => this.run()?.items.filter((i) => i.status !== 'pending' && i.status !== 'running').length ?? 0);
  protected readonly progress = computed(() => {
    const run = this.run();
    return run && run.items.length ? `${Math.round((this.done() / run.items.length) * 100)}%` : '0%';
  });
  protected readonly elapsed = computed(() => {
    const run = this.run();
    if (!run?.finishedAt) return null;
    const ms = Date.parse(run.finishedAt) - Date.parse(run.startedAt);
    return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
  });

  constructor() {
    injectHostEvent('api.changed', (p) => {
      if (p.workspaceId === this.scope() && p.runId === this.runId()) this.fetched.reload();
    });
  }

  protected badge(status: RunItemStatus): string {
    return STATUS_STYLES[status];
  }

  protected checkCount(item: ApiRunItem): string | null {
    if (!item.checks?.length) return null;
    return `${item.checks.filter((c) => c.ok).length}/${item.checks.length}`;
  }

  protected failedChecks(item: ApiRunItem) {
    return item.checks?.filter((c) => !c.ok) ?? [];
  }

  protected open(item: ApiRunItem): void {
    this.api.openRequestTab({ id: item.requestId, name: item.name });
  }

  protected async stop(): Promise<void> {
    const runId = this.runId();
    if (runId) await this.host.invoke('api.run.cancel', { runId }).catch((err) => this.toasts.error(err));
  }

  protected async again(): Promise<void> {
    this.starting.set(true);
    try {
      const { runId } = await this.host.invoke<{ runId: string }>('api.collection.run', {
        collectionId: this.collectionId(),
        stopOnFail: this.stopOnFail(),
        ...(this.run() ? { environmentId: this.run()!.environmentId } : {}),
      });
      this.tabs.updateTab(this.scope(), this.tab().id, { data: { ...this.tab().data, runId } });
    } catch (err) {
      this.toasts.error(err);
    } finally {
      this.starting.set(false);
    }
  }
}
