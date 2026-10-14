import { Component, ElementRef, afterRenderEffect, computed, effect, inject, viewChild } from '@angular/core';
import { Check } from 'lucide';
import { Icon } from '../icon/icon';
import { ContextMenu, type ContextMenuItem } from './context-menu';

type MenuItem = Exclude<ContextMenuItem, 'separator'>;

/** Renders the open context menu. Mount once in the shell. */
@Component({
  selector: 'q-context-menu-host',
  imports: [Icon],
  templateUrl: './context-menu-host.html',
  host: { class: 'contents' },
})
export class ContextMenuHost {
  private readonly contextMenu = inject(ContextMenu);
  private readonly panel = viewChild<ElementRef<HTMLDivElement>>('panel');

  protected readonly menu = this.contextMenu.menu;
  protected readonly checkIcon = Check;
  /** Menus with checkbox items keep a gutter for the tick on every row, so labels line up. */
  protected readonly gutter = computed(() => this.menu()?.items.some((item) => item !== 'separator' && item.checked !== undefined) ?? false);

  constructor() {
    // Keep the menu inside the window: flip left or up when it would overflow.
    afterRenderEffect({
      write: () => {
        const menu = this.menu();
        const panel = this.panel()?.nativeElement;
        if (!menu || !panel) return;
        const { width, height } = panel.getBoundingClientRect();
        panel.style.left = `${menu.x + width > window.innerWidth - 4 ? Math.max(4, menu.x - width) : menu.x}px`;
        panel.style.top = `${menu.y + height > window.innerHeight - 4 ? Math.max(4, menu.y - height) : menu.y}px`;
        panel.style.visibility = 'visible';
        panel.focus();
      },
    });

    effect((onCleanup) => {
      if (!this.menu()) return;
      const close = () => this.contextMenu.close();
      const onDown = (e: MouseEvent) => {
        if (!this.panel()?.nativeElement.contains(e.target as Node)) close();
      };
      document.addEventListener('mousedown', onDown, true);
      window.addEventListener('blur', close);
      window.addEventListener('resize', close);
      document.addEventListener('scroll', close, true);
      onCleanup(() => {
        document.removeEventListener('mousedown', onDown, true);
        window.removeEventListener('blur', close);
        window.removeEventListener('resize', close);
        document.removeEventListener('scroll', close, true);
      });
    });
  }

  protected asItem(item: ContextMenuItem): MenuItem | null {
    return item === 'separator' ? null : item;
  }

  protected choose(item: MenuItem): void {
    this.contextMenu.close();
    item.select();
  }

  protected navigate(event: KeyboardEvent): void {
    const panel = this.panel()?.nativeElement;
    const items = [...(panel?.querySelectorAll<HTMLButtonElement>('[role^=menuitem]:not(:disabled)') ?? [])];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape') this.contextMenu.close();
    else if (event.key === 'ArrowDown') items[(index + 1) % items.length]?.focus();
    else if (event.key === 'ArrowUp') items[(index - 1 + items.length) % items.length]?.focus();
    else if (event.key === 'Home') items[0]?.focus();
    else if (event.key === 'End') items[items.length - 1]?.focus();
    else return;
    event.preventDefault();
  }
}
