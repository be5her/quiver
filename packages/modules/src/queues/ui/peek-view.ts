import { Component, computed, input, output, signal, untracked } from '@angular/core';
import type { QueueDestination, QueueKind, QueueMessage } from '@quiver/core';
import { Button, Icon, Select, invokeResource } from '@quiver/ui';
import { Eye, RefreshCw, TriangleAlert } from 'lucide';
import { QueuesMessageList } from './message-list';
import { concernsDestination, injectQueuesChanged } from './queues-events';
import { peeksFreely } from './queues-format';

interface PeekInput {
  connectionId: string;
  destination: string;
  limit: number;
  from: 'latest' | 'earliest';
  partition?: number;
}

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
    @if (warning(); as w) {
      <p class="flex items-center gap-2 px-3 py-1.5 text-[11px] text-warning border-b border-edge shrink-0" data-testid="queues-peek-warning">
        <svg [qIcon]="icons.TriangleAlert" class="size-3.5 shrink-0"></svg> {{ w }}
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
  /** Kafka and the memory broker read on open, on every setting and after each change made here to this destination. */
  private readonly free = computed(() => peeksFreely(this.kind()));
  /** SQS and RabbitMQ peek only on a click, with the settings of that click: their peeks leave a mark on the messages. */
  private readonly asked = signal<PeekInput | null>(null);
  protected readonly armed = computed(() => this.free() || this.asked() !== null);
  protected readonly partitions = computed(() => this.info()?.partitions ?? 0);
  protected readonly partitionList = computed(() => Array.from({ length: this.partitions() }, (_, i) => i));
  private readonly settings = computed<PeekInput>(() => ({
    connectionId: this.connectionId(),
    destination: this.destination(),
    limit: this.limit(),
    from: this.from(),
    ...(this.partition() === undefined ? {} : { partition: this.partition() }),
  }));
  protected readonly peek = invokeResource<QueueMessage[]>('queues.message.peek', () => (this.free() ? this.settings() : this.asked()), { enabled: () => this.armed() });
  protected readonly warning = computed(() => {
    const kind = this.kind();
    if (kind === 'rabbit') return 'RabbitMQ has no read-only peek: messages are fetched and requeued, which marks them redelivered and can reorder them. Peek reads on a click only.';
    if (kind === 'sqs')
      return 'SQS has no read-only peek: messages are received with a zero visibility timeout, and every receive adds to their receive count, which a redrive policy counts towards moving them to the dead-letter queue. Peek reads on a click only.';
    return null;
  });
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
    injectQueuesChanged((p) => {
      if (p.reason === 'messages' && this.free() && concernsDestination(p, this.connectionId(), this.destination())) this.peek.reload();
    });
  }

  protected run(): void {
    if (this.free()) return this.peek.reload();
    const next = this.settings();
    const same = JSON.stringify(next) === JSON.stringify(untracked(this.asked));
    this.asked.set(next);
    // The same settings as the last click leave the resource's input as it was, so it has to be asked again.
    if (same) this.peek.reload();
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
