import { Component, computed, inject, input } from '@angular/core';
import { describeRoute, type MockRoute, type MockServerSummary } from '@quiver/core';
import { Icon, IconButton, METHOD_COLORS, Toasts, TreeState } from '@quiver/ui';
import { ChevronDown, ChevronRight, Inbox, Pencil, Play, Square, Trash2 } from 'lucide';
import { MockActions } from './mock-actions';

/** A server in the sidebar: its state and port, and when expanded its routes and requests. */
@Component({
  selector: 'q-mock-server-node',
  imports: [Icon, IconButton],
  templateUrl: './mock-server-node.html',
  host: { class: 'block' },
})
export class MockServerNode {
  private readonly tree = inject(TreeState);
  private readonly toasts = inject(Toasts);
  protected readonly mock = inject(MockActions);

  readonly server = input.required<MockServerSummary>();

  protected readonly icons = { ChevronDown, ChevronRight, Inbox, Pencil, Play, Square, Trash2 };
  protected readonly methodColors = METHOD_COLORS;
  protected readonly open = computed(() => this.tree.isExpanded(`mock/${this.server().id}`));
  protected readonly dot = computed(() => {
    const server = this.server();
    return server.running ? 'bg-success' : server.error ? 'bg-danger' : 'bg-muted/50';
  });
  protected readonly title = computed(() => {
    const server = this.server();
    return server.error ?? (server.running ? `Listening on ${server.url}` : `Stopped, port ${server.port}`);
  });

  protected toggle(event: MouseEvent): void {
    event.stopPropagation();
    this.tree.toggle(`mock/${this.server().id}`);
  }

  protected startStop(event: MouseEvent): void {
    event.stopPropagation();
    this.mock.toggleServer(this.server()).catch((err) => this.toasts.error(err));
  }

  protected editRoutes(event: MouseEvent): void {
    event.stopPropagation();
    this.mock.openServerTab(this.server(), 'routes');
  }

  protected remove(event: MouseEvent): void {
    event.stopPropagation();
    this.mock.deleteServer(this.server()).catch((err) => this.toasts.error(err));
  }

  protected routeTitle(route: MockRoute): string {
    return `${describeRoute(route)} → ${route.status}${route.description ? `\n${route.description}` : ''}`;
  }
}
