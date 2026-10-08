import { Component, booleanAttribute, input } from '@angular/core';
import type { McpReadResourceResult } from '@quiver/core';
import { Spinner, formatMs } from '@quiver/ui';
import { McpResourceContentsView } from './content';

export interface ReadState {
  uri: string;
  result: (McpReadResourceResult & { durationMs: number }) | null;
  error: string | null;
}

/** What reading a resource returned: every part of its contents, or the error. */
@Component({
  selector: 'q-mcp-read-result',
  imports: [McpResourceContentsView, Spinner],
  template: `
    @if (read(); as r) {
      <div class="flex flex-col gap-2" data-testid="mcp-resource-result">
        @if (r.error) {
          <p class="text-xs text-danger whitespace-pre-wrap rounded-md border border-danger/40 bg-danger/5 px-2 py-1.5">{{ r.error }}</p>
        }
        @if (r.result; as result) {
          <span class="text-[11px] text-muted">{{ result.contents.length }} part{{ result.contents.length === 1 ? '' : 's' }} · {{ formatMs(result.durationMs) }}</span>
          @for (c of result.contents; track $index) {
            <div class="rounded-md border border-edge p-2"><q-mcp-resource-contents [contents]="c" /></div>
          }
        }
      </div>
    } @else if (busy()) {
      <svg qSpinner></svg>
    }
  `,
  host: { class: 'contents' },
})
export class McpReadResult {
  readonly read = input<ReadState | null>(null);
  readonly busy = input(false, { transform: booleanAttribute });

  protected readonly formatMs = formatMs;
}
