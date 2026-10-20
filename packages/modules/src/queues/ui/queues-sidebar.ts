import { Component, DestroyRef, computed, inject, input } from '@angular/core';
import type { QueueDestination } from '@quiver/core';
import { Button, ContextMenu, Icon, IconButton, SectionHeader, Spinner, TreeState, invokeResource } from '@quiver/ui';
import { ChevronDown, ChevronRight, Ellipsis, Inbox, Plus, RefreshCw } from 'lucide';
import { DbRow } from '../../db/ui/db-row';
import { QueuesActions } from './queues-actions';
import { injectQueuesChanged } from './queues-events';
import { KIND_BADGE, countOf, describeQueueConnection, destinationWord, kindClass, type QueueConnectionSummary } from './queues-format';

/** How long counts may lag behind a run of produces or purges. */
const RELOAD_EVERY_MS = 1000;

/** A connection: its kind and name, expanding to its topics or queues with their counts. */
@Component({
  selector: 'q-queues-connection-node',
  imports: [DbRow, Icon, IconButton, Spinner],
  template: `
    @let c = conn();
    <div qDbRow [label]="c.name" bold data-testid="queues-connection-row" [attr.data-kind]="c.kind" (click)="toggle()" (keydown.enter)="toggle()" (contextmenu)="menu($event)">
      <svg rowPrefix [qIcon]="open() ? icons.ChevronDown : icons.ChevronRight" class="size-3.5 text-muted shrink-0"></svg>
      <span rowPrefix class="text-[9px] font-bold shrink-0" [class]="kindColour()" [attr.title]="title()">{{ badge() }}</span>
      <button qIconButton [label]="'New ' + word()" size="sm" data-testid="queues-new-destination" (click)="newDestination($event)"><svg [qIcon]="icons.Plus" class="size-3.5"></svg></button>
      <button qIconButton label="Refresh" size="sm" (click)="refresh($event)"><svg [qIcon]="icons.RefreshCw" class="size-3.5"></svg></button>
      <button qIconButton label="More actions" size="sm" data-testid="queues-connection-menu" (click)="menu($event)"><svg [qIcon]="icons.Ellipsis" class="size-3.5"></svg></button>
    </div>
    @if (open()) {
      @if (destinations.isLoading() && !destinations.value()) {
        <div class="py-1" [style.padding-left.px]="30"><svg qSpinner></svg></div>
      }
      @if (destinations.error(); as error) {
        <p class="text-xs text-danger py-1 pr-2 break-words" [style.padding-left.px]="30" data-testid="queues-destinations-error">{{ error.message }}</p>
      }
      @for (d of destinations.value() ?? []; track d.name) {
        <div
          qDbRow
          [depth]="1"
          [label]="d.name"
          [hint]="count(d)"
          data-testid="queues-destination-row"
          [attr.data-name]="d.name"
          [attr.data-count]="d.messages ?? ''"
          (click)="openDestination(d)"
          (keydown.enter)="openDestination(d)"
          (contextmenu)="destinationMenu($event, d)"
        >
          <svg rowPrefix [qIcon]="icons.Inbox" class="size-3.5 text-muted shrink-0"></svg>
          @if (d.fifo) {
            <span rowBadge class="text-[9px] font-bold text-muted shrink-0">FIFO</span>
          }
          <button qIconButton label="More actions" size="sm" (click)="destinationMenu($event, d)"><svg [qIcon]="icons.Ellipsis" class="size-3.5"></svg></button>
        </div>
      }
      @if (destinations.value()?.length === 0) {
        <p class="text-xs text-muted py-1 pr-2" [style.padding-left.px]="30">
          No {{ word() }}s yet. <button type="button" class="underline" (click)="actions.createDestination(c)">Create one</button>{{ c.kind === 'memory' || c.kind === 'kafka' ? ' or produce to a new name.' : '.' }}
        </p>
      }
    }
  `,
  host: { class: 'block' },
})
export class QueuesConnectionNode {
  private readonly tree = inject(TreeState);
  private readonly contextMenu = inject(ContextMenu);
  protected readonly actions = inject(QueuesActions);

  readonly conn = input.required<QueueConnectionSummary>();

