import { Component, DestroyRef, computed, effect, inject, input, output, signal } from '@angular/core';
import { queueMessageMatches, type QueueKind, type QueueMessage } from '@quiver/core';
import { Button, HostBridge, Icon, Input, Select, Toasts, injectHostEvent } from '@quiver/ui';
import { Play, Square, Trash2, TriangleAlert } from 'lucide';
import { QueuesMessageList } from './message-list';
import type { QueueConsumerRead, QueueConsumerSummary } from './queues-format';

/** Messages kept on screen; the host keeps its own last 1000 per tail. */
const KEEP = 1000;
/** A tail nobody reads for 10 minutes is stopped by the host; reading this often keeps an open one alive while it is quiet. */
const KEEPALIVE_MS = 60_000;

/**
 * A live consumer on the destination: start it from new messages or from the start, read what arrives
 * (the host announces it at most four times a second), filter it as text, stop it. Closing the tab stops it.
 */
@Component({
  selector: 'q-queues-live-tail',
  imports: [Button, Icon, Input, QueuesMessageList, Select],
  template: `
    @let c = consumer();
    <div class="flex items-center gap-2 px-3 h-9 border-b border-edge shrink-0 text-xs">
      <div class="w-36 shrink-0">
        <select qSelect class="h-7 text-xs" aria-label="Start from" [disabled]="running()" data-testid="queues-tail-from" (change)="from.set(pickFrom($event))">
          <option value="latest" [selected]="from() === 'latest'">New messages</option>
          <option value="earliest" [selected]="from() === 'earliest'">From the start</option>
        </select>
      </div>
      @if (running()) {
        <button qButton size="sm" variant="secondary" [icon]="icons.Square" [loading]="busy()" data-testid="queues-tail-stop" (click)="stop()">Stop</button>
      } @else {
        <button qButton size="sm" variant="primary" [icon]="icons.Play" [loading]="busy()" data-testid="queues-tail-start" (click)="start()">Start</button>
      }
      <div class="w-64 shrink-0"><input qInput class="h-7 text-xs" placeholder="Filter: body, key or header" [value]="filter()" (input)="typed($event)" data-testid="queues-tail-filter" /></div>
      <span class="text-muted whitespace-nowrap truncate" data-testid="queues-tail-status" [attr.data-status]="c?.status ?? 'idle'">{{ status() }}</span>
      <span class="flex-1"></span>
      <button qButton size="sm" variant="ghost" [icon]="icons.Trash2" [disabled]="!received().length" (click)="clear()">Clear</button>
    </div>
    @if (warning(); as w) {
      <p class="flex items-center gap-2 px-3 py-1.5 text-[11px] text-warning border-b border-edge shrink-0"><svg [qIcon]="icons.TriangleAlert" class="size-3.5 shrink-0"></svg> {{ w }}</p>
    }
    @if (c?.error; as error) {
      <p class="px-3 py-2 text-xs text-danger shrink-0">{{ error }}</p>
    }
    <q-queues-message-list [messages]="shown()" [positionLabel]="kind() === 'kafka' || kind() === 'memory' ? 'Partition:offset' : 'Id'" testId="queues-tail-list" (produceAgain)="produceAgain.emit($event)">
      @if (received().length === 0) {
        <p class="px-3 py-3 text-xs text-muted">{{ running() ? 'Listening. Messages appear here as they arrive, newest on top.' : 'Start a tail to watch messages arrive.' }}</p>
      } @else if (shown().length === 0) {
        <p class="px-3 py-3 text-xs text-muted">No message matches the filter.</p>
      }
    </q-queues-message-list>
  `,
  host: { class: 'flex flex-col h-full min-h-0', 'data-testid': 'queues-live-tail' },
})
export class QueuesLiveTail {
  private readonly host = inject(HostBridge);
  private readonly toasts = inject(Toasts);

  readonly connectionId = input.required<string>();
  readonly destination = input.required<string>();
  readonly kind = input.required<QueueKind>();
  readonly produceAgain = output<QueueMessage>();
  /** Whether the tail is running, for the dot on its segment. */
  readonly runningChange = output<boolean>();

  protected readonly icons = { Play, Square, Trash2, TriangleAlert };
  protected readonly from = signal<'latest' | 'earliest'>('latest');
  protected readonly filter = signal('');
  protected readonly consumer = signal<QueueConsumerSummary | null>(null);
  /** Oldest first, as read. */
  protected readonly received = signal<QueueMessage[]>([]);
  protected readonly dropped = signal(0);
  protected readonly busy = signal(false);
  private cursor = 0;
  private reading = false;
  private again = false;

