import type { Environment, McpRecordingStatus } from '@quiver/core';
import { cn, invoke, runAction, selectActiveWorkspace, useAppStore, useInvoke } from '@quiver/ui';
import { Check, ChevronUp, Download, ExternalLink, Layers, Moon, Plug, RotateCw, Sun } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
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
      <RecordingItem />
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

/** Shown while the calls agents make to the MCP server are being recorded, so a running recording is never out of sight. */
function RecordingItem() {
  const recording = useInvoke<McpRecordingStatus>('mcp.recording.status', {}, { workspaceId: null, refreshOnEvents: ['mcp.recording'] }).data;
  if (recording?.state !== 'recording' && recording?.state !== 'paused') return null;
  const paused = recording.state === 'paused';
  return (
    <button
      type="button"
      onClick={() => runAction('mcp.recorder.open')}
      className="flex items-center gap-1 hover:text-fg"
      title={`${paused ? 'Recording of MCP calls is paused' : 'Recording MCP calls'}: ${recording.count} so far. Click to open the recorder.`}
      data-testid="mcp-recording-status"
    >
      <span className={cn('size-1.5 rounded-full', paused ? 'bg-warning' : 'bg-danger animate-pulse')} />
      REC {paused ? 'paused' : recording.count}
    </button>
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

/** The active API environment of the workspace, with a menu that opens above the bar (the native select popup ignores the theme). */
function EnvironmentPicker() {
  const environments = useInvoke<Environment[]>('api.environment.list', {}, { refreshOn: ['environments'] });
  const active = useInvoke<{ id: string | null }>('api.environment.active', {}, { refreshOnState: ['api.activeEnvironment'] });
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const list = environments.data ?? [];
  const activeId = active.data?.id ?? null;
  const current = list.find((env) => env.id === activeId);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onBlur = () => setOpen(false);
    document.addEventListener('mousedown', onDown);
    window.addEventListener('blur', onBlur);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('blur', onBlur);
    };
  }, [open]);

  const pick = (id: string | null) => {
    setOpen(false);
    if (id !== activeId) void invoke('api.environment.setActive', { id });
  };

  return (
    <div ref={ref} className="relative flex items-center">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn('flex items-center gap-1 h-5 px-1.5 -mx-0.5 rounded hover:bg-elevated hover:text-fg transition-colors', open && 'bg-elevated text-fg')}
        title={current ? `Environment: ${current.name}` : 'No environment selected'}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="env-picker"
      >
        <Layers className="size-3" />
        <span className={cn('truncate max-w-40', current && 'text-fg')}>{current?.name ?? 'No environment'}</span>
        <ChevronUp className={cn('size-3 transition-transform', open && 'rotate-180')} />
      </button>
      {open && <EnvironmentMenu list={list} activeId={activeId} onPick={pick} onClose={() => setOpen(false)} />}
    </div>
  );
}

function EnvironmentMenu({ list, activeId, onPick, onClose }: { list: Environment[]; activeId: string | null; onPick(id: string | null): void; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const options: { id: string | null; name: string }[] = [{ id: null, name: 'No environment' }, ...list.map((env) => ({ id: env.id, name: env.name }))];

  // Focus the active entry so the arrow keys pick up from there.
  useEffect(() => {
    const items = ref.current?.querySelectorAll<HTMLButtonElement>('[role=menuitemradio]');
    const index = Math.max(0, options.findIndex((o) => o.id === activeId));
    items?.[index]?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onKeyDown = (e: KeyboardEvent) => {
    const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>('[role=menuitemradio]') ?? [])];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') onClose();
    else if (e.key === 'ArrowDown') items[(index + 1) % items.length]?.focus();
    else if (e.key === 'ArrowUp') items[(index - 1 + items.length) % items.length]?.focus();
    else if (e.key === 'Home') items[0]?.focus();
    else if (e.key === 'End') items[items.length - 1]?.focus();
    else return;
    e.preventDefault();
  };

  return (
    <div
      ref={ref}
      role="menu"
      onKeyDown={onKeyDown}
      className="absolute left-0 bottom-full mb-1.5 z-30 min-w-48 max-w-72 rounded-md border border-edge bg-elevated shadow-lg py-1 select-none"
      data-testid="env-picker-menu"
    >
      <div className="px-3 pt-1 pb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted">Environment</div>
      {options.map((option) => {
        const selected = option.id === activeId;
        return (
          <button
            key={option.id ?? ''}
            type="button"
            role="menuitemradio"
            aria-checked={selected}
            onClick={() => onPick(option.id)}
            className={cn(
              'w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left outline-none hover:bg-surface focus-visible:bg-surface',
              option.id === null ? 'text-muted' : 'text-fg',
            )}
            data-testid="env-picker-option"
            data-env-id={option.id ?? ''}
          >
            <span className="truncate flex-1">{option.name}</span>
            <Check className={cn('size-3.5 shrink-0 text-accent', !selected && 'invisible')} />
          </button>
        );
      })}
    </div>
  );
}
