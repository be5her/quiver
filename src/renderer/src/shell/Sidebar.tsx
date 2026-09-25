import { EmptyState, selectActiveModule, useAppStore } from '@quiver/ui';
import { moduleById } from './modules';

export function Sidebar() {
  const activeModule = useAppStore(selectActiveModule);
  const hasWorkspace = useAppStore((s) => s.activeWorkspaceId !== null);
  const mod = moduleById(activeModule);

  if (!mod) return null;
  const blocked = mod.availability === 'workspace' && !hasWorkspace;

  return (
    <aside className="flex flex-col w-[270px] border-r border-edge bg-surface shrink-0 min-h-0">
      <div className="flex items-center h-9 px-3 text-xs font-semibold uppercase tracking-wide text-muted border-b border-edge shrink-0">{mod.title}</div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {blocked ? <EmptyState title="No workspace open" hint="Open a project folder to use this module." /> : <mod.Sidebar key={mod.id} />}
      </div>
    </aside>
  );
}
