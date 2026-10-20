import { Component, computed, input, linkedSignal, output, signal } from '@angular/core';
import type { QueueDestination, QueueKind, QueueMessage } from '@quiver/core';
import { Button, Icon, Select, injectHostEvent, invokeResource } from '@quiver/ui';
import { Eye, RefreshCw, TriangleAlert } from 'lucide';
import { QueuesMessageList } from './message-list';

const LIMITS = [10, 50, 100, 200, 500];

/** Messages read without consuming them: the newest or the oldest, how many, and on a topic one partition or all. */
@Component({
  selector: 'q-queues-peek-view',
  imports: [Button, Icon, QueuesMessageList, Select],
  template: `
    <div class="flex items-center gap-2 px-3 h-9 border-b border-edge shrink-0 text-xs">
      <div class="w-28 shrink-0"><select qSelect class="h-7 text-xs" aria-label="From" data-testid="queues-peek-from" (change)="from.set(pickFrom($event))">
        <option value="latest" [selected]="from() === 'latest'">Newest</option>
        <option value="earliest" [selected]="from() === 'earliest'">Oldest</option>
      </select></div>
      <div class="w-20 shrink-0"><select qSelect class="h-7 text-xs" aria-label="Limit" data-testid="queues-peek-limit" (change)="limit.set(pickNumber($event, 50))">
        @for (n of limits; track n) {
          <option [value]="n" [selected]="n === limit()">{{ n }}</option>
        }
      </select></div>
      @if (partitions() > 1) {
        <div class="w-36 shrink-0"><select qSelect class="h-7 text-xs" aria-label="Partition" data-testid="queues-peek-partition" (change)="partition.set(pickPartition($event))">
          <option value="" [selected]="partition() === undefined">All partitions</option>
          @for (p of partitionList(); track p) {
            <option [value]="p" [selected]="p === partition()">Partition {{ p }}</option>
          }
        </select></div>
      }
      <span class="text-muted">{{ summary() }}</span>
      <span class="flex-1"></span>
      <button qButton size="sm" [variant]="armed() ? 'ghost' : 'primary'" [icon]="armed() ? icons.RefreshCw : icons.Eye" [loading]="peek.isLoading()" data-testid="queues-peek" (click)="run()">{{ armed() ? 'Refresh' : 'Peek' }}</button>
    </div>
    @if (kind() === 'rabbit') {
      <p class="flex items-center gap-2 px-3 py-1.5 text-[11px] text-warning border-b border-edge shrink-0">
        <svg [qIcon]="icons.TriangleAlert" class="size-3.5 shrink-0"></svg> RabbitMQ has no read-only peek: messages are fetched and requeued, which marks them redelivered and can reorder them.
      </p>
    }
    @if (peek.error(); as error) {
      <p class="px-3 py-2 text-xs text-danger shrink-0" data-testid="queues-peek-error">{{ error.message }}</p>
    }
    <q-queues-message-list [messages]="messages()" [positionLabel]="kind() === 'kafka' || kind() === 'memory' ? 'Partition:offset' : 'Id'" testId="queues-peek-list" (produceAgain)="produceAgain.emit($event)">
      @if (armed() && peek.value()?.length === 0) {
        <p class="px-3 py-3 text-xs text-muted">Nothing here. Produce a message or start a live tail.</p>
      }
      @if (!armed()) {
        <p class="px-3 py-3 text-xs text-muted">Peek reads the messages without taking them off the queue.</p>
      }
    </q-queues-message-list>
  `,
  host: { class: 'flex flex-col h-full min-h-0', 'data-testid': 'queues-peek-view' },
})
export class QueuesPeekView {
  readonly connectionId = input.required<string>();
  readonly destination = input.required<string>();
  readonly kind = input.required<QueueKind>();
  readonly info = input<QueueDestination>();
  readonly produceAgain = output<QueueMessage>();

  protected readonly icons = { Eye, RefreshCw, TriangleAlert };
  protected readonly limits = LIMITS;
  protected readonly limit = signal(50);
  protected readonly from = signal<'latest' | 'earliest'>('latest');
  protected readonly partition = signal<number | undefined>(undefined);
  /** RabbitMQ waits for a click, since its peek requeues; the others read on open and after each change made here. */
  protected readonly armed = linkedSignal(() => this.kind() !== 'rabbit');
  protected readonly partitions = computed(() => this.info()?.partitions ?? 0);
  protected readonly partitionList = computed(() => Array.from({ length: this.partitions() }, (_, i) => i));
  protected readonly peek = invokeResource<QueueMessage[]>(
    'queues.message.peek',
    () => ({ connectionId: this.connectionId(), destination: this.destination(), limit: this.limit(), from: this.from(), ...(this.partition() === undefined ? {} : { partition: this.partition() }) }),
    { enabled: () => this.armed() },
  );
  /** Newest first when reading the newest, oldest first otherwise. */
  protected readonly messages = computed(() => {
    const list = this.peek.value() ?? [];
    return this.from() === 'latest' ? [...list].reverse() : list;
  });
  protected readonly summary = computed(() => {
    const list = this.peek.value();
    const total = this.info()?.messages;
    if (!list) return total === undefined ? '' : `${total} in total`;
    return `${list.length} shown${total === undefined ? '' : ` of ${total}`}`;
  });

  constructor() {
    injectHostEvent('queues.changed', (p) => {
      if (p.reason === 'messages' && p.connectionId === this.connectionId() && this.armed() && this.kind() !== 'rabbit') this.peek.reload();
    });
  }

  protected run(): void {
    if (this.armed()) this.peek.reload();
    else this.armed.set(true);
  }

  protected pickFrom(event: Event): 'latest' | 'earliest' {
    return (event.target as HTMLSelectElement).value === 'earliest' ? 'earliest' : 'latest';
  }

  protected pickNumber(event: Event, fallback: number): number {
    const n = Number((event.target as HTMLSelectElement).value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  }

  protected pickPartition(event: Event): number | undefined {
    const raw = (event.target as HTMLSelectElement).value;
    return raw === '' ? undefined : Number(raw);
  }
}