  protected readonly icons = { ChevronDown, ChevronRight, Ellipsis, Inbox, Plus, RefreshCw };
  protected readonly open = computed(() => this.tree.isExpanded(`queues/${this.conn().id}`));
  protected readonly badge = computed(() => KIND_BADGE[this.conn().kind]);
  protected readonly kindColour = computed(() => kindClass(this.conn().kind));
  protected readonly word = computed(() => destinationWord(this.conn().kind));
  protected readonly title = computed(() => `${this.conn().name}\n${describeQueueConnection(this.conn())}`);
  protected readonly destinations = invokeResource<QueueDestination[]>('queues.destination.list', () => ({ connectionId: this.conn().id }), {
    enabled: () => this.open(),
  });
  protected readonly count = countOf;

  /** A listing waiting to be reloaded: at most one a second, since one can cost a call per queue (SQS) or an admin call. */
  private reloadTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    // Counts follow produces, purges, creates and deletes made here; what other clients do shows on Refresh. A tail's
    // events (four a second while it receives) are left out, so a busy Kafka topic does not cost an admin call each, and
    // a run of produces (an agent sending a hundred) reloads once a second rather than once each.
    injectQueuesChanged((p) => {
      if (!this.open() || p.reason === 'consumer' || (p.connectionId && p.connectionId !== this.conn().id) || this.reloadTimer) return;
      this.reloadTimer = setTimeout(
        () => {
          this.reloadTimer = null;
          if (this.open()) this.destinations.reload();
        },
        p.reason === 'messages' ? RELOAD_EVERY_MS : 0,
      );
    });
    inject(DestroyRef).onDestroy(() => {
      if (this.reloadTimer) clearTimeout(this.reloadTimer);
    });
  }

  protected toggle(): void {
    this.tree.toggle(`queues/${this.conn().id}`);
  }

  protected refresh(event: Event): void {
    event.stopPropagation();
    if (!this.open()) this.toggle();
    else this.destinations.reload();
  }

  protected newDestination(event: Event): void {
    event.stopPropagation();
    void this.actions.createDestination(this.conn());
  }

  protected openDestination(d: QueueDestination): void {
    this.actions.openDestination(this.conn(), d.name);
  }

  protected menu(event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.contextMenu.open(event, this.actions.connectionMenu(this.conn()));
  }

  protected destinationMenu(event: MouseEvent, d: QueueDestination): void {
    event.preventDefault();
    event.stopPropagation();
    this.contextMenu.open(event, this.actions.destinationMenu(this.conn(), d.name));
  }
}

/** The project's queue connections, each with its topics or queues. */
@Component({
  selector: 'q-queues-sidebar',
  imports: [Button, Icon, IconButton, QueuesConnectionNode, SectionHeader, Spinner],
  template: `
    <q-section-header title="Connections">
      <button qIconButton label="New queue connection" size="sm" data-testid="queues-new-connection" (click)="actions.createConnection()"><svg [qIcon]="icons.Plus" class="size-3.5"></svg></button>
    </q-section-header>
    @if (connections.isLoading() && !connections.value()) {
      <div class="px-3 py-2"><svg qSpinner></svg></div>
    }
    @for (conn of connections.value() ?? []; track conn.id) {
      <q-queues-connection-node [conn]="conn" />
    }
    @if (connections.value()?.length === 0) {
      <div class="px-3 py-2 flex flex-col gap-2" data-testid="queues-empty">
        <p class="text-xs text-muted">Kafka topics, SQS and RabbitMQ queues: peek at messages without consuming them, produce, tail live and watch consumer lag. Connections are saved with the project; passwords and keys stay on this machine.</p>
        <div class="flex gap-1 flex-wrap">
          <button qButton size="sm" variant="secondary" [icon]="icons.Plus" (click)="actions.createConnection()">New connection</button>
          <button qButton size="sm" variant="ghost" (click)="actions.createConnection('memory')">Try the in-memory broker</button>
        </div>
      </div>
    }
    @if (connections.error(); as error) {
      <p class="px-3 py-2 text-xs text-danger">{{ error.message }}</p>
    }
  `,
  host: { class: 'flex flex-col h-full min-h-0 overflow-y-auto text-sm', 'data-testid': 'queues-sidebar' },
})
export class QueuesSidebar {
  protected readonly actions = inject(QueuesActions);

  protected readonly icons = { Plus };
  protected readonly connections = invokeResource<QueueConnectionSummary[]>('queues.connection.list', () => ({}), {
    refreshOn: ['queues'],
  });

  constructor() {
    injectQueuesChanged((p) => p.reason === 'connections' && this.connections.reload());
  }
}
