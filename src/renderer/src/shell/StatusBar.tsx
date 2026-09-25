import type { Environment } from '@quiver/core';
import { cn, invoke, selectActiveWorkspace, useAppStore, useInvoke } from '@quiver/ui';
import { Download, ExternalLink, Moon, Plug, RotateCw, Sun } from 'lucide-react';
import { openSettings, toggleTheme } from './actions';
import { downloadUpdate, installUpdate, openExternal } from './updates';

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
      <UpdateItem />
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

/** One entry that follows the updater: checking, a version to fetch, progress, or a restart to finish. */
function UpdateItem() {
  const update = useAppStore((s) => s.update);
  if (!update?.supported) return null;
  const button = 'flex items-center gap-1 text-accent hover:text-fg';
  switch (update.status) {
    case 'checking':
      return (
        <span className="flex items-center gap-1" data-testid="update-status">
          <RotateCw className="size-3 animate-spin" />
          Checking for updates…
        </span>
      );
    case 'available':
      return update.installable ? (
        <button type="button" onClick={() => void downloadUpdate()} className={button} title={`Download Quiver ${update.version}; it installs when you restart`} data-testid="update-status">
          <Download className="size-3" />
          Update to {update.version}
        </button>
      ) : (
        <button type="button" onClick={() => openExternal(update.url)} className={button} title={update.reason} data-testid="update-status">
          <ExternalLink className="size-3" />
          Quiver {update.version} available
        </button>
      );
    case 'downloading':
      return (
        <span className="flex items-center gap-1" data-testid="update-status">
          <Download className="size-3 animate-pulse" />
          Downloading {update.version}… {update.progress?.percent ?? 0}%
        </span>
      );
    case 'downloaded':
      return (
        <button type="button" onClick={() => void installUpdate()} className={cn(button, 'font-medium')} title={`Quiver ${update.version} is downloaded`} data-testid="update-status">
          <RotateCw className="size-3" />
          Restart to update
        </button>
      );
    default:
      return null;
  }
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
