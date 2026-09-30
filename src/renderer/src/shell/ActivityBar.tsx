import { arrangeActivityBar, defaultActivityBarLayout, moveInActivityBar, toErrorPayload, toggleInActivityBar, type ActivityBarLayout } from '@quiver/core';
import { cn, invoke, notify, openContextMenu, selectActiveModule, useAppStore, type ContextMenuItem } from '@quiver/ui';
import type { MouseEvent } from 'react';
import { modules } from './modules';
import { DropMarker, useDragReorder } from './useDragReorder';

const moduleIds = modules.map((m) => m.id);

/** Save the arrangement in global config, applying it at once so the bar does not wait for the host. */
function saveLayout(activityBar: ActivityBarLayout): void {
  const { config, setConfig } = useAppStore.getState();
  if (config) setConfig({ ...config, activityBar });
  invoke('config.update', { patch: { activityBar } }, null).catch((err) => notify(toErrorPayload(err).message, 'error'));
}

/** Hide or show a module; hiding the one on screen moves to the first module still shown. */
function setShown(layout: ActivityBarLayout, id: string, show: boolean): void {
  const next = toggleInActivityBar(moduleIds, layout, id, show);
  saveLayout(next);
  const state = useAppStore.getState();
  if (!show && selectActiveModule(state) === id) {
    const hasWorkspace = state.activeWorkspaceId !== null;
    const fallback = arrangeActivityBar(moduleIds, next).visible.find((m) => hasWorkspace || modules.find((mod) => mod.id === m)?.availability === 'always');
    if (fallback) state.setActiveModule(fallback);
  }
}

/** VS Code's activity bar menu: hide the clicked module, tick modules on and off, reset. */
function showActivityMenu(e: MouseEvent, layout: ActivityBarLayout, clicked?: string): void {
  const { all, visible } = arrangeActivityBar(moduleIds, layout);
  const title = (id: string) => modules.find((m) => m.id === id)?.title ?? id;
  const items: ContextMenuItem[] = [];
  if (clicked) {
    items.push({ label: `Hide '${title(clicked)}'`, onSelect: () => setShown(layout, clicked, false), disabled: visible.length <= 1, testId: 'activity-menu-hide' }, 'separator');
  }
  for (const id of all) {
    const shown = visible.includes(id);
    items.push({
      label: title(id),
      checked: shown,
      // The last module shown cannot be unticked.
      disabled: shown && visible.length <= 1,
      onSelect: () => setShown(layout, id, !shown),
      testId: `activity-menu-${id}`,
    });
  }
  const isDefault = JSON.stringify(all) === JSON.stringify(moduleIds) && visible.length === all.length;
  items.push('separator', { label: 'Reset Order and Visibility', onSelect: () => saveLayout(defaultActivityBarLayout()), disabled: isDefault, testId: 'activity-menu-reset' });
  openContextMenu(e, items);
}

export function ActivityBar() {
  const activeModule = useAppStore(selectActiveModule);
  const hasWorkspace = useAppStore((s) => s.activeWorkspaceId !== null);
  const setActiveModule = useAppStore((s) => s.setActiveModule);
  const layout = useAppStore((s) => s.config?.activityBar) ?? defaultActivityBarLayout();
  const { visible } = arrangeActivityBar(moduleIds, layout);
  const { containerRef, drag, onPointerDown, suppressClick } = useDragReorder<HTMLElement>('y', (id, to) => saveLayout(moveInActivityBar(moduleIds, layout, id, to)));

  return (
    <nav
      ref={containerRef}
      className="relative flex flex-col items-center w-12 py-1.5 gap-1 border-r border-edge bg-surface shrink-0 overflow-y-auto no-scrollbar"
      onContextMenu={(e) => showActivityMenu(e, layout)}
      data-testid="activity-bar"
    >
      {drag && <DropMarker axis="y" at={drag.marker} testId="activity-drop-marker" />}
      {visible.map((id) => {
        const mod = modules.find((m) => m.id === id)!;
        const enabled = mod.availability === 'always' || hasWorkspace;
        const active = mod.id === activeModule;
        return (
          <button
            key={mod.id}
            type="button"
            title={enabled ? mod.title : `${mod.title} (open a workspace first)`}
            aria-disabled={!enabled}
            onPointerDown={(e) => onPointerDown(e, mod.id)}
            onClick={() => enabled && !suppressClick.current && setActiveModule(mod.id)}
            onContextMenu={(e) => showActivityMenu(e, layout, mod.id)}
            className={cn(
              'relative flex items-center justify-center size-9 shrink-0 rounded-md transition-colors',
              active ? 'text-fg bg-elevated' : 'text-muted hover:text-fg hover:bg-elevated/60',
              !enabled && 'opacity-35 cursor-default hover:bg-transparent hover:text-muted',
              drag?.id === mod.id && 'opacity-50',
            )}
            data-testid="activity-item"
            data-drag-id={mod.id}
            data-active={active || undefined}
          >
            {active && <span className="absolute left-0 top-2 bottom-2 w-0.5 rounded-r bg-accent" />}
            <mod.icon className="size-[18px]" strokeWidth={1.75} />
          </button>
        );
      })}
    </nav>
  );
}
