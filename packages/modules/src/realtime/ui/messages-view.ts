import { Component, ElementRef, afterRenderEffect, computed, effect, inject, input, output, signal, untracked, viewChild } from '@angular/core';
import type { RealtimeConnectionSummary, RealtimeMessage, RealtimeSavedMessage } from '@quiver/core';
import { Badge, HostBridge, Icon, IconButton, Input, Toasts, formatBytes, injectHostEvent, invokeResource } from '@quiver/ui';
import { ArrowDown, ArrowDownToLine, ArrowUp, Info, RefreshCw, Trash2 } from 'lucide';
import { RealtimeComposer } from './composer';
import { RealtimeMessageDetail } from './message-detail';

const PAGE = 500;

/** The live log of a connection, newest at the bottom and followed while scrolled there, with the composer below. */
@Component({
  selector: 'q-realtime-messages-view',
  imports: [Badge, Icon, IconButton, Input, RealtimeComposer, RealtimeMessageDetail],
  templateUrl: './messages-view.html',
  host: { class: 'flex h-full min-h-0' },
})
export class RealtimeMessagesView {
  private readonly host = inject(HostBridge);
  private readonly toasts = inject(Toasts);
  private readonly list = viewChild.required<ElementRef<HTMLDivElement>>('list');

  readonly connection = input.required<RealtimeConnectionSummary>();
  readonly savedMessages = input.required<RealtimeSavedMessage[]>();
  readonly saveMessage = output<string>();

  protected readonly icons = { ArrowDown, ArrowDownToLine, ArrowUp, Info, RefreshCw, Trash2 };
  protected readonly formatBytes = formatBytes;

  private readonly connectionId = computed(() => this.connection().id);
  protected readonly items = invokeResource<RealtimeMessage[]>('realtime.message.list', () => ({ id: this.connectionId(), limit: PAGE }));
  protected readonly selectedId = signal<string | null>(null);
  protected readonly filter = signal('');
  /** Whether the list sticks to the newest message; scrolling up stops it. */
  protected readonly follow = signal(true);
  protected readonly filtered = computed(() => {
    const items = this.items.value() ?? [];
    const needle = this.filter().trim().toLowerCase();
    return needle ? items.filter((m) => `${m.event ?? ''} ${m.data} ${m.kind}`.toLowerCase().includes(needle)) : items;
  });
  protected readonly selected = computed(() => this.items.value()?.find((m) => m.id === this.selectedId()) ?? null);

  constructor() {
    injectHostEvent('realtime.changed', (p) => p.connectionId === this.connectionId() && p.reason === 'messages' && this.items.reload());

    effect(() => {
      const error = this.items.error();
      if (error) untracked(() => this.toasts.error(error));
    });

    afterRenderEffect({
      write: () => {
        this.items.value();
        if (!this.follow()) return;
        const el = this.list().nativeElement;
        el.scrollTop = el.scrollHeight;
      },
    });
  }

  protected typed(event: Event): void {
    this.filter.set((event.target as HTMLInputElement).value);
  }

  protected scrolled(): void {
    const el = this.list().nativeElement;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (atBottom !== this.follow()) this.follow.set(atBottom);
  }

  protected pick(id: string): void {
    this.selectedId.update((current) => (current === id ? null : id));
  }

  protected preview(message: RealtimeMessage): string {
    return message.encoding === 'base64' ? `binary, ${formatBytes(message.size)}` : message.data.replace(/\s+/g, ' ').slice(0, 300);
  }

  protected time(at: string | number): string {
    return new Date(at).toLocaleTimeString();
  }

  protected async clear(): Promise<void> {
    try {
      await this.host.invoke('realtime.message.clear', { id: this.connectionId() });
      this.selectedId.set(null);
    } catch (err) {
      this.toasts.error(err);
    }
  }
}
