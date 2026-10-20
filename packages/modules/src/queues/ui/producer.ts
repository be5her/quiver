import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormField, form } from '@angular/forms/signals';
import { newId, type KeyValue, type QueueDestination, type QueueKind, type QueueMessage } from '@quiver/core';
import { Button, CodeEditor, HostBridge, Input, KeyValueEditor, Label, Select, Toasts, invokeResource } from '@quiver/ui';
import { Braces, Send } from 'lucide';
import { concernsDestination, injectQueuesChanged } from './queues-events';
import { formatTime, isRabbitExchange, previewBody, type QueueHistoryEntry } from './queues-format';

interface Composer {
  key: string;
  headers: KeyValue[];
  body: string;
  format: 'json' | 'text';
  /** Kafka and memory: a partition number, or empty for the key's (or round robin). */
  partition: string;
  /** SQS FIFO. */
  groupId: string;
  dedupId: string;
  /** SQS: seconds, empty for none. */
  delaySeconds: string;
  /** RabbitMQ: empty for the default exchange, which routes by queue name. */
  exchange: string;
}

const EMPTY: Composer = { key: '', headers: [], body: '', format: 'json', partition: '', groupId: '', dedupId: '', delaySeconds: '', exchange: '' };

function headerRows(headers: Record<string, string>): KeyValue[] {
  return Object.entries(headers).map(([key, value]) => ({ id: newId(), key, value, enabled: true }));
}

/** What a message to send is made of, filled from a message seen elsewhere ("Produce again"). */
export interface ProducerPreset {
  message: Pick<QueueMessage, 'key' | 'headers' | 'body' | 'partition' | 'attributes'>;
  nonce: number;
}

/**
 * The composer: key, headers and body, plus the partition on a topic, the group and deduplication ids
 * (and delay) on SQS, and the exchange on RabbitMQ. What was sent before can be loaded again.
 */
