import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { Check } from 'lucide-react';
import { create } from 'zustand';
import { cn } from '../cn';

export type ContextMenuItem =
  | {
      label: string;
      onSelect(): void;
      shortcut?: string;
      disabled?: boolean;
      danger?: boolean;
      /** Set (true or false) to make the item a checkbox, shown with a tick when true. */
      checked?: boolean;
      testId?: string;
    }
  | 'separator';

interface ContextMenuState {
  menu: { x: number; y: number; items: ContextMenuItem[] } | null;
  open(x: number, y: number, items: ContextMenuItem[]): void;
  close(): void;
}

export const useContextMenuStore = create<ContextMenuState>((set) => ({
  menu: null,
  open: (x, y, items) => set({ menu: { x, y, items } }),
  close: () => set({ menu: null }),
}));

/** Show a themed menu at the pointer, replacing the browser's own. Use from `onContextMenu`. */
export function openContextMenu(event: ReactMouseEvent | MouseEvent, items: ContextMenuItem[]): void {
  event.preventDefault();
  event.stopPropagation();
  useContextMenuStore.getState().open(event.clientX, event.clientY, items);
}

/** Renders the open context menu. Mount once in the shell. */
export function ContextMenuHost() {
  const menu = useContextMenuStore((s) => s.menu);
  const close = useContextMenuStore((s) => s.close);
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  // Keep the menu inside the window: flip left or up when it would overflow.
  useLayoutEffect(() => {
    if (!menu || !ref.current) return setPosition(null);
    const { width, height } = ref.current.getBoundingClientRect();
    const left = menu.x + width > window.innerWidth - 4 ? Math.max(4, menu.x - width) : menu.x;
    const top = menu.y + height > window.innerHeight - 4 ? Math.max(4, menu.y - height) : menu.y;
    setPosition({ left, top });
    ref.current.focus();
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    document.addEventListener('mousedown', onDown, true);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    document.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
      document.removeEventListener('scroll', close, true);
    };
  }, [menu, close]);

  if (!menu) return null;
  // Menus with checkbox items keep a gutter for the tick on every row, so labels line up.
  const gutter = menu.items.some((item) => item !== 'separator' && item.checked !== undefined);

  const onKeyDown = (e: KeyboardEvent) => {
    const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>('[role^=menuitem]:not(:disabled)') ?? [])];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowDown') items[(index + 1) % items.length]?.focus();
    else if (e.key === 'ArrowUp') items[(index - 1 + items.length) % items.length]?.focus();
    else if (e.key === 'Home') items[0]?.focus();
    else if (e.key === 'End') items[items.length - 1]?.focus();
    else return;
    e.preventDefault();
  };

  return (
    <div
      ref={ref}
      role="menu"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
      style={position ?? { left: menu.x, top: menu.y, visibility: 'hidden' }}
      className="fixed z-50 min-w-52 max-w-80 rounded-md border border-edge bg-elevated shadow-lg py-1 text-xs select-none outline-none"
      data-testid="context-menu"
    >
      {menu.items.map((item, index) =>
        item === 'separator' ? (
          <div key={`sep-${index}`} role="separator" className="my-1 h-px bg-edge" />
        ) : (
          <button
            key={item.label}
            type="button"
            role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
            aria-checked={item.checked}
            disabled={item.disabled}
            onClick={() => {
              close();
              item.onSelect();
            }}
            className={cn(
              'w-full flex items-center gap-6 py-1.5 text-left outline-none hover:bg-surface focus-visible:bg-surface disabled:opacity-40 disabled:pointer-events-none',
              item.danger ? 'text-danger' : 'text-fg',
              gutter ? 'pl-1.5 pr-3' : 'px-3',
            )}
            data-testid={item.testId}
          >
            <span className="flex-1 flex items-center gap-1.5 min-w-0">
              {gutter && <span className="size-4 shrink-0 flex items-center justify-center">{item.checked && <Check className="size-3.5" />}</span>}
              <span className="truncate">{item.label}</span>
            </span>
            {item.shortcut && <span className="text-[11px] text-muted">{item.shortcut}</span>}
          </button>
        ),
      )}
    </div>
  );
}
