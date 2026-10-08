import { Component, ElementRef, afterRenderEffect, computed, inject, untracked, viewChild } from '@angular/core';
import { AppState, ContextMenu, Icon, TabsState, type Tab } from '@quiver/ui';
import { X } from 'lucide';
import { DropMarker } from '../drop-marker';
import { dragReorder } from '../drag-reorder';
import { ShellActions } from '../shell-actions';

/** The open tabs of the current scope: drag to reorder, middle-click or Ctrl+W to close, right-click for more. */
@Component({
  selector: 'q-tab-bar',
  imports: [DropMarker, Icon],
  templateUrl: './tab-bar.html',
  host: { class: 'contents' },
})
export class TabBar {
  private readonly app = inject(AppState);
  private readonly tabsState = inject(TabsState);
  private readonly contextMenu = inject(ContextMenu);
  private readonly shell = inject(ShellActions);
  private readonly strip = viewChild<ElementRef<HTMLDivElement>>('strip');

  protected readonly closeIcon = X;
  protected readonly scope = this.app.scope;
  protected readonly current = computed(() => this.tabsState.scope(this.scope()));
  protected readonly reorder = dragReorder(
    'x',
    () => this.strip()?.nativeElement,
    (id, to) => {
      const scope = untracked(this.scope);
      this.tabsState.moveTab(scope, id, to);
      this.tabsState.setActiveTab(scope, id);
    },
  );

  /** Changes when another tab becomes active or the number of tabs changes, not on every tab update. */
  private readonly activeSpot = computed(() => {
    const { activeTabId, tabs } = this.current();
    return activeTabId ? `${activeTabId}:${tabs.length}` : null;
  });

  constructor() {
    // Tabs keep a readable width and the strip scrolls, so bring the active one into view.
    afterRenderEffect({
      write: () => {
        const spot = this.activeSpot();
        if (!spot) return;
        const activeTabId = spot.slice(0, spot.lastIndexOf(':'));
        this.strip()?.nativeElement.querySelector<HTMLElement>(`[data-drag-id="${activeTabId}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      },
    });
  }

  protected activate(tab: Tab): void {
    if (!this.reorder.suppressClick()) this.tabsState.setActiveTab(untracked(this.scope), tab.id);
  }

  protected close(event: MouseEvent, tab: Tab): void {
    event.stopPropagation();
    this.tabsState.closeTab(untracked(this.scope), tab.id);
  }

  /** The middle button would start the browser's autoscroll on the scrollable strip instead of reaching `auxclick`. */
  protected mouseDown(event: MouseEvent): void {
    if (event.button === 1) event.preventDefault();
  }

  protected auxClick(event: MouseEvent, tab: Tab): void {
    if (event.button === 1) this.tabsState.closeTab(untracked(this.scope), tab.id);
  }

  protected doubleClick(event: MouseEvent, tab: Tab): void {
    if (event.altKey) this.tabsState.closeOthers(untracked(this.scope), tab.id);
  }

  /** The strip has no scrollbar (it would squeeze the tabs); the wheel scrolls it sideways. */
  protected wheel(event: WheelEvent): void {
    if (event.deltaY && !event.deltaX) (event.currentTarget as HTMLElement).scrollLeft += event.deltaY;
  }

  /** The right-click menu of a tab, after VS Code's. */
  protected showMenu(event: MouseEvent, tab: Tab): void {
    const scope = untracked(this.scope);
    const { tabs } = untracked(this.current);
    const index = tabs.findIndex((t) => t.id === tab.id);
    const others = tabs.filter((t) => t.id !== tab.id).map((t) => t.id);
    const right = tabs.slice(index + 1).map((t) => t.id);
    const saved = tabs.filter((t) => !t.dirty).map((t) => t.id);
    // When the active tab goes away, land on the one that was right-clicked, as VS Code does.
    const keep = (ids: string[]) => () => {
      const activeClosing = ids.includes(untracked(() => this.tabsState.scope(scope)).activeTabId ?? '');
      void this.shell.closeTabs(scope, ids).then(() => {
        const after = untracked(() => this.tabsState.scope(scope));
        if (activeClosing && after.tabs.some((t) => t.id === tab.id)) this.tabsState.setActiveTab(scope, tab.id);
      });
    };
    this.contextMenu.open(event, [
      { label: 'Close', shortcut: 'Ctrl+W', select: () => void this.shell.closeTabs(scope, [tab.id]), testId: 'tab-menu-close' },
      { label: 'Close Others', select: keep(others), disabled: others.length === 0, testId: 'tab-menu-close-others' },
      { label: 'Close to the Right', select: keep(right), disabled: right.length === 0, testId: 'tab-menu-close-right' },
      { label: 'Close Saved', select: keep(saved), disabled: saved.length === 0, testId: 'tab-menu-close-saved' },
      { label: 'Close All', select: () => void this.shell.closeTabs(scope, tabs.map((t) => t.id)), testId: 'tab-menu-close-all' },
    ]);
  }
}
