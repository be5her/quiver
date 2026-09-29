import { IconButton, Kbd, cn, openContextMenu, useAppStore, useTabsStore } from '@quiver/ui';
import type { WorkspaceInfo } from '@quiver/core';
import { FolderOpen, Search, Settings, X } from 'lucide-react';
import { useMemo, type MouseEvent } from 'react';
import { QuiverMark } from './Logo';
import { closeWorkspace, closeWorkspaces, copyText, openSettings, openWorkspace, revealWorkspace } from './actions';

const revealLabel = /Mac/i.test(navigator.userAgent) ? 'Reveal in Finder' : /Windows/i.test(navigator.userAgent) ? 'Reveal in File Explorer' : 'Open Containing Folder';

/** The right-click menu of a workspace in the title bar. */
function showWorkspaceMenu(e: MouseEvent, workspaces: WorkspaceInfo[], ws: WorkspaceInfo): void {
  const index = workspaces.findIndex((w) => w.id === ws.id);
  const others = workspaces.filter((w) => w.id !== ws.id).map((w) => w.id);
  const right = workspaces.slice(index + 1).map((w) => w.id);
  openContextMenu(e, [
    { label: 'Close', onSelect: () => void closeWorkspace(ws.id), testId: 'workspace-menu-close' },
    { label: 'Close Others', onSelect: () => void closeWorkspaces(others), disabled: others.length === 0, testId: 'workspace-menu-close-others' },
    { label: 'Close to the Right', onSelect: () => void closeWorkspaces(right), disabled: right.length === 0, testId: 'workspace-menu-close-right' },
    { label: 'Close All', onSelect: () => void closeWorkspaces(workspaces.map((w) => w.id)), testId: 'workspace-menu-close-all' },
    'separator',
    { label: 'Copy Path', onSelect: () => copyText(ws.path, 'Path copied'), testId: 'workspace-menu-copy-path' },
    { label: revealLabel, onSelect: () => void revealWorkspace(ws.id), testId: 'workspace-menu-reveal' },
  ]);
}

export function TitleBar() {
  const workspaces = useAppStore((s) => s.workspaces);
  const activeId = useAppStore((s) => s.activeWorkspaceId);
  const setActive = useAppStore((s) => s.setActiveWorkspace);
  const setPalette = useAppStore((s) => s.setPaletteOpen);
  const scopes = useTabsStore((s) => s.scopes);
  const dirtyScopes = useMemo(
    () => Object.fromEntries(Object.entries(scopes).map(([k, v]) => [k, v.tabs.some((t) => t.dirty)])) as Record<string, boolean>,
    [scopes],
  );

  return (
    <header className="flex items-center h-10 px-2 gap-2 border-b border-edge bg-surface shrink-0 select-none">
      <div className="flex items-center gap-1.5 px-1.5 font-semibold text-sm tracking-tight">
        <QuiverMark className="size-5" />
        Quiver
      </div>

      <div className="flex items-center gap-1 ml-2 min-w-0 overflow-x-auto">
        {workspaces.map((ws, index) => (
          <div
            key={ws.id}
            role="tab"
            aria-selected={ws.id === activeId}
            tabIndex={0}
            onClick={() => setActive(ws.id)}
            onKeyDown={(e) => e.key === 'Enter' && setActive(ws.id)}
            onContextMenu={(e) => showWorkspaceMenu(e, workspaces, ws)}
            data-testid="workspace-tab"
            data-name={ws.name}
            title={`${ws.path}\nCtrl+${index + 1}`}
            className={cn(
              'group flex items-center gap-1.5 h-7 pl-2.5 pr-1 rounded-md text-xs cursor-pointer border',
              ws.id === activeId ? 'bg-canvas border-edge text-fg' : 'border-transparent text-muted hover:text-fg hover:bg-elevated',
            )}
          >
            <span className="truncate max-w-40">{ws.name}</span>
            {dirtyScopes[ws.id] && <span className="size-1.5 rounded-full bg-warning" title="Unsaved changes" />}
            <button
              type="button"
              aria-label={`Close ${ws.name}`}
              className="opacity-0 group-hover:opacity-100 rounded p-0.5 hover:bg-elevated text-muted hover:text-fg"
              onClick={(e) => {
                e.stopPropagation();
                void closeWorkspace(ws.id);
              }}
            >
              <X className="size-3" />
            </button>
          </div>
        ))}
        <IconButton label="Open folder (Ctrl+O)" size="sm" onClick={() => void openWorkspace()}>
          <FolderOpen className="size-4" />
        </IconButton>
      </div>

      <div className="flex-1" />

      <button
        type="button"
        onClick={() => setPalette(true)}
        className="flex items-center gap-2 h-7 px-2.5 rounded-md border border-edge bg-canvas text-xs text-muted hover:text-fg w-64"
      >
        <Search className="size-3.5" />
        <span className="flex-1 text-left">Search commands…</span>
        <Kbd>Ctrl K</Kbd>
      </button>
      <IconButton label="Settings (Ctrl+,)" onClick={openSettings}>
        <Settings className="size-4" />
      </IconButton>
    </header>
  );
}