@Component({
  selector: 'q-queues-producer',
  imports: [Button, CodeEditor, FormField, Input, KeyValueEditor, Label, Select],
  template: `
    @let c = composer();
    <div class="flex-1 min-h-0 overflow-y-auto">
      <div class="flex flex-col gap-3 p-3 max-w-4xl">
        <div class="flex items-end gap-2 flex-wrap">
          @if (hasKey()) {
            <div class="w-64">
              <label qLabel for="queues-produce-key">{{ kind() === 'rabbit' ? 'Routing key' : 'Key' }}</label>
              <input qInput id="queues-produce-key" class="font-mono h-7 text-xs" [placeholder]="kind() === 'rabbit' ? 'empty for none' : 'optional'" [formField]="composerForm.key" data-testid="queues-produce-key" />
            </div>
          }
          @if (topic()) {
            <div class="w-40">
              <label qLabel for="queues-produce-partition">Partition</label>
              <select qSelect id="queues-produce-partition" class="h-7 text-xs" [formField]="composerForm.partition" data-testid="queues-produce-partition">
                <option value="">{{ c.key ? 'By key' : 'Round robin' }}</option>
                @for (p of partitionList(); track p) {
                  <option [value]="'' + p">{{ p }}</option>
                }
              </select>
            </div>
          }
          @if (kind() === 'sqs') {
            @if (fifo()) {
              <div class="w-48">
                <label qLabel for="queues-produce-group">Message group id</label>
                <input qInput id="queues-produce-group" class="font-mono h-7 text-xs" placeholder="required on FIFO" [formField]="composerForm.groupId" data-testid="queues-produce-group" />
              </div>
              <div class="w-48">
                <label qLabel for="queues-produce-dedup">Deduplication id</label>
                <input qInput id="queues-produce-dedup" class="font-mono h-7 text-xs" placeholder="optional with content dedup" [formField]="composerForm.dedupId" data-testid="queues-produce-dedup" />
              </div>
            } @else {
              <div class="w-32">
                <label qLabel for="queues-produce-delay">Delay (seconds)</label>
                <input qInput id="queues-produce-delay" class="font-mono h-7 text-xs" inputmode="numeric" placeholder="0" [formField]="composerForm.delaySeconds" />
              </div>
            }
          }
          @if (kind() === 'rabbit' && !exchangeDestination()) {
            <div class="w-56">
              <label qLabel for="queues-produce-exchange">Exchange</label>
              <input qInput id="queues-produce-exchange" class="font-mono h-7 text-xs" placeholder="default (routes by queue name)" [formField]="composerForm.exchange" data-testid="queues-produce-exchange" />
            </div>
          }
          <span class="flex-1"></span>
          @if (recent().length > 0) {
            <select qSelect class="h-7 text-xs w-56" title="Load a message sent before" aria-label="Load a message sent before" data-testid="queues-produce-history" (change)="loadRecent($event)">
              <option value="">Sent before…</option>
              @for (e of recent(); track e.id) {
                <option [value]="e.id">{{ time(e.at) }} · {{ preview(e.message?.body ?? '') || '(empty)' }}</option>
              }
            </select>
          }
        </div>
        <div>
          <span qLabel>Headers</span>
          <q-key-value-editor [formField]="composerForm.headers" keyPlaceholder="Header" />
        </div>
        <div class="flex flex-col">
          <div class="flex items-center gap-2 mb-1">
            <span qLabel class="mb-0">Body</span>
            <select qSelect class="h-6 text-[11px] w-20" aria-label="Body format" [formField]="composerForm.format">
              <option value="json">JSON</option>
              <option value="text">Text</option>
            </select>
            @if (c.format === 'json') {
              <button qButton size="sm" variant="ghost" [icon]="icons.Braces" [disabled]="!c.body.trim()" (click)="pretty()">Format</button>
              @if (jsonError(); as e) {
                <span class="text-[11px] text-warning truncate" data-testid="queues-produce-json-error">{{ e }}</span>
              }
            }
          </div>
          <div class="h-56 border border-edge rounded" data-testid="queues-produce-body">
            <q-code-editor [formField]="composerForm.body" [language]="c.format === 'json' ? 'json' : 'text'" placeholder='{"hello": "world"} (Ctrl+Enter sends)' (run)="send()" />
          </div>
        </div>
      </div>
    </div>
    <div class="flex items-center gap-2 px-3 h-11 border-t border-edge shrink-0">
      @if (lastId(); as id) {
        <span class="text-[11px] text-success font-mono truncate" data-testid="queues-produce-result">Sent · id {{ id }}</span>
      }
      <span class="flex-1"></span>
      <button qButton size="sm" variant="ghost" (click)="reset()">Clear</button>
      <button qButton size="sm" variant="primary" [icon]="icons.Send" [loading]="sending()" title="Ctrl+Enter" data-testid="queues-produce-send" (click)="send()">Send to {{ destination() }}</button>
    </div>
  `,
  host: { class: 'flex flex-col h-full min-h-0', 'data-testid': 'queues-producer' },
})
export class QueuesProducer {
  private readonly host = inject(HostBridge);
  private readonly toasts = inject(Toasts);

  readonly connectionId = input.required<string>();
  readonly destination = input.required<string>();
  readonly kind = input.required<QueueKind>();
  readonly info = input<QueueDestination>();
  readonly preset = input<ProducerPreset | null>(null);

  protected readonly icons = { Braces, Send };
  protected readonly composer = signal<Composer>({ ...EMPTY });
  protected readonly composerForm = form(this.composer);
  protected readonly sending = signal(false);
  protected readonly lastId = signal<string | null>(null);
  protected readonly topic = computed(() => this.kind() === 'kafka' || this.kind() === 'memory');
  /** RabbitMQ `exchange:<name>`: published there with the routing key typed; a queue is reached by its name instead. */
  protected readonly exchangeDestination = computed(() => isRabbitExchange(this.kind(), this.destination()));
  /** A key goes with the message on topics; on RabbitMQ only as the routing key of an exchange; SQS has none. */
  protected readonly hasKey = computed(() => this.topic() || this.exchangeDestination());
  protected readonly fifo = computed(() => this.info()?.fifo ?? this.destination().endsWith('.fifo'));
  protected readonly partitionList = computed(() => Array.from({ length: Math.max(1, this.info()?.partitions ?? 1) }, (_, i) => i));
  protected readonly jsonError = computed(() => {
    const { body, format } = this.composer();
    if (format !== 'json' || !body.trim()) return null;
    try {
      JSON.parse(body);
      return null;
    } catch (err) {
      return `Not valid JSON: ${(err as Error).message}`;
    }
  });
  private readonly history = invokeResource<QueueHistoryEntry[]>('queues.history.list', () => ({ connectionId: this.connectionId(), destination: this.destination(), limit: 20 }));
  protected readonly recent = computed(() => (this.history.value() ?? []).filter((e) => e.action === 'produce' && e.message));
  protected readonly time = formatTime;
  protected readonly preview = (body: string) => previewBody(body).slice(0, 60);

