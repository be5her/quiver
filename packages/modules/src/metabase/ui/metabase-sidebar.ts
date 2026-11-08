import { Component, computed, effect, inject, input, untracked } from '@angular/core';
import { describeMetabaseConnection, type MetabaseConnectionSummary } from '@quiver/core';
import { Button, ContextMenu, HostBridge, Icon, IconButton, SectionHeader, Spinner, TreeState, invokeResource } from '@quiver/ui';
import { ChevronDown, ChevronRight, Database, Ellipsis, Library, Plus, SquareTerminal } from 'lucide';
import { DbRow } from '../../db/ui/db-row';
import { MetabaseActions } from './metabase-actions';
import { connectionSessionText, mbSessionDot } from './metabase-format';
import { MetabaseDatabaseList, MetabaseItemList } from './metabase-tree';

/** A connection: its sign-in dot and name, expanding to its collections and its databases. */
@Component({
  selector: 'q-mb-connection-node',
  imports: [DbRow, Icon, IconButton, MetabaseDatabaseList, MetabaseItemList],
  template: `
    @let c = conn();
    <div
      qDbRow
      [label]="c.name"
      bold
      data-testid="mb-connection-row"
      [attr.data-session]="c.session.state"
      (click)="toggle()"
      (keydown.enter)="toggle()"
      (contextmenu)="menu($event)"
    >
      <svg rowPrefix [qIcon]="open() ? icons.ChevronDown : icons.ChevronRight" class="size-3.5 text-muted shrink-0"></svg>
      <span rowPrefix class="size-2 rounded-full shrink-0" [class]="dot()" data-testid="mb-session-dot" [attr.aria-label]="c.session.state" [attr.title]="title()"></span>
      <button qIconButton label="New query" size="sm" data-testid="mb-new-query" (click)="newQuery($event)"><svg [qIcon]="icons.SquareTerminal" class="size-3.5"></svg></button>
      <button qIconButton label="More actions" size="sm" data-testid="mb-connection-menu" (click)="menu($event)"><svg [qIcon]="icons.Ellipsis" class="size-3.5"></svg></button>
    </div>
    @if (open()) {
      @if (!c.url) {
        <p class="text-xs text-muted px-3 py-1" [style.padding-left.px]="22">No address yet. <button type="button" class="underline" (click)="metabase.openConnectionTab(c)">Set it up</button></p>
      } @else {
        <div qDbRow [depth]="1" label="Collections" data-testid="mb-tree-collections" (click)="toggleSection('collections')" (keydown.enter)="toggleSection('collections')">
          <svg rowPrefix [qIcon]="collectionsOpen() ? icons.ChevronDown : icons.ChevronRight" class="size-3.5 text-muted shrink-0"></svg>
          <svg rowPrefix [qIcon]="icons.Library" class="size-3.5 text-muted shrink-0"></svg>
        </div>
        @if (collectionsOpen()) {
          <q-mb-item-list [conn]="c" collectionId="root" [depth]="2" />
        }
        <div qDbRow [depth]="1" label="Databases" data-testid="mb-tree-databases" (click)="toggleSection('databases')" (keydown.enter)="toggleSection('databases')">
          <svg rowPrefix [qIcon]="databasesOpen() ? icons.ChevronDown : icons.ChevronRight" class="size-3.5 text-muted shrink-0"></svg>
          <svg rowPrefix [qIcon]="icons.Database" class="size-3.5 text-muted shrink-0"></svg>
        </div>
        @if (databasesOpen()) {
          <q-mb-database-list [conn]="c" [depth]="2" />
        }
      }
    }
  `,
  host: { class: 'block' },
})
export class MetabaseConnectionNode {
  private readonly host = inject(HostBridge);
  private readonly tree = inject(TreeState);
  private readonly contextMenu = inject(ContextMenu);
  protected readonly metabase = inject(MetabaseActions);

  readonly conn = input.required<MetabaseConnectionSummary>();

  protected readonly icons = { ChevronDown, ChevronRight, Database, Ellipsis, Library, SquareTerminal };
  protected readonly dot = computed(() => mbSessionDot(this.conn().session));
  protected readonly title = computed(() => [describeMetabaseConnection(this.conn()) || 'No Metabase address yet', connectionSessionText(this.conn())].join('\n'));
  protected readonly open = computed(() => this.tree.isExpanded(`mb/${this.conn().id}`));
  protected readonly collectionsOpen = computed(() => this.tree.isExpanded(`mb/${this.conn().id}/collections`, true));
  protected readonly databasesOpen = computed(() => this.tree.isExpanded(`mb/${this.conn().id}/databases`));

  constructor() {
    // Ask the server once whether this machine gets in, so the dot means something before the tree is opened;
    // the answer comes back as a session event, which reloads the list.
    let asked = false;
    effect(() => {
      const c = this.conn();
      if (asked || !c.url || c.session.state !== 'unknown' || (c.auth === 'apikey' && !c.hasApiKey)) return;
      asked = true;
      untracked(() => void this.host.invoke('metabase.session', { connectionId: c.id }).catch(() => {}));
    });
  }

  protected toggle(): void {
    this.tree.toggle(`mb/${this.conn().id}`);
  }

  protected toggleSection(section: 'collections' | 'databases'): void {
    this.tree.toggle(`mb/${this.conn().id}/${section}`, section === 'collections');
  }

  protected newQuery(event: MouseEvent): void {
    event.stopPropagation();
    this.metabase.openQuery(this.conn());
  }

  protected menu(event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.contextMenu.open(event, this.metabase.connectionMenu(this.conn()));
  }
}

/** The project's Metabase connections, each with its collections and databases. */
@Component({
  selector: 'q-mb-sidebar',
  imports: [Button, Icon, IconButton, MetabaseConnectionNode, SectionHeader, Spinner],
  template: `
    <q-section-header title="Connections">
      <button qIconButton label="New Metabase connection" size="sm" data-testid="mb-new-connection" (click)="metabase.createConnection()"><svg [qIcon]="icons.Plus" class="size-3.5"></svg></button>
    </q-section-header>
    @if (connections.isLoading() && !connections.value()) {
      <div class="px-3 py-2"><svg qSpinner></svg></div>
    }
    @for (conn of connections.value() ?? []; track conn.id) {
      <q-mb-connection-node [conn]="conn" />
    }
    @if (connections.value()?.length === 0) {
      <div class="px-3 py-2 flex flex-col gap-2">
        <p class="text-xs text-muted">Run Metabase's saved questions and native SQL from here. Sign in with the account you use in the browser (SSO works), or use an API key; either stays on this machine.</p>
        <div><button qButton size="sm" variant="secondary" [icon]="icons.Plus" (click)="metabase.createConnection()">New connection</button></div>
      </div>
    }
    @if (connections.error(); as error) {
      <p class="px-3 py-2 text-xs text-danger">{{ error.message }}</p>
    }
  `,
  host: { class: 'flex flex-col h-full min-h-0 overflow-y-auto text-sm', 'data-testid': 'mb-sidebar' },
})
export class MetabaseSidebar {
  protected readonly metabase = inject(MetabaseActions);

  protected readonly icons = { Plus };
  protected readonly connections = invokeResource<MetabaseConnectionSummary[]>('metabase.connection.list', () => ({}), {
    refreshOn: ['metabase-connections'],
    refreshOnEvents: ['metabase.changed'],
  });
}
