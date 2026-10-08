import { Component, computed, inject, input, signal } from '@angular/core';
import type { ApiResponse } from '@quiver/core';
import { Button, CodeEditor, EmptyState, Segment, Segmented, Spinner, Toasts, formatBytes, formatMs, statusColor, type CodeLanguage } from '@quiver/ui';
import { Copy } from 'lucide';
import { HeaderTable } from './header-table';

type View = 'body' | 'headers' | 'request';

function formatBody(response: ApiResponse | null, pretty: boolean): { text: string; language: CodeLanguage } {
  if (!response) return { text: '', language: 'text' };
  if (response.bodyEncoding === 'base64') {
    return { text: `Binary response (${formatBytes(response.size)}). Base64:\n${response.body.slice(0, 2000)}${response.body.length > 2000 ? '…' : ''}`, language: 'text' };
  }
  const ct = response.contentType ?? '';
  const looksJson = /json/i.test(ct) || /^\s*[[{]/.test(response.body);
  if (looksJson) {
    if (pretty) {
      try {
        return { text: JSON.stringify(JSON.parse(response.body), null, 2), language: 'json' };
      } catch {
        // fall through to raw
      }
    }
    return { text: response.body, language: 'json' };
  }
  if (/html/i.test(ct)) return { text: response.body, language: 'html' };
  if (/xml/i.test(ct)) return { text: response.body, language: 'xml' };
  return { text: response.body, language: 'text' };
}

/** The last response: status, timing and size, then the body (pretty or raw), the headers, or what was sent. */
@Component({
  selector: 'q-response-pane',
  imports: [Button, CodeEditor, EmptyState, HeaderTable, Segment, Segmented, Spinner],
  templateUrl: './response-pane.html',
  host: { class: 'contents' },
})
export class ResponsePane {
  private readonly toasts = inject(Toasts);

  readonly response = input<ApiResponse | null>(null);
  readonly error = input<string | null>(null);
  readonly sending = input(false);

  protected readonly copyIcon = Copy;
  protected readonly statusColor = statusColor;
  protected readonly formatMs = formatMs;
  protected readonly formatBytes = formatBytes;
  protected readonly view = signal<View>('body');
  protected readonly pretty = signal(true);
  protected readonly body = computed(() => formatBody(this.response(), this.pretty()));

  protected togglePretty(): void {
    this.pretty.update((pretty) => !pretty);
  }

  protected copyBody(): void {
    this.toasts.copy(this.body().text);
  }
}
