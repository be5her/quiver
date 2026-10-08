import { Component, computed, input } from '@angular/core';
import type { McpContent, McpResourceContents } from '@quiver/core';
import { Badge, CodeEditor, formatBytes } from '@quiver/ui';
import { displayText } from './mcp-format';

/** Text shown read-only, pretty-printed when it is JSON. */
@Component({
  selector: 'q-mcp-text-block',
  imports: [CodeEditor],
  template: `<q-code-editor [value]="shown().value" readonly [language]="shown().language" [wrap]="shown().language !== 'json'" />`,
  host: { class: 'contents' },
})
export class McpTextBlock {
  readonly text = input.required<string>();
  readonly mime = input<string>();

  protected readonly shown = computed(() => displayText(this.text(), this.mime()));
}

/** One part of a resource: its URI and type, then the text, an image or a note about binary data. */
@Component({
  selector: 'q-mcp-resource-contents',
  imports: [Badge, McpTextBlock],
  template: `
    @let c = contents();
    <div class="flex items-center gap-2 text-[11px] text-muted flex-wrap">
      <span class="font-mono truncate">{{ c.uri }}</span>
      @if (c.mimeType) {
        <span qBadge>{{ c.mimeType }}</span>
      }
      @if (c.blob !== undefined) {
        <span qBadge>binary, {{ blobSize() }}</span>
      }
    </div>
    @if (c.text !== undefined) {
      <q-mcp-text-block [text]="c.text" [mime]="c.mimeType" />
    }
    @if (c.blob !== undefined) {
      @if (isImage()) {
        <img [src]="'data:' + c.mimeType + ';base64,' + c.blob" [alt]="c.uri" class="max-h-64 max-w-full rounded border border-edge self-start" />
      } @else {
        <p class="text-xs text-muted">Binary contents are returned as base64 in \`blob\`.</p>
      }
    }
  `,
  host: { class: 'flex flex-col gap-1 min-w-0' },
})
export class McpResourceContentsView {
  readonly contents = input.required<McpResourceContents>();

  protected readonly isImage = computed(() => Boolean(this.contents().mimeType?.startsWith('image/')));
  protected readonly blobSize = computed(() => formatBytes(Math.floor(((this.contents().blob ?? '').length * 3) / 4)));
}

/** One content block of a tool result or prompt message, shown the way its type calls for. */
@Component({
  selector: 'q-mcp-content-block',
  imports: [Badge, McpResourceContentsView, McpTextBlock],
  template: `
    @let c = content();
    @switch (c.type) {
      @case ('text') {
        <q-mcp-text-block [text]="c.text" />
      }
      @case ('image') {
        <img [src]="'data:' + c.mimeType + ';base64,' + c.data" alt="tool result" class="max-h-64 max-w-full rounded border border-edge self-start" />
      }
      @case ('audio') {
        <audio controls [src]="'data:' + c.mimeType + ';base64,' + c.data" class="max-w-full"></audio>
      }
      @case ('resource') {
        <q-mcp-resource-contents [contents]="c.resource" />
      }
      @case ('resource_link') {
        <div class="text-xs flex flex-col gap-0.5">
          <span class="font-medium">{{ c.name }}</span>
          <span class="font-mono text-muted break-all">{{ c.uri }}</span>
          @if (c.description) {
            <span class="text-muted">{{ c.description }}</span>
          }
          @if (c.mimeType) {
            <span qBadge class="self-start">{{ c.mimeType }}</span>
          }
        </div>
      }
      @default {
        <q-mcp-text-block [text]="raw()" mime="application/json" />
      }
    }
  `,
  host: { class: 'contents' },
})
export class McpContentBlock {
  readonly content = input.required<McpContent>();

  protected readonly raw = computed(() => JSON.stringify(this.content(), null, 2));
}

/** Every content block of a result, numbered when there is more than one. */
@Component({
  selector: 'q-mcp-content-blocks',
  imports: [Badge, McpContentBlock],
  template: `
    @let all = content();
    @if (all.length === 0) {
      <p class="text-xs text-muted">No content.</p>
    } @else {
      <div class="flex flex-col gap-2">
        @for (c of all; track $index) {
          <div class="flex flex-col gap-1">
            @if (all.length > 1) {
              <span qBadge class="self-start">{{ $index + 1 }} · {{ c.type }}</span>
            }
            <q-mcp-content-block [content]="c" />
          </div>
        }
      </div>
    }
  `,
  host: { class: 'contents' },
})
export class McpContentBlocks {
  readonly content = input.required<McpContent[]>();
}
