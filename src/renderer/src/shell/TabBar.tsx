import { cn, openContextMenu, selectScope, selectScopeTabs, useAppStore, useTabsStore, type Tab } from '@quiver/ui';
import { X } from 'lucide-react';
import { useEffect, useRef, useState, type MouseEvent, type PointerEvent } from 'react';
import { closeTabs } from './actions';

/** The right-click menu of a tab, after VS Code's. */
function showTabMenu(e: MouseEvent, scope: string, tabs: Tab[], tab: Tab): void {
  const index = tabs.findIndex((t) => t.id === tab.id);
  const others = tabs.filter((t) => t.id !== tab.id).map((t) => t.id);
  const right = tabs.slice(index + 1).map((t) => t.id);
  const saved = tabs.filter((t) => !t.dirty).map((t) => t.id);
  // When the active tab goes away, land on the one that was right-clicked, as VS Code does.
  const keep = (ids: string[]) => () => {
    const activeClosing = ids.includes(useTabsStore.getState().scopes[scope]?.activeTabId ?? '');
    void closeTabs(scope, ids).then(() => {
      const current = useTabsStore.getState().scopes[scope];
      if (activeClosing && current?.tabs.some((t) => t.id === tab.id)) useTabsStore.getState().setActiveTab(scope, tab.id);
    });
  };
  openContextMenu(e, [
    { label: 'Close', shortcut: 'Ctrl+W', onSelect: () => void closeTabs(scope, [tab.id]), testId: 'tab-menu-close' },
    { label: 'Close Others', onSelect: keep(others), disabled: others.length === 0, testId: 'tab-menu-close-others' },
    { label: 'Close to the Right', onSelect: keep(right), disabled: right.length === 0, testId: 'tab-menu-close-right' },
    { label: 'Close Saved', onSelect: keep(saved), disabled: saved.length === 0, testId: 'tab-menu-close-saved' },
    { label: 'Close All', onSelect: () => void closeTabs(scope, tabs.map((t) => t.id)), testId: 'tab-menu-close-all' },
  ]);
}

/** Pixels the pointer must travel before a press on a tab becomes a drag. */
const DRAG_THRESHOLD = 5;

interface Drag {
  id: string;
  startX: number;
  moving: boolean;
  /** Index the tab would take among the others if dropped now. */
  slot: number;
  /** Where the drop marker is drawn, in the strip's scrolled coordinates. */
  markerX: number;
}

/**
 * Drag a tab along the strip to reorder it. Pointer events rather than HTML drag and drop, so
 * the marker follows the pointer and the strip scrolls when the pointer nears either end.
 */
function useTabDrag(scope: string) {
  const stripRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  // The click that ends a drag must not also activate whatever it lands on.
  const suppressClick = useRef(false);
  const cleanup = useRef<(() => void) | null>(null);

  useEffect(() => () => cleanup.current?.(), []);

  const update = (next: Drag | null) => {
    dragRef.current = next;
    setDrag(next);
  };

  const locate = (id: string, clientX: number): { slot: number; markerX: number } | null => {
    const strip = stripRef.current;
    if (!strip) return null;
    const others = [...strip.querySelectorAll<HTMLElement>('[data-testid=tab]')].filter((el) => el.dataset.tabId !== id);
    if (!others.length) return null;
    const rects = others.map((el) => el.getBoundingClientRect());
    let slot = rects.findIndex((r) => clientX < r.left + r.width / 2);
    if (slot < 0) slot = rects.length;
    const edge = slot < rects.length ? rects[slot].left : rects[rects.length - 1].right;
    return { slot, markerX: edge - strip.getBoundingClientRect().left + strip.scrollLeft };
  };

  const onPointerDown = (e: PointerEvent<HTMLElement>, id: string) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
    cleanup.current?.();
    dragRef.current = { id, startX: e.clientX, moving: false, slot: -1, markerX: 0 };

    const move = (ev: globalThis.PointerEvent) => {
      const current = dragRef.current;
      if (!current) return;
      if (!current.moving && Math.abs(ev.clientX - current.startX) < DRAG_THRESHOLD) return;
      const strip = stripRef.current;
      if (strip) {
        const r = strip.getBoundingClientRect();
        if (ev.clientX < r.left + 24) strip.scrollLeft -= 12;
        else if (ev.clientX > r.right - 24) strip.scrollLeft += 12;
      }
      const spot = locate(current.id, ev.clientX);
      if (spot) update({ ...current, moving: true, ...spot });
    };
    const finish = (commit: boolean) => {
      const current = dragRef.current;
      cleanup.current?.();
      update(null);
      if (!current?.moving) return;
      suppressClick.current = true;
      setTimeout(() => (suppressClick.current = false), 0);
      if (!commit) return;
      const store = useTabsStore.getState();
      store.moveTab(scope, current.id, current.slot);
      store.setActiveTab(scope, current.id);
    };
    const up = () => finish(true);
    const key = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape' || !dragRef.current?.moving) return;
      ev.stopPropagation();
      finish(false);
    };
    const blur = () => finish(false);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', blur);
    window.addEventListener('keydown', key, true);
    window.addEventListener('blur', blur);
    cleanup.current = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', blur);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('blur', blur);
      cleanup.current = null;
      dragRef.current = null;
    };
  };

  return { stripRef, drag: drag?.moving ? drag : null, onPointerDown, suppressClick };
}

