import { DestroyRef, inject, signal, type Signal } from '@angular/core';

/** Pixels the pointer must travel before a press on an item becomes a drag. */
const DRAG_THRESHOLD = 5;

export interface DragIntoState {
  /** The item being dragged. */
  id: string;
  /** What to show next to the pointer. */
  label: string;
  /** The drop target under the pointer that accepts the item, or null. */
  target: string | null;
  /** The pointer, in viewport coordinates, for a floating label. */
  x: number;
  y: number;
}

export interface DragInto {
  /** The drag in progress, once the pointer has moved far enough. */
  readonly drag: Signal<DragIntoState | null>;
  /** Wire to each draggable item's `(pointerdown)`. */
  pointerDown(event: PointerEvent, id: string, label: string): void;
  /** True for the click that ends a drag, which must not also act on the item. */
  suppressClick(): boolean;
}

export interface DragIntoOptions {
  /** Whether `id` may be dropped on `target` (a `data-drop-target` value). */
  canDrop(id: string, target: string): boolean;
  drop(id: string, target: string): void;
}

/**
 * Drag items onto drop targets: requests into collections, collections into each other. Targets are
 * elements carrying `data-drop-target`; the nearest one under the pointer that `canDrop` accepts is
 * the target. Pointer events rather than HTML drag and drop, as `dragReorder` uses, so it behaves the
 * same on every platform; Escape or leaving the window cancels. Call in an injection context.
 */
export function dragInto(options: DragIntoOptions): DragInto {
  const drag = signal<DragIntoState | null>(null);
  let suppress = false;
  let cleanup: (() => void) | null = null;
  inject(DestroyRef).onDestroy(() => cleanup?.());

  const targetAt = (id: string, x: number, y: number): string | null => {
    let el = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-drop-target]') ?? null;
    while (el) {
      const target = el.dataset['dropTarget'];
      if (target !== undefined && options.canDrop(id, target)) return target;
      el = el.parentElement?.closest<HTMLElement>('[data-drop-target]') ?? null;
    }
    return null;
  };

  const pointerDown = (event: PointerEvent, id: string, label: string) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return;
    cleanup?.();
    const start = { x: event.clientX, y: event.clientY };
    let moving = false;

    const onMove = (ev: PointerEvent) => {
      if (!moving && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < DRAG_THRESHOLD) return;
      if (!moving) {
        // Selected text under the pointer would start the browser's own drag, which cancels these events.
        window.getSelection()?.removeAllRanges();
        moving = true;
      }
      ev.preventDefault();
      drag.set({ id, label, target: targetAt(id, ev.clientX, ev.clientY), x: ev.clientX, y: ev.clientY });
    };
    const finish = (commit: boolean) => {
      const current = drag();
      cleanup?.();
      drag.set(null);
      if (!moving) return;
      suppress = true;
      setTimeout(() => (suppress = false), 0);
      if (commit && current?.target != null) options.drop(id, current.target);
    };
    const onUp = () => finish(true);
    const onCancel = () => finish(false);
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape' || !moving) return;
      ev.stopPropagation();
      finish(false);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onCancel);
    cleanup = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onCancel);
      cleanup = null;
    };
  };

  return { drag: drag.asReadonly(), pointerDown, suppressClick: () => suppress };
}
