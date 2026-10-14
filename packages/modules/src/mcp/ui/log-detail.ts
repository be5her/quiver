import { Component, computed, inject, input } from '@angular/core';
import type { McpLogEntry } from '@quiver/core';
import { Badge, Button, CodeEditor, Toasts, formatBytes, formatMs } from '@quiver/ui';
import { McpTextBlock } from './content';

export const KIND_COLOR: Partial<Record<McpLogEntry['kind'], string>> = {
  error: 'text-danger',
  stderr: 'text-amber-600 dark:text-amber-400',
  log: 'text-violet-600 dark:text-violet-400',
  notification: 'text-violet-600 dark:text-violet-400',
};

/** One log entry in full: the JSON-RPC message pretty-printed, or the text of a stderr line or event. */
@Component({
  selector: 'q-mcp-log-detail',
  imports: [Badge, Button, CodeEditor, McpTextBlock],
  template: `
    @let e = entry();
    <div class="flex flex-col gap-1 px-3 py-2 border-b border-edge text-[11px] text-muted shrink-0">
      <div class="flex items-center gap-2 flex-wrap">
        <span qBadge>{{ e.direction === 'in' ? 'received' : e.direction === 'out' ? 'sent' : 'event' }}</span>
        <span qBadge [class]="kindColor[e.kind] ?? ''">{{ e.kind }}</span>
        @if (e.method) {
          <span class="font-mono">{{ e.method }}</span>
        }
        @if (e.requestId !== null) {
          <span class="font-mono">#{{ e.requestId }}</span>
        }
        @if (e.durationMs !== null) {
          <span>{{ formatMs(e.durationMs) }}</span>
        }
        <span>{{ at() }}</span>
        <span>{{ formatBytes(e.size) }}</span>
        @if (e.truncated) {
          <span class="text-warning">truncated</span>
        }
        <span class="flex-1"></span>
        <button qButton size="sm" variant="ghost" (click)="copy()">Copy</button>
      </div>
    </div>
    <div class="flex-1 min-h-0 overflow-y-auto p-2">
      @if (json()) {
        <q-mcp-text-block [text]="e.data" mime="application/json" />
      } @else {
        <q-code-editor [value]="e.data" readonly language="text" wrap />
      }
    </div>
  `,
  host: { class: 'flex flex-col h-full min-h-0', 'data-testid': 'mcp-log-detail' },
})
export class McpLogDetail {
  private readonly toasts = inject(Toasts);

  readonly entry = input.required<McpLogEntry>();

  protected readonly kindColor = KIND_COLOR;
  protected readonly formatBytes = formatBytes;
  protected readonly formatMs = formatMs;
  protected readonly json = computed(() => this.entry().direction !== 'system' && this.entry().kind !== 'stderr');
  protected readonly at = computed(() => new Date(this.entry().at).toLocaleString());

  protected copy(): void {
    this.toasts.copy(this.entry().data);
  }
}
