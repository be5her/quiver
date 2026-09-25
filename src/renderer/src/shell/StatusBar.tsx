import type { Environment } from '@quiver/core';
import { cn, invoke, selectActiveWorkspace, useAppStore, useInvoke } from '@quiver/ui';
import { Moon, Plug, Sun } from 'lucide-react';
import { openSettings, toggleTheme } from './actions';

export function StatusBar() {
  const workspace = useAppStore(selectActiveWorkspace);
  const mcp = useAppStore((s) => s.mcpStatus);
  const theme = useAppStore((s) => s.resolvedTheme);
  const secretsWarning = useAppStore((s) => s.config && !s.ready);
  void secretsWarning;

  return (
    <footer className="flex items-center h-6 px-2 gap-3 text-[11px] border-t border-edge bg-surface text-muted shrink-0 select-none">
      {workspace ? (
        <>
          <span className="truncate max-w-md font-mono" title={workspace.path}>
            {workspace.path}
          </span>
          <EnvironmentPicker />
        </>
      ) : (
        <span>No workspace</span>
      )}
      <div className="flex-1" />
      <button type="button" onClick={openSettings} className="flex items-center gap-1 hover:text-fg" title={mcp?.error ?? 'MCP server'}>
        <Plug className="size-3" />
        <span className={cn('size-1.5 rounded-full', mcp?.running ? 'bg-success' : 'bg-danger')} />
        MCP {mcp?.running ? `:${mcp.port}` : 'off'}
      </button>
      <button type="button" onClick={() => void toggleTheme()} className="hover:text-fg" title="Toggle theme">
        {theme === 'dark' ? <Sun className="size-3" /> : <Moon className="size-3" />}
      </button>
    </footer>
  );
}

function EnvironmentPicker() {
  const environments = useInvoke<Environment[]>('api.environment.list', {}, { refreshOn: ['environments'] });
  const active = useInvoke<{ id: string | null }>('api.environment.active', {}, { refreshOnState: ['api.activeEnvironment'] });
  const list = environments.data ?? [];
  return (
    <label className="flex items-center gap-1">
      <span>env</span>
      <select
        className="bg-transparent text-fg text-[11px] outline-none cursor-pointer max-w-40"
        value={active.data?.id ?? ''}
        onChange={(e) => void invoke('api.environment.setActive', { id: e.target.value || null })}
      >
        <option value="">none</option>
        {list.map((env) => (
          <option key={env.id} value={env.id}>
            {env.name}
          </option>
        ))}
      </select>
    </label>
  );
}
