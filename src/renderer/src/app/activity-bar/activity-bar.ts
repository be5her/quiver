import { Component, ElementRef, computed, inject, untracked, viewChild } from '@angular/core';
import { arrangeActivityBar, defaultActivityBarLayout, moveInActivityBar, toggleInActivityBar, type ActivityBarLayout } from '@quiver/core';
import { AppState, ContextMenu, HostBridge, Icon, Toasts, type ContextMenuItem, type ModuleUI } from '@quiver/ui';
import { DropMarker } from '../drop-marker';
import { dragReorder } from '../drag-reorder';
import { modules } from '../modules';

const moduleIds = modules.map((m) => m.id);

/** One icon per module. Yours to arrange: drag to reorder, right-click to hide or show modules. */
@Component({
  selector: 'nav[qActivityBar]',
  imports: [DropMarker, Icon],
  templateUrl: './activity-bar.html',
  host: {
    class: 'relative flex flex-col items-center w-12 py-1.5 gap-1 border-r border-edge bg-surface shrink-0 overflow-y-auto no-scrollbar',
    'data-testid': 'activity-bar',
    '(contextmenu)': 'showMenu($event)',
  },
})
export class ActivityBar {
  private readonly app = inject(AppState);
  private readonly host = inject(HostBridge);
  private readonly toasts = inject(Toasts);
  private readonly contextMenu = inject(ContextMenu);
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);

  protected readonly activeModule = this.app.activeModule;
  protected readonly hasWorkspace = this.app.hasWorkspace;
  private readonly layout = computed(() => this.app.config()?.activityBar ?? defaultActivityBarLayout());
  protected readonly visible = computed(() => arrangeActivityBar(moduleIds, this.layout()).visible.map((id) => modules.find((m) => m.id === id)!));
  protected readonly reorder = dragReorder(
    'y',
    () => this.element.nativeElement,
    (id, to) => this.saveLayout(moveInActivityBar(moduleIds, untracked(this.layout), id, to)),
  );

  protected enabled(mod: ModuleUI): boolean {
    return mod.availability === 'always' || this.hasWorkspace();
  }

  protected show(mod: ModuleUI): void {
    if (this.enabled(mod) && !this.reorder.suppressClick()) this.app.setActiveModule(mod.id);
  }

  /** VS Code's activity bar menu: hide the clicked module, tick modules on and off, reset. */
  protected showMenu(event: MouseEvent, clicked?: string): void {
    const layout = untracked(this.layout);
    const { all, visible } = arrangeActivityBar(moduleIds, layout);
    const title = (id: string) => modules.find((m) => m.id === id)?.title ?? id;
    const items: ContextMenuItem[] = [];
    if (clicked) {
      items.push({ label: `Hide '${title(clicked)}'`, select: () => this.setShown(clicked, false), disabled: visible.length <= 1, testId: 'activity-menu-hide' }, 'separator');
    }
    for (const id of all) {
      const shown = visible.includes(id);
      items.push({
        label: title(id),
        checked: shown,
        // The last module shown cannot be unticked.
        disabled: shown && visible.length <= 1,
        select: () => this.setShown(id, !shown),
        testId: `activity-menu-${id}`,
      });
    }
    const isDefault = JSON.stringify(all) === JSON.stringify(moduleIds) && visible.length === all.length;
    items.push('separator', { label: 'Reset Order and Visibility', select: () => this.saveLayout(defaultActivityBarLayout()), disabled: isDefault, testId: 'activity-menu-reset' });
    this.contextMenu.open(event, items);
  }

  /** Save the arrangement in global config, applying it at once so the bar does not wait for the host. */
  private saveLayout(activityBar: ActivityBarLayout): void {
    const config = untracked(this.app.config);
    if (config) this.app.config.set({ ...config, activityBar });
    this.host.invoke('config.update', { patch: { activityBar } }, null).catch((err) => this.toasts.error(err));
  }

  /** Hide or show a module; hiding the one on screen moves to the first module still shown. */
  private setShown(id: string, show: boolean): void {
    const next = toggleInActivityBar(moduleIds, untracked(this.layout), id, show);
    this.saveLayout(next);
    if (!show && untracked(this.app.activeModule) === id) {
      const hasWorkspace = untracked(this.app.hasWorkspace);
      const fallback = arrangeActivityBar(moduleIds, next).visible.find((m) => hasWorkspace || modules.find((mod) => mod.id === m)?.availability === 'always');
      if (fallback) this.app.setActiveModule(fallback);
    }
  }
}
