import { Component, computed, inject, input } from '@angular/core';
import { collectionsWithMatches, compareRequests, matchesRequest, type ApiCollection, type ApiRequest, type ApiRun } from '@quiver/core';
import { AppState, Icon, IconButton, METHOD_COLORS, TabsState, TreeState } from '@quiver/ui';
import { ChevronDown, ChevronRight, Ellipsis, Settings2 } from 'lucide';
import { ApiActions } from './api-actions';
import { ApiRow } from './api-row';
import { ApiTreeDrag } from './api-tree-drag';

/**
 * The collections and requests under one parent, collections first; collections nest the same way.
 * Rows drag onto collections (or the top level), open a menu on right-click or their … button, and
 * narrow to what matches `filter`, with the collections holding a match kept and opened.
 */
@Component({
  selector: 'q-api-collection-tree',
  imports: [ApiRow, Icon, IconButton],
  templateUrl: './api-collection-tree.html',
  host: { class: 'contents' },
})
export class ApiCollectionTree {
  private readonly app = inject(AppState);
  private readonly tabs = inject(TabsState);
  private readonly tree = inject(TreeState);
  protected readonly api = inject(ApiActions);
  protected readonly drag = inject(ApiTreeDrag);

  readonly collections = input.required<ApiCollection[]>();
  readonly requests = input.required<ApiRequest[]>();
  /** The latest run of each collection, by id, for the result after its name. */
  readonly lastRuns = input<ReadonlyMap<string, ApiRun>>(new Map());
  readonly parentId = input<string | null>(null);
  readonly depth = input(0);
  readonly filter = input('');

  protected readonly icons = { ChevronDown, ChevronRight, Ellipsis, Settings2 };
  protected readonly methodColors = METHOD_COLORS;
  private readonly filtering = computed(() => this.filter().trim().length > 0);
  private readonly kept = computed(() => (this.filtering() ? collectionsWithMatches(this.collections(), this.requests(), this.filter()) : null));
  protected readonly children = computed(() => {
    const kept = this.kept();
    return this.collections().filter((c) => (c.parentId ?? null) === this.parentId() && (!kept || kept.has(c.id)));
  });
  protected readonly items = computed(() =>
    this.requests()
      .filter((r) => (r.collectionId ?? null) === this.parentId() && (!this.filtering() || matchesRequest(r, this.filter())))
      .sort(compareRequests),
  );
  /** The request whose tab is on screen, highlighted in the tree. */
  protected readonly activeRequestId = computed(() => {
    const { tabs, activeTabId } = this.tabs.scope(this.app.scope());
    const active = tabs.find((t) => t.id === activeTabId);
    return active?.type === 'api.request' ? active.data?.['id'] : undefined;
  });
  protected readonly dropTarget = computed(() => this.drag.dnd.drag()?.target ?? null);
  protected readonly dragging = computed(() => this.drag.dnd.drag()?.id ?? null);

  /** A filtered tree shows every collection that holds a match open, without changing what is saved. */
  protected isOpen(collection: ApiCollection): boolean {
    return this.filtering() || this.tree.isExpanded(`api/collection/${collection.id}`, true);
  }

  protected toggle(collection: ApiCollection): void {
    if (this.drag.dnd.suppressClick() || this.filtering()) return;
    this.tree.toggle(`api/collection/${collection.id}`, true);
  }

  protected open(request: ApiRequest): void {
    if (this.drag.dnd.suppressClick()) return;
    this.api.openRequestTab(request);
  }

  protected requestMenu(event: MouseEvent, request: ApiRequest): void {
    this.api.requestMenu(event, request);
  }

  protected openSettings(event: MouseEvent, collection: ApiCollection): void {
    event.stopPropagation();
    this.api.openCollectionTab(collection);
  }

  protected openRun(event: MouseEvent, collection: ApiCollection): void {
    event.stopPropagation();
    this.api.openRunTab(collection);
  }

  protected collectionMenu(event: MouseEvent, collection: ApiCollection): void {
    this.api.collectionMenu(event, collection);
  }

  /** The first line of the request's description, as the row's tooltip. */
  protected summary(request: ApiRequest): string | null {
    return request.description?.trim().split('\n')[0] || null;
  }
}
