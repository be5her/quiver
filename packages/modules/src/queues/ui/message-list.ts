import { Component, computed, inject, input, output, signal } from '@angular/core';
import type { QueueMessage } from '@quiver/core';
import { Badge, Button, CodeEditor, Toasts } from '@quiver/ui';
import { formatBody, formatDateTime, formatTime, positionOf, previewBody } from './queues-format';

/** One message in full: where it sits, key, headers, attributes and the body, pretty-printed when it is JSON. */
@Component({
  selector: 'q-queues-message-detail',
  imports: [Badge, Button, CodeEditor],
  template: `
    @let m = message();
    <div class="flex flex-col gap-1 px-3 py-2 border-b border-edge text-[11px] text-muted shrink-0">
      <div class="flex items-center gap-2 flex-wrap">
        <span qBadge class="font-mono">{{ position() }}</span>
        @if (m.timestamp) {
          <span>{{ at() }}</span>
        }
        <span class="flex-1"></span>
        <button qButton size="sm" variant="ghost" (click)="copy()">Copy body</button>
        <button qButton size="sm" variant="ghost" data-testid="queues-produce-again" (click)="produceAgain.emit(m)">Produce again</button>
      </div>
      @if (m.key !== undefined && m.key !== null) {
        <div class="flex gap-2"><span class="w-16 shrink-0">Key</span><span class="font-mono text-fg break-all">{{ m.key }}</span></div>
      }
      @for (h of headers(); track h[0]) {
        <div class="flex gap-2"><span class="w-16 shrink-0 truncate font-mono" [title]="h[0]">{{ h[0] }}</span><span class="font-mono text-fg break-all">{{ h[1] }}</span></div>
      }
      @for (a of attributes(); track a[0]) {
        <div class="flex gap-2"><span class="w-16 shrink-0 truncate" [title]="a[0]">{{ a[0] }}</span><span class="font-mono break-all">{{ a[1] }}</span></div>
      }
    </div>
    <div class="flex-1 min-h-0 p-2" data-testid="queues-message-body">
      <q-code-editor [value]="body().text" readonly [language]="body().language" [wrap]="body().language !== 'json'" />
    </div>
  `,
  host: { class: 'flex flex-col h-full min-h-0', 'data-testid': 'queues-message-detail' },
})
export class QueuesMessageDetail {
  private readonly toasts = inject(Toasts);

  readonly message = input.required<QueueMessage>();
  readonly produceAgain = output<QueueMessage>();

  protected readonly body = computed(() => formatBody(this.message().body));
  protected readonly position = computed(() => positionOf(this.message()));
  protected readonly at = computed(() => formatDateTime(this.message().timestamp));
  protected readonly headers = computed(() => Object.entries(this.message().headers ?? {}));
  protected readonly attributes = computed(() => Object.entries(this.message().attributes ?? {}));

  protected copy(): void {
    this.toasts.copy(this.message().body);
  }
}

/** Messages as a table (position, key, headers, body, time), with the one picked shown in full beside it. */
@Component({
  selector: 'q-queues-message-list',
  imports: [Badge, QueuesMessageDetail],
  template: `
    <div class="flex-1 min-w-0 overflow-auto" [attr.data-testid]="testId()">
      <table class="w-full text-xs table-fixed" aria-label="Messages">
        <thead class="sticky top-0 bg-canvas text-muted text-[11px] z-10">
          <tr class="border-b border-edge">
            <th class="text-left font-normal px-2 py-1 w-24">{{ positionLabel() }}</th>
            <th class="text-left font-normal px-2 py-1 w-32">Key</th>
            <th class="text-left font-normal px-2 py-1 w-20">Headers</th>
            <th class="text-left font-normal px-2 py-1">Body</th>
            <th class="text-right font-normal px-2 py-1 w-24">Time</th>
          </tr>
        </thead>
        <tbody>
          <!-- Tracked by the message itself: a tail prepends, and an index would rebuild every row on each arrival. -->
          @for (m of messages(); track m) {
            @let count = headerCount(m);
            <tr
              class="border-b border-edge/60 hover:bg-elevated cursor-pointer focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
              [class.bg-elevated]="key(m) === selectedKey()"
              tabindex="0"
              [attr.aria-selected]="key(m) === selectedKey()"
              data-testid="queues-message"
              [attr.data-id]="m.id"
              (click)="pick(m)"
              (keydown.enter)="pick(m)"
              (keydown.space)="pick(m); $event.preventDefault()"
            >
              <td class="px-2 py-1 font-mono text-muted truncate">{{ position(m) }}</td>
              <td class="px-2 py-1 font-mono truncate" [title]="m.key ?? ''">{{ m.key ?? '' }}</td>
              <td class="px-2 py-1">
                @if (count > 0) {
                  <span qBadge [title]="headerTitle(m)">{{ count }}</span>
                }
              </td>
              <td class="px-2 py-1 font-mono truncate" data-testid="queues-message-preview">{{ preview(m) }}@if (!m.body) {<span class="text-muted">(empty)</span>}</td>
              <td class="px-2 py-1 text-right text-muted" [title]="m.timestamp ?? ''">{{ time(m.timestamp) }}</td>
            </tr>
          }
        </tbody>
      </table>
      <ng-content />
    </div>
    @if (selected(); as message) {
      <div class="w-[420px] max-w-[50%] border-l border-edge flex flex-col min-h-0 shrink-0">
        <q-queues-message-detail [message]="message" (produceAgain)="produceAgain.emit($event)" />
      </div>
    }
  `,
  host: { class: 'flex flex-1 min-h-0' },
})
export class QueuesMessageList {
  readonly messages = input.required<QueueMessage[]>();
  readonly positionLabel = input('Offset');
  readonly testId = input('queues-messages');
  readonly produceAgain = output<QueueMessage>();

  protected readonly selectedKey = signal<string | null>(null);
  protected readonly selected = computed(() => this.messages().find((m) => this.key(m) === this.selectedKey()) ?? null);
  protected readonly preview = (m: QueueMessage) => previewBody(m.body);
  protected readonly time = formatTime;
  protected readonly position = positionOf;

  protected key(m: QueueMessage): string {
    return `${m.partition ?? ''}:${m.id}`;
  }

  protected headerCount(m: QueueMessage): number {
    return Object.keys(m.headers ?? {}).length;
  }

  protected headerTitle(m: QueueMessage): string {
    return Object.entries(m.headers ?? {})
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n');
  }

  protected pick(m: QueueMessage): void {
    const key = this.key(m);
    this.selectedKey.update((current) => (current === key ? null : key));
  }
}
