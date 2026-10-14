import { Component, ElementRef, effect, inject, signal } from '@angular/core';
import type { MockServerSummary } from '@quiver/core';
import { Button, Icon, IconButton, SectionHeader, Spinner, invokeResource } from '@quiver/ui';
import { Play, Plus, Webhook } from 'lucide';
import { MockActions, type ServerKind } from './mock-actions';
import { MockServerNode } from './mock-server-node';

/** The + of the Servers header: a mock API server or a webhook receiver. */
@Component({
  selector: 'q-mock-new-server-menu',
  imports: [Icon, IconButton],
  template: `
    <button qIconButton label="New server" size="sm" (click)="open.set(!open())"><svg [qIcon]="icons.Plus" class="size-3.5"></svg></button>
    @if (open()) {
      <div class="absolute right-0 top-full mt-1 z-20 min-w-44 rounded-md border border-edge bg-elevated shadow-lg py-1 normal-case tracking-normal font-normal">
        <button type="button" class="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-fg hover:bg-surface" (click)="pick('mock')"><svg [qIcon]="icons.Play" class="size-3.5 text-muted"></svg> Mock API server</button>
        <button type="button" class="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-fg hover:bg-surface" (click)="pick('webhook')"><svg [qIcon]="icons.Webhook" class="size-3.5 text-muted"></svg> Webhook receiver</button>
      </div>
    }
  `,
  host: { class: 'relative block' },
})
export class MockNewServerMenu {
  private readonly mock = inject(MockActions);
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);

  protected readonly icons = { Play, Plus, Webhook };
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

  protected pick(kind: ServerKind): void {
    this.open.set(false);
    void this.mock.createServer(kind);
  }
}

/** The project's mock servers with their routes and captured requests. */
@Component({
  selector: 'q-mock-sidebar',
  imports: [Button, MockNewServerMenu, MockServerNode, SectionHeader, Spinner],
  template: `
    <q-section-header title="Servers"><q-mock-new-server-menu /></q-section-header>
    @if (servers.isLoading() && !servers.value()) {
      <div class="px-3 py-2"><svg qSpinner></svg></div>
    }
    @for (server of servers.value() ?? []; track server.id) {
      <q-mock-server-node [server]="server" />
    }
    @if (servers.value()?.length === 0) {
      <div class="px-3 py-2 flex flex-col gap-2">
        <p class="text-xs text-muted">Local HTTP servers that answer with canned responses or capture whatever they receive. Requests, routes and settings are saved with the project.</p>
        <div class="flex gap-1">
          <button qButton size="sm" variant="secondary" [icon]="icons.Plus" (click)="mock.createServer('mock')">Mock server</button>
          <button qButton size="sm" variant="secondary" [icon]="icons.Webhook" (click)="mock.createServer('webhook')">Webhook receiver</button>
        </div>
      </div>
    }
    @if (servers.error(); as error) {
      <p class="px-3 py-2 text-xs text-danger">{{ error.message }}</p>
    }
  `,
  host: { class: 'flex flex-col h-full min-h-0 overflow-y-auto text-sm' },
})
export class MockSidebar {
  protected readonly mock = inject(MockActions);

  protected readonly icons = { Plus, Webhook };
  protected readonly servers = invokeResource<MockServerSummary[]>('mock.server.list', () => ({}), { refreshOn: ['mock-servers'], refreshOnEvents: ['mock.changed'] });
}
