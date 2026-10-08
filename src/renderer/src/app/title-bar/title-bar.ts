import { Component, ElementRef, computed, inject, untracked, viewChild } from '@angular/core';
import { moveItem, type WorkspaceInfo } from '@quiver/core';
import { AppState, ContextMenu, HostBridge, Icon, IconButton, Kbd, TabsState, Toasts } from '@quiver/ui';
import { FolderOpen, Search, Settings, X } from 'lucide';
import { DropMarker } from '../drop-marker';
import { dragReorder } from '../drag-reorder';
import { QuiverMark } from '../quiver-mark';
import { ShellActions } from '../shell-actions';

/** The logo, the open workspaces (drag to reorder, right-click for more), the palette and settings. */
@Component({
  selector: 'header[qTitleBar]',
  imports: [DropMarker, Icon, IconButton, Kbd, QuiverMark],
  templateUrl: './title-bar.html',
  host: { class: 'flex items-center h-10 px-2 gap-2 border-b border-edge bg-surface shrink-0 select-none' },
})
export class TitleBar {
  private readonly app = inject(AppState);
  private readonly host = inject(HostBridge);
  private readonly tabs = inject(TabsState);
  private readonly toasts = inject(Toasts);
  private readonly contextMenu = inject(ContextMenu);
  protected readonly shell = inject(ShellActions);
  private readonly strip = viewChild<ElementRef<HTMLDivElement>>('strip');

  protected readonly icons = { FolderOpen, Search, Settings, X };
  protected readonly workspaces = this.app.workspaces;
  protected readonly activeId = this.app.activeWorkspaceId;
  /** Workspaces with a tab that has unsaved changes. */
  protected readonly dirty = computed(() => {
    const scopes = this.tabs.scopes();
    return new Set(Object.entries(scopes).flatMap(([id, scope]) => (scope.tabs.some((t) => t.dirty) ? [id] : [])));
  });
  // Dropping a workspace reorders the title bar at once; the host keeps the order for the next start.
  protected readonly reorder = dragReorder(
    'x',
    () => this.strip()?.nativeElement,
    (id, to) => {
      const current = untracked(this.app.workspaces);
      const from = current.findIndex((w) => w.id === id);
      if (from < 0) return;
      const next = moveItem(current, from, to);
      this.app.setWorkspaces(next);
      this.app.activeWorkspaceId.set(id);
      this.host.invoke<WorkspaceInfo[]>('workspace.reorder', { ids: next.map((w) => w.id) }, null).catch((err) => this.toasts.error(err));
    },
  );
  private readonly revealLabel = /Mac/i.test(navigator.userAgent) ? 'Reveal in Finder' : /Windows/i.test(navigator.userAgent) ? 'Reveal in File Explorer' : 'Open Containing Folder';

  protected select(ws: WorkspaceInfo): void {
    if (!this.reorder.suppressClick()) this.app.activeWorkspaceId.set(ws.id);
  }

  protected close(event: MouseEvent, ws: WorkspaceInfo): void {
    event.stopPropagation();
    void this.shell.closeWorkspace(ws.id);
  }

  protected openPalette(): void {
    this.app.paletteOpen.set(true);
  }

  /** The right-click menu of a workspace. */
  protected showMenu(event: MouseEvent, ws: WorkspaceInfo): void {
    const workspaces = untracked(this.app.workspaces);
    const index = workspaces.findIndex((w) => w.id === ws.id);
    const others = workspaces.filter((w) => w.id !== ws.id).map((w) => w.id);
    const right = workspaces.slice(index + 1).map((w) => w.id);
    this.contextMenu.open(event, [
      { label: 'Close', select: () => void this.shell.closeWorkspace(ws.id), testId: 'workspace-menu-close' },
      { label: 'Close Others', select: () => void this.shell.closeWorkspaces(others), disabled: others.length === 0, testId: 'workspace-menu-close-others' },
      { label: 'Close to the Right', select: () => void this.shell.closeWorkspaces(right), disabled: right.length === 0, testId: 'workspace-menu-close-right' },
      { label: 'Close All', select: () => void this.shell.closeWorkspaces(workspaces.map((w) => w.id)), testId: 'workspace-menu-close-all' },
      'separator',
      { label: 'Copy Path', select: () => this.toasts.copy(ws.path, 'Path copied'), testId: 'workspace-menu-copy-path' },
      { label: this.revealLabel, select: () => void this.shell.revealWorkspace(ws.id), testId: 'workspace-menu-reveal' },
    ]);
  }
}
