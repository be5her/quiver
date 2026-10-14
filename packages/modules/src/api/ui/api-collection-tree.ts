import { Component, computed, inject, input } from '@angular/core';
import type { ApiCollection, ApiRequest } from '@quiver/core';
import { AppState, Icon, IconButton, METHOD_COLORS, TabsState, Toasts, TreeState } from '@quiver/ui';
import { ChevronDown, ChevronRight, Copy, FolderPlus, Pencil, Plus, Trash2 } from 'lucide';
import { ApiActions } from './api-actions';
import { ApiRow } from './api-row';

/** The collections and requests under one parent, collections first; collections nest the same way. */
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
  private readonly toasts = inject(Toasts);
  protected readonly api = inject(ApiActions);

  readonly collections = input.required<ApiCollection[]>();
  readonly requests = input.required<ApiRequest[]>();
  readonly parentId = input<string | null>(null);
  readonly depth = input(0);

  protected readonly icons = { ChevronDown, ChevronRight, Copy, FolderPlus, Pencil, Plus, Trash2 };
  protected readonly methodColors = METHOD_COLORS;
  protected readonly children = computed(() => this.collections().filter((c) => (c.parentId ?? null) === this.parentId()));
  protected readonly items = computed(() => this.requests().filter((r) => (r.collectionId ?? null) === this.parentId()));
  /** The request whose tab is on screen, highlighted in the tree. */
  protected readonly activeRequestId = computed(() => {
    const { tabs, activeTabId } = this.tabs.scope(this.app.scope());
    const active = tabs.find((t) => t.id === activeTabId);
    return active?.type === 'api.request' ? active.data?.['id'] : undefined;
  });

  protected isOpen(collection: ApiCollection): boolean {
    return this.tree.isExpanded(`api/collection/${collection.id}`, true);
  }

  protected toggle(collection: ApiCollection): void {
    this.tree.toggle(`api/collection/${collection.id}`, true);
  }

  protected newRequestIn(event: MouseEvent, collection: ApiCollection): void {
    this.act(event, this.api.createRequest(collection.id));
  }

  protected newCollectionIn(event: MouseEvent, collection: ApiCollection): void {
    this.act(event, this.api.newCollection(collection.id));
  }

  protected renameCollection(event: MouseEvent, collection: ApiCollection): void {
    this.act(event, this.api.renameCollection(collection));
  }

  protected deleteCollection(event: MouseEvent, collection: ApiCollection): void {
    this.act(event, this.api.deleteCollection(collection));
  }

  protected renameRequest(event: MouseEvent, request: ApiRequest): void {
    this.act(event, this.api.renameRequest(request));
  }

  protected duplicateRequest(event: MouseEvent, request: ApiRequest): void {
    this.act(event, this.api.duplicateRequest(request));
  }

  protected deleteRequest(event: MouseEvent, request: ApiRequest): void {
    this.act(event, this.api.deleteRequest(request));
  }

  /** Row actions keep the click off the row and report a failure. */
  private act(event: MouseEvent, action: Promise<unknown>): void {
    event.stopPropagation();
    action.catch((err) => this.toasts.error(err));
  }
}
