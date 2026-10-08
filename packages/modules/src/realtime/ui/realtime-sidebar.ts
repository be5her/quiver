import { Component, ElementRef, computed, effect, inject, input, signal } from '@angular/core';
import { describeConnection, type RealtimeConnectionSummary, type RealtimeKind } from '@quiver/core';
import { Button, Icon, IconButton, SectionHeader, Spinner, invokeResource } from '@quiver/ui';
import { Cable, Plug, Plus, Rss, Trash2, Unplug } from 'lucide';
import { RealtimeActions } from './realtime-actions';
import { kindClass, statusDot } from './realtime-format';

/** The + of the Connections header: a WebSocket or an event stream. */
@Component({
  selector: 'q-realtime-new-connection-menu',
  imports: [Icon, IconButton],
  template: `
    <button qIconButton label="New connection" size="sm" (click)="open.set(!open())"><svg [qIcon]="icons.Plus" class="size-3.5"></svg></button>
    @if (open()) {
      <div class="absolute right-0 top-full mt-1 z-20 min-w-44 rounded-md border border-edge bg-elevated shadow-lg py-1 normal-case tracking-normal font-normal">
        <button type="button" class="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-fg hover:bg-surface" (click)="pick('websocket')"><svg [qIcon]="icons.Cable" class="size-3.5 text-muted"></svg> WebSocket</button>
        <button type="button" class="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-fg hover:bg-surface" (click)="pick('sse')"><svg [qIcon]="icons.Rss" class="size-3.5 text-muted"></svg> Event stream (SSE)</button>
      </div>
    }
  `,
  host: { class: 'relative block' },
})
export class RealtimeNewConnectionMenu {
  private readonly realtime = inject(RealtimeActions);
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);

  protected readonly icons = { Cable, Plus, Rss };
  protected readonly open = signal(false);

  constructor() {
    effect((onCleanup) => {
      if (!this.open()) return;
      const onDown = (e: MouseEvent) => {
        if (!this.element.nativeElement.contains(e.target as Node)) this.open.set(false);
      };
      document.addEventListener('mousedown', onDown);
      onCleanup(() => document.removeEventListener('mousedown', onDown));
    });
  }

  protected pick(kind: RealtimeKind): void {
    this.open.set(false);
    void this.realtime.createConnection(kind);
  }
}

/** One connection: status, kind, name and message count; connect and delete on hover. */
@Component({
  selector: 'q-realtime-connection-row',
  imports: [Icon, IconButton],
  template: `
    @let c = conn();
    <span class="size-2 rounded-full shrink-0" [class]="dot()" [attr.aria-label]="c.status"></span>
    <span class="text-[9px] font-bold w-7 shrink-0" [class]="kind()">{{ c.kind === 'sse' ? 'SSE' : 'WS' }}</span>
    <span class="truncate flex-1 text-[13px]">{{ c.name }}</span>
    @if (c.messageCount > 0) {
      <span class="text-[10px] rounded-full bg-elevated px-1.5 text-muted shrink-0 group-hover:hidden" [title]="c.messageCount + ' messages'">{{ c.messageCount }}</span>
    }
    <span class="hidden group-hover:flex items-center">
      <button qIconButton [label]="open() ? 'Disconnect' : 'Connect'" size="sm" (click)="toggle($event)"><svg [qIcon]="open() ? icons.Unplug : icons.Plug" class="size-3.5"></svg></button>
      <button qIconButton label="Delete connection" size="sm" (click)="remove($event)"><svg [qIcon]="icons.Trash2" class="size-3.5"></svg></button>
    </span>
  `,
  host: {
    role: 'button',
    tabindex: '0',
    class: 'group flex items-center gap-1.5 pl-3 pr-1 h-7 cursor-pointer hover:bg-elevated min-w-0',
    'data-testid': 'realtime-connection',
    '[attr.title]': 'title()',
    '[attr.data-status]': 'conn().status',
    '(click)': 'openTab()',
    '(keydown.enter)': 'openTab()',
  },
})
export class RealtimeConnectionRow {
  private readonly realtime = inject(RealtimeActions);

  readonly conn = input.required<RealtimeConnectionSummary>();

  protected readonly icons = { Plug, Trash2, Unplug };
  protected readonly open = computed(() => this.conn().status !== 'disconnected');
  protected readonly title = computed(() => this.conn().error ?? `${describeConnection(this.conn())} · ${this.conn().status}`);
  protected readonly dot = computed(() => statusDot(this.conn().status, this.conn().error));
  protected readonly kind = computed(() => kindClass(this.conn().kind));

  protected openTab(): void {
    this.realtime.openConnectionTab(this.conn());
  }

  protected toggle(event: Event): void {
    event.stopPropagation();
    void this.realtime.toggleConnection(this.conn());
  }

  protected remove(event: Event): void {
    event.stopPropagation();
    void this.realtime.deleteConnection(this.conn());
  }
}

/** The project's WebSocket and SSE connections. */
@Component({
  selector: 'q-realtime-sidebar',
  imports: [Button, RealtimeConnectionRow, RealtimeNewConnectionMenu, SectionHeader, Spinner],
  template: `
    <q-section-header title="Connections"><q-realtime-new-connection-menu /></q-section-header>
    @if (connections.isLoading() && !connections.value()) {
      <div class="px-3 py-2"><svg qSpinner></svg></div>
    }
    @for (conn of connections.value() ?? []; track conn.id) {
      <q-realtime-connection-row [conn]="conn" />
    }
    @if (connections.value()?.length === 0) {
      <div class="px-3 py-2 flex flex-col gap-2">
        <p class="text-xs text-muted">WebSocket and Server-Sent Events connections saved with the project. Messages are logged live and agents can wait for the next one.</p>
        <div class="flex gap-1">
          <button qButton size="sm" variant="secondary" [icon]="icons.Cable" (click)="realtime.createConnection('websocket')">WebSocket</button>
          <button qButton size="sm" variant="secondary" [icon]="icons.Rss" (click)="realtime.createConnection('sse')">Event stream</button>
        </div>
      </div>
    }
    @if (connections.error(); as error) {
      <p class="px-3 py-2 text-xs text-danger">{{ error.message }}</p>
    }
  `,
  host: { class: 'flex flex-col h-full min-h-0 overflow-y-auto text-sm' },
})
export class RealtimeSidebar {
  protected readonly realtime = inject(RealtimeActions);

  protected readonly icons = { Cable, Rss };
  protected readonly connections = invokeResource<RealtimeConnectionSummary[]>('realtime.connection.list', () => ({}), {
    refreshOn: ['realtime-connections'],
    refreshOnEvents: ['realtime.changed'],
  });
}
