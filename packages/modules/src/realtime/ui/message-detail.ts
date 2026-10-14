import { Component, computed, inject, input } from '@angular/core';
import type { RealtimeMessage } from '@quiver/core';
import { Badge, Button, CodeEditor, Toasts, formatBytes } from '@quiver/ui';
import { KIND_LABEL, formatData } from './realtime-format';

/** One message in full: direction, event, id, time and size, and its data. */
@Component({
  selector: 'q-realtime-message-detail',
  imports: [Badge, Button, CodeEditor],
  template: `
    @let m = message();
    <div class="flex flex-col gap-1 px-3 py-2 border-b border-edge text-[11px] text-muted shrink-0">
      <div class="flex items-center gap-2 flex-wrap">
        <span qBadge>{{ direction() }}</span>
        @if (m.event) {
          <span qBadge class="text-violet-600 dark:text-violet-400">{{ m.event }}</span>
        }
        @if (m.eventId !== null) {
          <span class="font-mono">id {{ m.eventId }}</span>
        }
        <span>{{ at() }}</span>
        <span>{{ formatBytes(m.size) }}</span>
        @if (m.truncated) {
          <span class="text-warning">truncated to {{ formatBytes(m.data.length) }}</span>
        }
        <span class="flex-1"></span>
        <button qButton size="sm" variant="ghost" (click)="copy()">Copy</button>
      </div>
    </div>
    <div class="flex-1 min-h-0 p-2">
      <q-code-editor [value]="data().text" readonly [language]="data().language" [wrap]="data().language !== 'json'" />
    </div>
  `,
  host: { class: 'flex flex-col h-full min-h-0', 'data-testid': 'realtime-message-detail' },
})
export class RealtimeMessageDetail {
  private readonly toasts = inject(Toasts);

  readonly message = input.required<RealtimeMessage>();

  protected readonly formatBytes = formatBytes;
  protected readonly data = computed(() => formatData(this.message()));
  protected readonly at = computed(() => new Date(this.message().at).toLocaleString());
  protected readonly direction = computed(() => {
    const m = this.message();
    return m.direction === 'in' ? 'received' : m.direction === 'out' ? 'sent' : KIND_LABEL[m.kind];
  });

  protected copy(): void {
    this.toasts.copy(this.message().data);
  }
}
