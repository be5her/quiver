import { Component, DestroyRef, computed, inject, input, linkedSignal, signal, untracked } from '@angular/core';
import type { QueueDestination, QueueMessage } from '@quiver/core';
import { Button, HostBridge, Icon, Segment, Segmented, Spinner, TabsState, invokeResource, type Tab, type TabComponent } from '@quiver/ui';
import { Eraser, Inbox, RefreshCw, Trash2 } from 'lucide';
import { QueuesGroupLag } from './group-lag';
import { QueuesLiveTail } from './live-tail';
import { QueuesPeekView } from './peek-view';
import { QueuesProducer, type ProducerPreset } from './producer';
import { QueuesActions } from './queues-actions';
import { concernsDestination, injectQueuesChanged } from './queues-events';
import { KIND_BADGE, destinationWord, kindClass, type QueueConnectionSummary } from './queues-format';
import { QueuesTails } from './queues-tails';

type View = 'messages' | 'produce' | 'tail' | 'groups';
const VIEWS: View[] = ['messages', 'produce', 'tail', 'groups'];

/** A topic or queue: its messages (peeked), a producer, a live tail and, on Kafka, the lag of the groups reading it. */
@Component({
  selector: 'q-queues-destination-tab',
  imports: [Button, Icon, QueuesGroupLag, QueuesLiveTail, QueuesPeekView, QueuesProducer, Segment, Segmented, Spinner],
  template: `
    @if (connection.error(); as error) {
      <div class="p-4 text-sm text-danger">{{ error.message }}</div>
    } @else if (connection.value(); as c) {
      <div class="flex flex-col h-full min-h-0 w-full" data-testid="queues-destination-tab" [attr.data-destination]="destination()">
        <div class="flex items-center gap-2 px-3 h-10 border-b border-edge shrink-0">
          <svg [qIcon]="icons.Inbox" class="size-4 text-accent shrink-0"></svg>
          <span class="text-[9px] font-bold shrink-0" [class]="kindColour()">{{ badge() }}</span>
          <span class="font-medium text-sm truncate max-w-80" [title]="destination()">{{ destination() }}</span>
          <button type="button" class="text-xs text-muted hover:text-fg truncate shrink-0" title="Connection settings" (click)="actions.openConnectionTab(c)">{{ c.name }}</button>
          <span class="text-xs text-muted truncate min-w-0" data-testid="queues-destination-info">{{ infoText() }}</span>
          <span class="flex-1 min-w-4"></span>
          <button qButton size="sm" variant="ghost" [icon]="icons.RefreshCw" [loading]="info.isLoading()" (click)="info.reload()">Refresh</button>
          <button qButton size="sm" variant="ghost" [icon]="icons.Eraser" [disabled]="missing()" data-testid="queues-purge" (click)="actions.purge(c, destination())">Purge</button>
          <button qButton size="sm" variant="danger" [icon]="icons.Trash2" [disabled]="missing()" data-testid="queues-delete-destination" (click)="actions.deleteDestination(c, destination())">Delete</button>
        </div>
        <q-segmented [(value)]="view" class="shrink-0 px-1">
          <button qSegment="messages" data-testid="queues-view-messages">Messages</button>
          <button qSegment="produce" data-testid="queues-view-produce">Produce</button>
          <button qSegment="tail" data-testid="queues-view-tail">Live tail{{ tailRunning() ? ' ●' : '' }}</button>
          @if (c.kind === 'kafka') {
            <button qSegment="groups" data-testid="queues-view-groups">Consumer groups</button>
          }
        </q-segmented>
        <div class="flex-1 min-h-0 flex flex-col">
          @switch (view()) {
            @case ('messages') {
              <q-queues-peek-view [connectionId]="c.id" [destination]="destination()" [kind]="c.kind" [info]="info.value()" (produceAgain)="produceAgain($event)" />
            }
            @case ('groups') {
              @if (c.kind === 'kafka') {
                <q-queues-group-lag [connectionId]="c.id" [topic]="destination()" />
              }
            }
          }
          @if (producerVisited()) {
            <!-- Kept while the tab is open, so a message being written survives a look at another view. -->
            <q-queues-producer [class.hidden]="view() !== 'produce'" [connectionId]="c.id" [destination]="destination()" [kind]="c.kind" [info]="info.value()" [preset]="preset()" />
          }
          @if (tailVisited()) {
            <!-- Kept while the tab is open, so switching views does not stop the tail. -->
            <q-queues-live-tail
              [class.hidden]="view() !== 'tail'"
              [connectionId]="c.id"
              [destination]="destination()"
              [kind]="c.kind"
              [scope]="scope()"
              [tabId]="tab().id"
              (produceAgain)="produceAgain($event)"
              (runningChange)="tailRunning.set($event)"
            />
          }
        </div>
      </div>
    } @else {
      <div class="flex items-center justify-center h-full w-full"><svg qSpinner></svg></div>
    }
  `,
  host: { class: 'contents' },
})
export class QueuesDestinationTab implements TabComponent {
  protected readonly actions = inject(QueuesActions);
  private readonly tails = inject(QueuesTails);
  private readonly tabsState = inject(TabsState);
  private readonly host = inject(HostBridge);

