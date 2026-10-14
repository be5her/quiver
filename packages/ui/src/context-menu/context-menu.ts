import { Service, signal } from '@angular/core';

export type ContextMenuItem =
  | {
      label: string;
      select(): void;
      shortcut?: string;
      disabled?: boolean;
      danger?: boolean;
      /** Set (true or false) to make the item a checkbox, shown with a tick when true. */
      checked?: boolean;
      testId?: string;
    }
  | 'separator';

export interface OpenContextMenu {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

/** The themed right-click menu that replaces the browser's own. The shell's context menu host draws it. */
@Service()
export class ContextMenu {
  private readonly current = signal<OpenContextMenu | null>(null);

  readonly menu = this.current.asReadonly();

  /** Show the menu at the pointer. Call from a `(contextmenu)` handler. */
  open(event: MouseEvent, items: ContextMenuItem[]): void {
    event.preventDefault();
    event.stopPropagation();
    this.current.set({ x: event.clientX, y: event.clientY, items });
  }

  close(): void {
    this.current.set(null);
  }
}
