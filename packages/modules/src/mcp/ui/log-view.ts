import { Component, ElementRef, afterRenderEffect, computed, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import { MCP_LOGGING_LEVELS, type McpLogEntry, type McpServerSummary } from '@quiver/core';
import { Badge, HostBridge, Icon, IconButton, Input, Select, Toasts, formatBytes, formatMs, injectHostEvent, invokeResource } from '@quiver/ui';
import { ArrowDown, ArrowDownToLine, ArrowUp, Info, RefreshCw, Trash2 } from 'lucide';
import { KIND_COLOR, McpLogDetail } from './log-detail';
import { McpRawRequest } from './raw-request';

const PAGE = 500;

type Direction = '' | McpLogEntry['direction'];

/** The short form of an entry: the params, result or error of a message, or the text of an event. */
function preview(entry: McpLogEntry): string {
  if (entry.direction === 'system' || entry.kind === 'stderr') return entry.data;
  try {
    const m = JSON.parse(entry.data) as { params?: unknown; result?: unknown; error?: { message?: string } };
    if (m.error) return m.error.message ?? JSON.stringify(m.error);
    const body = m.params ?? m.result;
    return body === undefined ? '' : JSON.stringify(body);
  } catch {
    return entry.data;
  }
}

/** Every JSON-RPC message to and from the server, its stderr and state changes; followed while scrolled to the bottom. */
@Component({
  selector: 'q-mcp-log-view',
  imports: [Badge, Icon, IconButton, Input, McpLogDetail, McpRawRequest, Select],
  templateUrl: './log-view.html',
  host: { class: 'flex h-full min-h-0' },
})
export class McpLogView {
  private readonly host = inject(HostBridge);
  private readonly toasts = inject(Toasts);
  private readonly list = viewChild.required<ElementRef<HTMLDivElement>>('list');

  readonly server = input.required<McpServerSummary>();

  protected readonly icons = { ArrowDown, ArrowDownToLine, ArrowUp, Info, RefreshCw, Trash2 };
  protected readonly levels = MCP_LOGGING_LEVELS;
  protected readonly kindColor = KIND_COLOR;
  protected readonly formatBytes = formatBytes;
  protected readonly formatMs = formatMs;

  private readonly serverId = computed(() => this.server().id);
  protected readonly items = invokeResource<McpLogEntry[]>('mcp.log.list', () => ({ id: this.serverId(), limit: PAGE }));
  protected readonly selectedId = signal<string | null>(null);
  protected readonly filter = signal('');
  protected readonly direction = signal<Direction>('');
  /** Whether the list sticks to the newest entry; scrolling up stops it. */
  protected readonly follow = signal(true);
  protected readonly canLog = computed(() => Boolean(this.server().capabilities?.logging) && this.server().status === 'connected');
  protected readonly rows = computed(() => {
    const needle = this.filter().trim().toLowerCase();
    const direction = this.direction();
    return (this.items.value() ?? [])
      .filter((m) => (!direction || m.direction === direction) && (!needle || `${m.method ?? ''} ${m.kind} ${m.data}`.toLowerCase().includes(needle)))
      .map((entry) => ({ entry, text: preview(entry).replace(/\s+/g, ' ').slice(0, 300) }));
  });
  protected readonly selected = computed(() => this.items.value()?.find((m) => m.id === this.selectedId()) ?? null);

  constructor() {
    injectHostEvent('mcp.changed', (p) => p.serverId === this.serverId() && p.reason === 'log' && this.items.reload());

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

  protected setDirection(event: Event): void {
    this.direction.set((event.target as HTMLSelectElement).value as Direction);
  }

  protected scrolled(): void {
    const el = this.list().nativeElement;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (atBottom !== this.follow()) this.follow.set(atBottom);
  }

  protected pick(id: string): void {
    this.selectedId.update((current) => (current === id ? null : id));
  }

  protected badgeClass(entry: McpLogEntry): string {
    return `${KIND_COLOR[entry.kind] ?? ''}${entry.ok === false ? ' text-danger' : ''}`;
  }

  protected textClass(entry: McpLogEntry): string {
    return `${entry.direction === 'system' ? 'italic text-muted' : ''}${entry.kind === 'error' ? ' text-danger' : ''}`;
  }

  protected time(at: string | number): string {
    return new Date(at).toLocaleTimeString();
  }

  protected async clear(): Promise<void> {
    try {
      await this.host.invoke('mcp.log.clear', { id: this.serverId() });
      this.selectedId.set(null);
    } catch (err) {
      this.toasts.error(err);
    }
  }

  /** Ask the server for log messages at a level and above; the picker goes back to its prompt. */
  protected async setLevel(event: Event): Promise<void> {
    const select = event.target as HTMLSelectElement;
    const level = select.value;
    select.value = '';
    if (!level) return;
    try {
      await this.host.invoke('mcp.logging.level', { id: this.serverId(), level });
      this.toasts.notify(`Logging level set to ${level}`, 'success');
    } catch (err) {
      this.toasts.error(err);
    }
  }
}
