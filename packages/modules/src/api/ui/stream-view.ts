import { Component, ElementRef, computed, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import { type StreamItem, type StreamKind, type StreamRead } from '@quiver/core';
import { Button, Checkbox, HostBridge, Toasts, formatBytes, injectHostEvent } from '@quiver/ui';
import { Square } from 'lucide';

/** Items kept on screen; the host keeps its own buffer, so this only bounds the list. */
const SHOWN = 5000;

/**
 * A streamed response body as it arrives: each event (name, id, data) or line with its time,
 * following the end of the list until scrolled up, and Stop to close the connection.
 */
@Component({
  selector: 'q-stream-view',
  imports: [Button, Checkbox],
  templateUrl: './stream-view.html',
  host: { class: 'flex flex-col h-full min-h-0' },
})
export class StreamView {
  private readonly host = inject(HostBridge);
  private readonly toasts = inject(Toasts);

  readonly streamId = input.required<string>();
  readonly kind = input<StreamKind>('sse');

  protected readonly icons = { Square };
  protected readonly items = signal<StreamItem[]>([]);
  protected readonly done = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly dropped = signal(0);
  protected readonly bytes = signal(0);
  protected readonly follow = signal(true);
  protected readonly size = computed(() => formatBytes(this.bytes()));
  private readonly list = viewChild<ElementRef<HTMLElement>>('list');
  private next = 0;
  private reading = false;
  private again = false;

  constructor() {
    // A new stream (the next send) starts from nothing.
    effect(() => {
      this.streamId();
      untracked(() => {
        this.items.set([]);
        this.done.set(false);
        this.error.set(null);
        this.dropped.set(0);
        this.bytes.set(0);
        this.follow.set(true);
        this.next = 0;
        void this.read();
      });
    });
    injectHostEvent('api.changed', (p) => {
      if (p.reason === 'stream' && p.streamId === this.streamId()) void this.read();
    });
    effect(() => {
      this.items();
      if (!untracked(this.follow)) return;
      queueMicrotask(() => {
        const el = this.list()?.nativeElement;
        if (el) el.scrollTop = el.scrollHeight;
      });
    });
  }

  /** One read at a time; an event that arrives during one makes it read once more. */
  private async read(): Promise<void> {
    if (this.reading) {
      this.again = true;
      return;
    }
    this.reading = true;
    try {
      do {
        this.again = false;
        const id = this.streamId();
        const page = await this.host.invoke<StreamRead>('api.request.stream.read', { streamId: id, since: this.next });
        if (id !== this.streamId()) return;
        this.next = page.next;
        if (page.items.length) this.items.update((items) => [...items, ...page.items].slice(-SHOWN));
        this.dropped.update((d) => d + page.dropped);
        this.bytes.set(page.bytes);
        this.error.set(page.error);
        this.done.set(page.done);
      } while (this.again);
    } catch (err) {
      this.error.set((err as Error).message);
      this.done.set(true);
    } finally {
      this.reading = false;
    }
  }

  /** Scrolling up stops following; scrolling back to the end follows again. */
  protected scrolled(event: Event): void {
    const el = event.target as HTMLElement;
    this.follow.set(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
  }

  protected setFollow(on: boolean): void {
    this.follow.set(on);
    if (on) {
      const el = this.list()?.nativeElement;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }

  protected async stop(): Promise<void> {
    await this.host.invoke('api.request.stream.stop', { streamId: this.streamId() }).catch((err) => this.toasts.error(err));
  }

  protected time(ms: number): string {
    return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
  }
}