  constructor() {
    injectQueuesChanged((p) => p.reason === 'messages' && concernsDestination(p, this.connectionId(), this.destination()) && this.history.reload());
    effect(() => {
      const preset = this.preset();
      if (preset) untracked(() => this.load(preset.message));
    });
  }

  private load(m: ProducerPreset['message']): void {
    const body = m.body ?? '';
    // A RabbitMQ message's key is the routing key it came with. To a queue it goes again through the exchange it came
    // from (with the queue's name as routing key), since a key of its own would be refused there.
    const rabbitQueue = this.kind() === 'rabbit' && !this.exchangeDestination();
    const from = m.attributes?.['exchange'];
    this.composer.set({
      ...EMPTY,
      key: rabbitQueue ? '' : (m.key ?? ''),
      headers: headerRows(m.headers ?? {}),
      body,
      format: /^\s*[[{]/.test(body) ? 'json' : 'text',
      exchange: rabbitQueue && from && from !== '(default)' ? from : '',
    });
  }

  protected loadRecent(event: Event): void {
    const select = event.target as HTMLSelectElement;
    const entry = this.recent().find((e) => e.id === select.value);
    select.value = '';
    if (!entry?.message) return;
    this.load(entry.message);
    this.composer.update((c) => ({ ...c, partition: entry.message?.partition === undefined ? '' : String(entry.message.partition), groupId: entry.message?.groupId ?? '', exchange: entry.message?.exchange ?? '' }));
  }

  protected pretty(): void {
    try {
      this.composer.update((c) => ({ ...c, body: JSON.stringify(JSON.parse(c.body), null, 2) }));
    } catch {
      // The warning beside the button already says why.
    }
  }

  protected reset(): void {
    this.composer.set({ ...EMPTY });
    this.lastId.set(null);
  }

  protected async send(): Promise<void> {
    if (this.sending()) return;
    const c = this.composer();
    const kind = this.kind();
    const headers: Record<string, string> = {};
    for (const h of c.headers) if (h.enabled && h.key.trim()) headers[h.key.trim()] = h.value;
    const partition = Number.parseInt(c.partition, 10);
    const delay = Number.parseInt(c.delaySeconds, 10);
    if (kind === 'sqs' && this.fifo() && !c.groupId.trim()) {
      this.toasts.notify('A FIFO queue needs a message group id', 'error');
      return;
    }
    this.sending.set(true);
    try {
      const result = await this.host.invoke<{ id: string }>('queues.message.produce', {
        connectionId: this.connectionId(),
        destination: this.destination(),
        body: c.body,
        headers,
        ...(c.key && this.hasKey() ? { key: c.key } : {}),
        ...(this.topic() && Number.isFinite(partition) ? { partition } : {}),
        ...(kind === 'sqs' && this.fifo() ? { groupId: c.groupId.trim(), ...(c.dedupId.trim() ? { dedupId: c.dedupId.trim() } : {}) } : {}),
        ...(kind === 'sqs' && !this.fifo() && Number.isFinite(delay) ? { delaySeconds: delay } : {}),
        ...(kind === 'rabbit' && !this.exchangeDestination() && c.exchange.trim() ? { exchange: c.exchange.trim() } : {}),
      });
      this.lastId.set(result.id);
    } catch (err) {
      this.toasts.error(err);
    } finally {
      this.sending.set(false);
    }
  }
}
