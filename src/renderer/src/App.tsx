import type { CommandMeta, GlobalConfig, UpdateState, WorkspaceInfo } from '@quiver/core';
import { DialogHost, ToastHost, applyTheme, invoke, onHostEvent, useAppStore, watchSystemTheme } from '@quiver/ui';
import { useEffect } from 'react';
import { ActivityBar } from './shell/ActivityBar';
import { CommandPalette } from './shell/CommandPalette';
import { Sidebar } from './shell/Sidebar';
import { StatusBar } from './shell/StatusBar';
import { TabBar } from './shell/TabBar';
import { TabContent } from './shell/TabContent';
import { TitleBar } from './shell/TitleBar';
import { handleShortcut, registerShellActions } from './shell/actions';
import { modules } from './shell/modules';
import { useTabPersistence } from './shell/persistence';
import { handleUpdateEvent } from './shell/updates';

export function App() {
  const ready = useAppStore((s) => s.ready);
  useBootstrap();
  useTabPersistence();
  useDefaultModule();

  if (!ready) return <div className="h-full bg-canvas" />;

  return (
    <div className="flex flex-col h-full bg-canvas text-fg" data-testid="app-ready">
      <TitleBar />
      <div className="flex flex-1 min-h-0">
        <ActivityBar />
        <Sidebar />
        <main className="flex flex-col flex-1 min-w-0 min-h-0">
          <TabBar />
          <TabContent />
        </main>
      </div>
      <StatusBar />
      <CommandPalette />
      <DialogHost />
      <ToastHost />
    </div>
  );
}

function useBootstrap() {
  useEffect(() => {
    const store = useAppStore.getState();
    let disposed = false;

    (async () => {
      const [config, commands, workspaces, info] = await Promise.all([
        invoke<GlobalConfig>('config.get', {}, null),
        window.quiver.listCommands() as Promise<CommandMeta[]>,
        invoke<WorkspaceInfo[]>('workspace.list', {}, null),
        invoke<{ mcp: { running: boolean; port: number }; update: UpdateState }>('app.info', {}, null),
      ]);
      if (disposed) return;
      store.setConfig(config);
      applyTheme(config.theme, config.palette);
      store.setCommands(commands);
      store.setWorkspaces(workspaces);
      store.setMcpStatus(info.mcp);
      store.setUpdate(info.update);
      store.setReady(true);
    })().catch((err) => console.error('[quiver] bootstrap failed', err));

    const offs = [
      onHostEvent('workspace.changed', ({ workspaces }) => useAppStore.getState().setWorkspaces(workspaces)),
      onHostEvent('config.changed', ({ config }) => {
        useAppStore.getState().setConfig(config);
        applyTheme(config.theme, config.palette);
      }),
      onHostEvent('mcp.status', (status) => useAppStore.getState().setMcpStatus(status)),
      onHostEvent('app.update', handleUpdateEvent),
      watchSystemTheme(() => useAppStore.getState().config?.theme ?? 'system'),
      registerShellActions(),
    ];
    window.addEventListener('keydown', handleShortcut);
    return () => {
      disposed = true;
      offs.forEach((off) => off());
      window.removeEventListener('keydown', handleShortcut);
    };
  }, []);

  // Tell the host which workspace the UI is showing so MCP clients follow it.
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId);
  const ready = useAppStore((s) => s.ready);
  useEffect(() => {
    if (ready) void invoke('workspace.setActive', { id: activeWorkspaceId }, null).catch(() => {});
  }, [activeWorkspaceId, ready]);
}

/** Pick a sensible module when a scope is shown for the first time. */
function useDefaultModule() {
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId);
  const activeModuleByScope = useAppStore((s) => s.activeModuleByScope);
  const setActiveModule = useAppStore((s) => s.setActiveModule);
  useEffect(() => {
    const scope = activeWorkspaceId ?? '__global__';
    if (activeModuleByScope[scope]) return;
    const candidate = modules.find((m) => (activeWorkspaceId ? true : m.availability === 'always'));
    if (candidate) setActiveModule(candidate.id);
  }, [activeWorkspaceId, activeModuleByScope, setActiveModule]);
}