  readonly tab = input.required<Tab>();
  readonly scope = input.required<string>();

  protected readonly icons = { Eraser, Inbox, RefreshCw, Trash2 };
  protected readonly connectionId = computed(() => String(this.tab().data?.['connectionId'] ?? ''));
  protected readonly destination = computed(() => String(this.tab().data?.['destination'] ?? ''));
  protected readonly connection = invokeResource<QueueConnectionSummary>('queues.connection.get', () => ({ id: this.connectionId() }), { refreshOn: ['queues'] });
  protected readonly info = invokeResource<QueueDestination>('queues.destination.describe', () => ({ connectionId: this.connectionId(), destination: this.destination() }));
  /** The view on screen; the sidebar's menu can ask for another through the tab's data. */
  protected readonly view = linkedSignal<unknown, View>({
    source: () => this.tab().data?.['nonce'],
    computation: (_nonce, previous) => {
      const asked = untracked(() => this.tab().data?.['view']);
      return VIEWS.find((v) => v === asked) ?? previous?.value ?? 'messages';
    },
  });
  /**
   * The tail is created the first time it is shown and then kept, so it runs while another view is on screen; a tail
   * held while the workspace was off screen brings it back at once.
   */
  protected readonly tailVisited = linkedSignal<View, boolean>({
    source: this.view,
    computation: (view, previous) => (previous?.value ?? untracked(() => this.tails.has(`${this.scope()}/${this.tab().id}`))) || view === 'tail',
  });
  /** The producer likewise, so what is being written is still there after a look at the messages. */
  protected readonly producerVisited = linkedSignal<View, boolean>({ source: this.view, computation: (view, previous) => (previous?.value ?? false) || view === 'produce' });
  protected readonly tailRunning = signal(false);
  protected readonly preset = signal<ProducerPreset | null>(null);
  protected readonly badge = computed(() => {
    const c = this.connection.value();
    return c ? KIND_BADGE[c.kind] : '';
  });
  protected readonly kindColour = computed(() => {
    const c = this.connection.value();
    return c ? kindClass(c.kind) : '';
  });
  /** No such topic or queue yet: a produce creates it on Kafka and the memory broker. */
  protected readonly missing = computed(() => this.info.error()?.code === 'NOT_FOUND');
  protected readonly infoText = computed(() => {
    const c = this.connection.value();
    const word = c ? destinationWord(c.kind) : 'topic';
    if (this.missing()) return `No such ${word} yet${c?.kind === 'kafka' || c?.kind === 'memory' ? '; the first message creates it' : ''}`;
    const error = this.info.error();
    if (error) return error.message;
    const d = this.info.value();
    if (!d) return '';
    const parts: string[] = [];
    if (d.messages !== undefined) parts.push(`${d.messages} message${d.messages === 1 ? '' : 's'}`);
    if (d.partitions !== undefined) parts.push(`${d.partitions} partition${d.partitions === 1 ? '' : 's'}`);
    if (d.consumers !== undefined) parts.push(`${d.consumers} consumer${d.consumers === 1 ? '' : 's'}`);
    if (d.fifo) parts.push('FIFO');
    return parts.join(' · ');
  });

  constructor() {
    injectQueuesChanged((p) => {
      if (p.reason !== 'consumer' && concernsDestination(p, this.connectionId(), this.destination())) this.info.reload();
    });
    // A tail held for this tab while its component was gone (the tab showed an error instead, or its workspace was off
    // screen) has nobody to stop it once the tab closes; the live tail stops its own when it is still there.
    inject(DestroyRef).onDestroy(() => {
      const scope = untracked(this.scope);
      const tabId = untracked(this.tab).id;
      if (this.tabsState.scope(scope).tabs.some((t) => t.id === tabId)) return;
      const held = this.tails.take(`${scope}/${tabId}`);
      if (held) void this.host.invoke('queues.consumer.stop', { consumerId: held, forget: true }).catch(() => {});
    });
  }

  /** Put a message seen in the table or the tail into the producer. */
  protected produceAgain(message: QueueMessage): void {
    this.preset.set({ message, nonce: Date.now() });
    this.view.set('produce');
  }
}
