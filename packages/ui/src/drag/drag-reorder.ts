import { DestroyRef, inject, signal, type Signal } from '@angular/core';

/** Pixels the pointer must travel before a press on an item becomes a drag. */
const DRAG_THRESHOLD = 5;

export type DragAxis = 'x' | 'y';

interface DragState {
  id: string;
  start: number;
  moving: boolean;
  /** Index the item would take among the others if dropped now. */
  slot: number;
  /** Where the drop marker is drawn, along the axis in the container's scrolled coordinates. */
  marker: number;
}

export interface DragReorder {
  /** The item being dragged and where it would land, once the pointer has moved far enough. */
  readonly drag: Signal<{ id: string; marker: number } | null>;
  /** Wire to each item's `(pointerdown)`; items carry `data-drag-id`. */
  pointerDown(event: PointerEvent, id: string): void;
  /** True for the click that ends a drag, which must not also act on the item. */
  suppressClick(): boolean;
}

/**
 * Drag items along a strip to reorder them: tabs, workspaces, the activity bar. Pointer events
 * rather than HTML drag and drop, so the marker follows the pointer and the strip scrolls when the
 * pointer nears either end. `move` gets the item and the index it should end up at.
 * Call in an injection context; a drag in progress is dropped when that context is destroyed.
 */
export function dragReorder(axis: DragAxis, container: () => HTMLElement | undefined, move: (id: string, to: number) => void): DragReorder {
  const drag = signal<{ id: string; marker: number } | null>(null);
  let state: DragState | null = null;
  let suppress = false;
  let cleanup: (() => void) | null = null;
  inject(DestroyRef).onDestroy(() => cleanup?.());

  const pos = (e: { clientX: number; clientY: number }) => (axis === 'x' ? e.clientX : e.clientY);

  const locate = (id: string, at: number): { slot: number; marker: number } | null => {
    const strip = container();
    if (!strip) return null;
    const others = [...strip.querySelectorAll<HTMLElement>('[data-drag-id]')].filter((el) => el.dataset['dragId'] !== id);
    if (!others.length) return null;
    const rects = others.map((el) => el.getBoundingClientRect());
    const lo = (r: DOMRect) => (axis === 'x' ? r.left : r.top);
    const hi = (r: DOMRect) => (axis === 'x' ? r.right : r.bottom);
    let slot = rects.findIndex((r) => at < (lo(r) + hi(r)) / 2);
    if (slot < 0) slot = rects.length;
    const edge = slot < rects.length ? lo(rects[slot]) : hi(rects[rects.length - 1]);
    const box = strip.getBoundingClientRect();
    return { slot, marker: axis === 'x' ? edge - box.left + strip.scrollLeft : edge - box.top + strip.scrollTop };
  };

  const pointerDown = (event: PointerEvent, id: string) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('button:not([data-drag-id])')) return;
    cleanup?.();
    state = { id, start: pos(event), moving: false, slot: -1, marker: 0 };

    const onMove = (ev: PointerEvent) => {
      const current = state;
      if (!current) return;
      const at = pos(ev);
      if (!current.moving && Math.abs(at - current.start) < DRAG_THRESHOLD) return;
      const strip = container();
      if (strip) {
        const r = strip.getBoundingClientRect();
        const [lo, hi] = axis === 'x' ? [r.left, r.right] : [r.top, r.bottom];
        const step = at < lo + 24 ? -12 : at > hi - 24 ? 12 : 0;
        if (axis === 'x') strip.scrollLeft += step;
        else strip.scrollTop += step;
      }
      const spot = locate(current.id, at);
      if (spot) {
        state = { ...current, moving: true, ...spot };
        drag.set({ id: current.id, marker: spot.marker });
      }
    };
    const finish = (commit: boolean) => {
      const current = state;
      cleanup?.();
      drag.set(null);
      if (!current?.moving) return;
      suppress = true;
      setTimeout(() => (suppress = false), 0);
      if (commit) move(current.id, current.slot);
    };
    const onUp = () => finish(true);
    const onCancel = () => finish(false);
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape' || !state?.moving) return;
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
      state = null;
    };
  };

  return { drag: drag.asReadonly(), pointerDown, suppressClick: () => suppress };
}
