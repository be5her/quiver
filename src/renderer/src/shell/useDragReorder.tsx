import { useEffect, useRef, useState, type PointerEvent, type RefObject } from 'react';

/** Pixels the pointer must travel before a press on an item becomes a drag. */
const DRAG_THRESHOLD = 5;

type Axis = 'x' | 'y';

interface DragState {
  id: string;
  start: number;
  moving: boolean;
  /** Index the item would take among the others if dropped now. */
  slot: number;
  /** Where the drop marker is drawn, along the axis in the container's scrolled coordinates. */
  marker: number;
}

export interface DragReorder<T extends HTMLElement> {
  containerRef: RefObject<T | null>;
  /** The item being dragged and where it would land, once the pointer has moved far enough. */
  drag: { id: string; marker: number } | null;
  /** Wire to each item's `onPointerDown`; items carry `data-drag-id`. */
  onPointerDown(e: PointerEvent<HTMLElement>, id: string): void;
  /** True for the click that ends a drag, which must not also act on the item. */
  suppressClick: RefObject<boolean>;
}

/**
 * Drag items along a strip to reorder them: tabs, workspaces, the activity bar. Pointer events
 * rather than HTML drag and drop, so the marker follows the pointer and the strip scrolls when the
 * pointer nears either end. `onMove` gets the item and the index it should end up at.
 */
export function useDragReorder<T extends HTMLElement>(axis: Axis, onMove: (id: string, to: number) => void): DragReorder<T> {
  const containerRef = useRef<T>(null);
  const dragRef = useRef<DragState | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const suppressClick = useRef(false);
  const cleanup = useRef<(() => void) | null>(null);
  const onMoveRef = useRef(onMove);
  onMoveRef.current = onMove;

  useEffect(() => () => cleanup.current?.(), []);

  const update = (next: DragState | null) => {
    dragRef.current = next;
    setDrag(next);
  };

  const pos = (e: { clientX: number; clientY: number }) => (axis === 'x' ? e.clientX : e.clientY);

  const locate = (id: string, at: number): { slot: number; marker: number } | null => {
    const container = containerRef.current;
    if (!container) return null;
    const others = [...container.querySelectorAll<HTMLElement>('[data-drag-id]')].filter((el) => el.dataset.dragId !== id);
    if (!others.length) return null;
    const rects = others.map((el) => el.getBoundingClientRect());
    const lo = (r: DOMRect) => (axis === 'x' ? r.left : r.top);
    const hi = (r: DOMRect) => (axis === 'x' ? r.right : r.bottom);
    let slot = rects.findIndex((r) => at < (lo(r) + hi(r)) / 2);
    if (slot < 0) slot = rects.length;
    const edge = slot < rects.length ? lo(rects[slot]) : hi(rects[rects.length - 1]);
    const box = container.getBoundingClientRect();
    return { slot, marker: axis === 'x' ? edge - box.left + container.scrollLeft : edge - box.top + container.scrollTop };
  };

  const onPointerDown = (e: PointerEvent<HTMLElement>, id: string) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button:not([data-drag-id])')) return;
    cleanup.current?.();
    dragRef.current = { id, start: pos(e), moving: false, slot: -1, marker: 0 };

    const move = (ev: globalThis.PointerEvent) => {
      const current = dragRef.current;
      if (!current) return;
      const at = pos(ev);
      if (!current.moving && Math.abs(at - current.start) < DRAG_THRESHOLD) return;
      const container = containerRef.current;
      if (container) {
        const r = container.getBoundingClientRect();
        const [lo, hi] = axis === 'x' ? [r.left, r.right] : [r.top, r.bottom];
        const step = at < lo + 24 ? -12 : at > hi - 24 ? 12 : 0;
        if (axis === 'x') container.scrollLeft += step;
        else container.scrollTop += step;
      }
      const spot = locate(current.id, at);
      if (spot) update({ ...current, moving: true, ...spot });
    };
    const finish = (commit: boolean) => {
      const current = dragRef.current;
      cleanup.current?.();
      update(null);
      if (!current?.moving) return;
      suppressClick.current = true;
      setTimeout(() => (suppressClick.current = false), 0);
      if (commit) onMoveRef.current(current.id, current.slot);
    };
    const up = () => finish(true);
    const cancel = () => finish(false);
    const key = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape' || !dragRef.current?.moving) return;
      ev.stopPropagation();
      finish(false);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', key, true);
    window.addEventListener('blur', cancel);
    cleanup.current = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('blur', cancel);
      cleanup.current = null;
      dragRef.current = null;
    };
  };

  return { containerRef, drag: drag?.moving ? { id: drag.id, marker: drag.marker } : null, onPointerDown, suppressClick };
}

/** The accent line showing where a dragged item will land. Its container must be `relative`. */
export function DropMarker({ axis, at, testId }: { axis: Axis; at: number; testId?: string }) {
  return (
    <div
      className={
        axis === 'x'
          ? 'absolute top-1 bottom-1 w-0.5 -ml-px rounded-full bg-accent pointer-events-none z-10'
          : 'absolute left-1.5 right-1.5 h-0.5 -mt-px rounded-full bg-accent pointer-events-none z-10'
      }
      style={axis === 'x' ? { left: at } : { top: at }}
      data-testid={testId}
    />
  );
}