  protected readonly running = computed(() => this.consumer()?.status === 'running');
  protected readonly shown = computed(() => {
    const needle = this.filter().trim();
    const list = needle ? this.received().filter((m) => queueMessageMatches(m, needle)) : this.received();
    return [...list].reverse();
  });
  protected readonly status = computed(() => {
    const c = this.consumer();
    if (!c) return '';
    const counts = `${c.received} received${this.dropped() ? `, ${this.dropped()} dropped` : ''}`;
    return c.status === 'running' ? `Live · ${counts}` : `${c.status === 'error' ? 'Failed' : 'Stopped'} · ${counts}`;
  });
  protected readonly warning = computed(() => {
    const kind = this.kind();
    if (kind === 'sqs') return 'An SQS tail receives the messages: they are hidden from other consumers for their visibility timeout, and come back unless deleted.';
    if (kind === 'rabbit') return 'A RabbitMQ tail consumes from the queue, so other consumers do not get what it takes.';
    return null;
  });

  constructor() {
    injectHostEvent('queues.changed', (p) => {
      const id = this.consumer()?.id;
      if (id && p.reason === 'consumer' && p.consumerId === id) void this.read();
    });
    effect(() => this.runningChange.emit(this.running()));
    effect((onCleanup) => {
      if (!this.running()) return;
      const timer = setInterval(() => void this.read(), KEEPALIVE_MS);
      onCleanup(() => clearInterval(timer));
    });
    inject(DestroyRef).onDestroy(() => {
      const id = this.consumer()?.id;
      if (id) void this.host.invoke('queues.consumer.stop', { consumerId: id, forget: true }).catch(() => {});
    });
  }

  protected typed(event: Event): void {
    this.filter.set((event.target as HTMLInputElement).value);
  }

  protected pickFrom(event: Event): 'latest' | 'earliest' {
    return (event.target as HTMLSelectElement).value === 'earliest' ? 'earliest' : 'latest';
  }

  protected async start(): Promise<void> {
    if (this.busy() || this.running()) return;
    this.busy.set(true);
    try {
      const previous = this.consumer()?.id;
      if (previous) void this.host.invoke('queues.consumer.stop', { consumerId: previous, forget: true }).catch(() => {});
      const started = await this.host.invoke<QueueConsumerSummary>('queues.consumer.start', { connectionId: this.connectionId(), destination: this.destination(), from: this.from() });
      this.cursor = 0;
      this.received.set([]);
      this.dropped.set(0);
      this.consumer.set(started);
      await this.read();
    } catch (err) {
      this.toasts.error(err);
    } finally {
      this.busy.set(false);
    }
  }

  protected async stop(): Promise<void> {
    const id = this.consumer()?.id;
    if (!id || this.busy()) return;
    this.busy.set(true);
    try {
      this.consumer.set(await this.host.invoke<QueueConsumerSummary>('queues.consumer.stop', { consumerId: id }));
      await this.read();
    } catch (err) {
      this.toasts.error(err);
    } finally {
      this.busy.set(false);
    }
  }

  protected clear(): void {
    this.received.set([]);
  }

  /** Read everything after the cursor; a read asked for while one runs is done right after it. */
  private async read(): Promise<void> {
    const id = this.consumer()?.id;
    if (!id) return;
    if (this.reading) {
      this.again = true;
      return;
    }
    this.reading = true;
    try {
      for (let page = 0; page < 5; page++) {
        const r = await this.host.invoke<QueueConsumerRead>('queues.consumer.read', { consumerId: id, cursor: this.cursor, limit: 1000 });
        if (this.consumer()?.id !== id) return;
        this.cursor = r.cursor;
        this.consumer.set(r.consumer);
        if (r.dropped) this.dropped.update((n) => n + r.dropped);
        if (r.messages.length) this.received.update((list) => [...list, ...r.messages].slice(-KEEP));
        if (r.messages.length < 1000) break;
      }
    } catch {
      // The tail is gone (the workspace closed or the connection was deleted); say it stopped.
      this.consumer.update((c) => (c && c.status === 'running' ? { ...c, status: 'stopped' } : c));
    } finally {
      this.reading = false;
      if (this.again) {
        this.again = false;
        void this.read();
      }
    }
  }
}
