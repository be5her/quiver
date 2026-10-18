import { Component, computed, inject, input, linkedSignal } from '@angular/core';
import { normalizeJson, prettyJson, shortRelativeTime, type HistoryEntry, type HistoryResponse } from '@quiver/core';
import { Checkbox, DiffEditor, EmptyState, Select, Spinner, TabsState, invokeResource, statusColor, type Tab, type TabComponent } from '@quiver/ui';

/** How one side reads: the headers (when shown) above the body, JSON normalised when asked. */
function sideText(response: HistoryResponse | undefined, normalise: boolean, headers: boolean): string {
  if (!response) return '';
  let body = response.bodyEncoding === 'utf8' ? response.body : `(${Math.round((response.body.length * 3) / 4)} bytes of binary)`;
  if (response.bodyEncoding === 'utf8') body = (normalise ? normalizeJson(body) : prettyJson(body)) ?? body;
  if (!headers) return body;
  const head = [`${response.status} ${response.statusText}`, ...response.headers.map(([k, v]) => `${k}: ${v}`)].join('\n');
  return `${head}\n\n${body}`;
}

/**
 * Two kept responses of the same request side by side, the differences marked: by default the
 * newest and the one before it. JSON can be normalised (sorted keys, two-space indent) so only real
 * changes show, and the status line and headers can be compared too.
 */
@Component({
  selector: 'q-diff-tab',
  imports: [Checkbox, DiffEditor, EmptyState, Select, Spinner],
  templateUrl: './diff-tab.html',
  host: { class: 'flex flex-col h-full min-h-0' },
})
export class DiffTab implements TabComponent {
  private readonly tabs = inject(TabsState);

  readonly tab = input.required<Tab>();
  readonly scope = input.required<string>();

  protected readonly statusColor = statusColor;
  private readonly requestId = computed(() => String(this.tab().data?.['requestId'] ?? ''));
  private readonly entries = invokeResource<HistoryEntry[]>('api.history.list', () => ({ requestId: this.requestId(), withResponses: true, limit: 50 }), { refreshOn: ['history'] });
  /** The sends that kept a response, newest first. */
  protected readonly kept = computed(() => (this.entries.value() ?? []).filter((e) => e.response));
  protected readonly loading = computed(() => this.entries.value() === undefined);
  protected readonly rightId = linkedSignal(() => (this.tab().data?.['right'] as string | undefined) ?? this.kept()[0]?.id ?? '');
  protected readonly leftId = linkedSignal(() => {
    const given = this.tab().data?.['left'] as string | undefined;
    if (given) return given;
    const list = this.kept();
    const at = list.findIndex((e) => e.id === this.rightId());
    return list[at + 1]?.id ?? '';
  });
  protected readonly normalise = linkedSignal(() => true);
  protected readonly headers = linkedSignal(() => false);
  private readonly left = computed(() => this.kept().find((e) => e.id === this.leftId()));
  private readonly right = computed(() => this.kept().find((e) => e.id === this.rightId()));
  protected readonly leftText = computed(() => sideText(this.left()?.response, this.normalise(), this.headers()));
  protected readonly rightText = computed(() => sideText(this.right()?.response, this.normalise(), this.headers()));
  protected readonly language = computed(() => {
    const type = `${this.left()?.response?.contentType ?? ''} ${this.right()?.response?.contentType ?? ''}`;
    return !this.headers() && /json/i.test(type) ? ('json' as const) : ('text' as const);
  });
  protected readonly same = computed(() => Boolean(this.left() && this.right()) && this.leftText() === this.rightText());
  protected readonly name = computed(() => this.kept()[0]?.request.name ?? this.tab().title);

  protected label(entry: HistoryEntry): string {
    return `${new Date(entry.at).toLocaleTimeString()} · ${entry.status ?? 'ERR'} · ${shortRelativeTime(Date.parse(entry.at) - Date.now())}`;
  }

  protected pick(side: 'left' | 'right', event: Event): void {
    const id = (event.target as HTMLSelectElement).value;
    (side === 'left' ? this.leftId : this.rightId).set(id);
    this.tabs.updateTab(this.scope(), this.tab().id, { data: { ...this.tab().data, [side]: id } });
  }
}
