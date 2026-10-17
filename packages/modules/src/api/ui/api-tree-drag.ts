import { Injectable, computed, inject, signal } from '@angular/core';
import { canMoveCollection, type ApiCollection, type ApiRequest } from '@quiver/core';
import { Toasts, dragInto } from '@quiver/ui';
import { ApiActions } from './api-actions';

/** Drop target for the top level of the tree. */
export const ROOT_TARGET = 'root';

/**
 * Dragging requests and collections in the API sidebar onto a collection, or the top level. One per
 * sidebar, shared by the nested trees. Items are `request:<id>` or `collection:<id>`.
 */
@Injectable()
export class ApiTreeDrag {
  private readonly api = inject(ApiActions);
  private readonly toasts = inject(Toasts);

  readonly collections = signal<ApiCollection[]>([]);
  readonly requests = signal<ApiRequest[]>([]);

  readonly dnd = dragInto({
    canDrop: (item, target) => this.canDrop(item, target),
    drop: (item, target) => {
      const parent = target === ROOT_TARGET ? null : target;
      const [kind, id] = split(item);
      const action = kind === 'request' ? this.api.moveRequest({ id, name: '' }, parent) : this.api.moveCollection({ id }, parent);
      action.catch((err) => this.toasts.error(err));
    },
  });

  /** The collection (or top level) the dragged item would land in, by name, for the label by the pointer. */
  readonly targetName = computed(() => {
    const target = this.dnd.drag()?.target;
    if (target == null) return null;
    return target === ROOT_TARGET ? 'top level' : (this.collections().find((c) => c.id === target)?.name ?? null);
  });

  private canDrop(item: string, target: string): boolean {
    const parent = target === ROOT_TARGET ? null : target;
    const [kind, id] = split(item);
    if (kind === 'request') {
      const request = this.requests().find((r) => r.id === id);
      return Boolean(request) && (request!.collectionId ?? null) !== parent;
    }
    const collection = this.collections().find((c) => c.id === id);
    return Boolean(collection) && (collection!.parentId ?? null) !== parent && canMoveCollection(this.collections(), id, parent);
  }
}

function split(item: string): ['request' | 'collection', string] {
  const at = item.indexOf(':');
  return [item.slice(0, at) as 'request' | 'collection', item.slice(at + 1)];
}
