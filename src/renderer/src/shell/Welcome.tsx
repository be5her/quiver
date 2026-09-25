import type { RecentWorkspace } from '@quiver/core';
import { Button, Kbd, invoke, selectActiveWorkspace, useAppStore, useInvoke } from '@quiver/ui';
import { FolderOpen, X } from 'lucide-react';
import { openWorkspace } from './actions';
import { QuiverMark } from './Logo';

export function Welcome() {
  const active = useAppStore(selectActiveWorkspace);
  const recent = useInvoke<RecentWorkspace[]>('workspace.recent', {}, { workspaceId: null });
  const workspaces = useAppStore((s) => s.workspaces);
  const openPaths = new Set(workspaces.map((w) => w.path));

  return (
    <div className="flex-1 flex items-center justify-center p-8 overflow-auto">
      <div className="w-full max-w-xl">
        {active ? (
          <>
            <h1 className="text-xl font-semibold">{active.name}</h1>
            <p className="text-sm text-muted mt-1 font-mono break-all">{active.path}</p>
            <p className="text-sm text-muted mt-4">
              Pick a module on the left, or press <Kbd>Ctrl K</Kbd> to search every command. Requests, environments and connections you create here
              are stored as JSON under <span className="font-mono">.quiver/</span> in this folder.
            </p>
          </>
        ) : (
          <>
            <div className="flex items-center gap-3">
              <QuiverMark className="size-10" />
              <h1 className="text-xl font-semibold">Open a project</h1>
            </div>
            <p className="text-sm text-muted mt-1">
              Each folder gets its own API requests, environments, database connections and mock servers. The small tools on the left work without one.
            </p>
            <div className="mt-4">
              <Button variant="primary" icon={<FolderOpen className="size-4" />} onClick={() => void openWorkspace()}>
                Open folder
              </Button>
              <span className="ml-3 text-xs text-muted">
                <Kbd>Ctrl O</Kbd>
              </span>
            </div>
          </>
        )}

        {(recent.data?.length ?? 0) > 0 && (
          <div className="mt-8">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted mb-2">Recent</h2>
            <ul className="flex flex-col gap-0.5">
              {recent.data!.map((r) => (
                <li key={r.path} className="group flex items-center gap-2">
                  <button
                    type="button"
                    disabled={openPaths.has(r.path)}
                    onClick={() => void openWorkspace(r.path)}
                    className="flex-1 text-left rounded-md px-2 py-1.5 hover:bg-elevated disabled:opacity-50 min-w-0"
                  >
                    <span className="text-sm">{r.name}</span>
                    <span className="ml-2 text-xs text-muted font-mono truncate">{r.path}</span>
                  </button>
                  <button
                    type="button"
                    aria-label="Remove from recent"
                    className="opacity-0 group-hover:opacity-100 text-muted hover:text-fg p-1"
                    onClick={() => void invoke('workspace.forgetRecent', { path: r.path }, null).then(recent.refresh)}
                  >
                    <X className="size-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
