import { Component, computed, model } from '@angular/core';
import { describeRoute, newMockRoute, type MockRoute } from '@quiver/core';
import { Button, EmptyState, Icon, IconButton, METHOD_COLORS } from '@quiver/ui';
import { Plus } from 'lucide';
import { MockRouteEditor } from './route-editor';

/** The routes in match order, and the one picked in an editor. */
@Component({
  selector: 'q-mock-routes-view',
  imports: [Button, EmptyState, Icon, IconButton, MockRouteEditor],
  templateUrl: './routes-view.html',
  host: { class: 'flex h-full min-h-0' },
})
export class MockRoutesView {
  readonly routes = model.required<MockRoute[]>();
  readonly selected = model<string | null>(null);

  protected readonly plus = Plus;
  protected readonly methodColors = METHOD_COLORS;
  protected readonly describe = describeRoute;
  protected readonly index = computed(() => this.routes().findIndex((r) => r.id === this.selected()));
  protected readonly route = computed(() => this.routes()[this.index()] ?? null);

  protected add(): void {
    const route = newMockRoute({ method: 'GET', path: '/', status: 200, body: '{\n  "ok": true\n}' });
    this.routes.update((routes) => [...routes, route]);
    this.selected.set(route.id);
  }

  protected update(route: MockRoute): void {
    this.routes.update((routes) => routes.map((r) => (r.id === route.id ? route : r)));
  }

  protected remove(): void {
    const id = this.selected();
    this.routes.update((routes) => routes.filter((r) => r.id !== id));
    this.selected.set(null);
  }

  protected move(dir: -1 | 1): void {
    const index = this.index();
    const target = index + dir;
    const routes = [...this.routes()];
    if (index < 0 || target < 0 || target >= routes.length) return;
    [routes[index], routes[target]] = [routes[target], routes[index]];
    this.routes.set(routes);
  }
}
