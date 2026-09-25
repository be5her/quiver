import { cn, selectActiveModule, useAppStore } from '@quiver/ui';
import { modules } from './modules';

export function ActivityBar() {
  const activeModule = useAppStore(selectActiveModule);
  const hasWorkspace = useAppStore((s) => s.activeWorkspaceId !== null);
  const setActiveModule = useAppStore((s) => s.setActiveModule);

  return (
    <nav className="flex flex-col items-center w-12 py-1.5 gap-1 border-r border-edge bg-surface shrink-0">
      {modules.map((mod) => {
        const enabled = mod.availability === 'always' || hasWorkspace;
        const active = mod.id === activeModule;
        return (
          <button
            key={mod.id}
            type="button"
            title={enabled ? mod.title : `${mod.title} (open a workspace first)`}
            disabled={!enabled}
            onClick={() => setActiveModule(mod.id)}
            className={cn(
              'relative flex items-center justify-center size-9 rounded-md transition-colors',
              active ? 'text-fg bg-elevated' : 'text-muted hover:text-fg hover:bg-elevated/60',
              !enabled && 'opacity-35 pointer-events-none',
            )}
          >
            {active && <span className="absolute left-0 top-2 bottom-2 w-0.5 rounded-r bg-accent" />}
            <mod.icon className="size-[18px]" strokeWidth={1.75} />
          </button>
        );
      })}
    </nav>
  );
}