export function TabBar() {
  const scope = useAppStore(selectScope);
  const { tabs, activeTabId } = useTabsStore(selectScopeTabs(scope));
  const setActiveTab = useTabsStore((s) => s.setActiveTab);
  const closeTab = useTabsStore((s) => s.closeTab);
  const closeOthers = useTabsStore((s) => s.closeOthers);
  const { stripRef, drag, onPointerDown, suppressClick } = useTabDrag(scope);

  // Tabs keep a readable width and the strip scrolls, so bring the active one into view.
  useEffect(() => {
    if (!activeTabId) return;
    stripRef.current?.querySelector<HTMLElement>(`[data-tab-id="${activeTabId}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeTabId, tabs.length, stripRef]);

  if (!tabs.length) return null;

  return (
    <div
      ref={stripRef}
      className={cn('relative flex items-stretch h-9 border-b border-edge bg-surface overflow-x-auto overflow-y-hidden shrink-0 no-scrollbar', drag && 'cursor-grabbing')}
      // The strip has no scrollbar (it would squeeze the tabs); the wheel scrolls it sideways.
      onWheel={(e) => {
        if (e.deltaY && !e.deltaX) e.currentTarget.scrollLeft += e.deltaY;
      }}
      role="tablist"
      data-dragging={drag ? drag.id : undefined}
    >
      {drag && <div className="absolute top-1 bottom-1 w-0.5 -ml-px rounded-full bg-accent pointer-events-none z-10" style={{ left: drag.markerX }} data-testid="tab-drop-marker" />}
      {tabs.map((tab) => {
        const active = tab.id === activeTabId;
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={active}
            tabIndex={0}
            onPointerDown={(e) => onPointerDown(e, tab.id)}
            onClick={() => !suppressClick.current && setActiveTab(scope, tab.id)}
            onKeyDown={(e) => e.key === 'Enter' && setActiveTab(scope, tab.id)}
            onAuxClick={(e) => e.button === 1 && closeTab(scope, tab.id)}
            onDoubleClick={(e) => e.altKey && closeOthers(scope, tab.id)}
            onContextMenu={(e) => showTabMenu(e, scope, tabs, tab)}
            className={cn(
              'group flex items-center gap-2 pl-3 pr-1.5 max-w-52 min-w-24 shrink-0 border-r border-edge text-xs cursor-pointer select-none',
              active ? 'bg-canvas text-fg shadow-[inset_0_2px_0_var(--accent)]' : 'text-muted hover:text-fg hover:bg-elevated/50',
              drag?.id === tab.id && 'opacity-50',
              drag && 'cursor-grabbing',
            )}
            title={tab.title}
            data-testid="tab"
            data-title={tab.title}
            data-tab-id={tab.id}
          >
            <span className="truncate flex-1">{tab.title}</span>
            {tab.dirty && !active && <span className="size-1.5 rounded-full bg-warning shrink-0" />}
            <button
              type="button"
              aria-label="Close tab"
              onClick={(e) => {
                e.stopPropagation();
                closeTab(scope, tab.id);
              }}
              className={cn('rounded p-0.5 hover:bg-elevated text-muted hover:text-fg shrink-0', active ? '' : 'opacity-0 group-hover:opacity-100')}
            >
              {tab.dirty && active ? <span className="block size-1.5 m-0.5 rounded-full bg-warning group-hover:hidden" /> : null}
              <X className={cn('size-3', tab.dirty && active && 'hidden group-hover:block')} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
