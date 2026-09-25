import { toErrorPayload, type WorkspaceInfo } from '@quiver/core';
import { applyTheme, confirmDialog, invoke, notify, registerActions, selectScope, useAppStore, useTabsStore, type UIAction } from '@quiver/ui';
import { modules } from './modules';
import { checkForUpdates } from './updates';

export function openSettings(): void {
  const scope = selectScope(useAppStore.getState());
  useTabsStore.getState().openTab(scope, { type: 'shell.settings', title: 'Settings', data: { key: 'settings' } }, { singletonKey: 'shell.settings:settings' });
}

export async function openWorkspace(path?: string): Promise<void> {
  try {
    const info = await invoke<WorkspaceInfo | null>('workspace.open', path ? { path } : {}, null);
    if (info) useAppStore.getState().setActiveWorkspace(info.id);
  } catch (err) {
    notify(toErrorPayload(err).message, 'error');
  }
}

export async function closeWorkspace(id: string): Promise<void> {
  const tabs = useTabsStore.getState().scopes[id]?.tabs ?? [];
  if (tabs.some((t) => t.dirty) && !(await confirmDialog({ title: 'Close workspace with unsaved tabs?', danger: true, confirmLabel: 'Close' }))) return;
  await invoke('workspace.close', { id }, null);
}

export async function toggleTheme(): Promise<void> {
  const config = useAppStore.getState().config;
  if (!config) return;
  const next = useAppStore.getState().resolvedTheme === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  await invoke('config.update', { patch: { theme: next } }, null);
}

const shellActions: UIAction[] = [
  { id: 'palette.open', title: 'Command palette', group: 'App', shortcut: 'Ctrl+K', run: () => useAppStore.getState().setPaletteOpen(true) },
  { id: 'workspace.open', title: 'Open folder as workspace', group: 'Workspace', shortcut: 'Ctrl+O', run: () => openWorkspace() },
  {
    id: 'workspace.close',
    title: 'Close current workspace',
    group: 'Workspace',
    run: () => {
      const id = useAppStore.getState().activeWorkspaceId;
      if (id) void closeWorkspace(id);
    },
    when: () => useAppStore.getState().activeWorkspaceId !== null,
  },
  { id: 'settings.open', title: 'Settings', group: 'App', shortcut: 'Ctrl+,', run: openSettings },
  { id: 'theme.toggle', title: 'Toggle light / dark theme', group: 'App', run: () => toggleTheme() },
  { id: 'app.update.check', title: 'Check for updates', group: 'App', run: () => checkForUpdates() },
  {
    id: 'tab.close',
    title: 'Close tab',
    group: 'Tabs',
    shortcut: 'Ctrl+W',
    run: () => {
      const scope = selectScope(useAppStore.getState());
      const { activeTabId } = useTabsStore.getState().scopes[scope] ?? { activeTabId: null };
      if (activeTabId) useTabsStore.getState().closeTab(scope, activeTabId);
    },
  },
  { id: 'tab.closeAll', title: 'Close all tabs', group: 'Tabs', run: () => useTabsStore.getState().closeAll(selectScope(useAppStore.getState())) },
  { id: 'panel.toggle', title: 'Toggle bottom panel', group: 'App', shortcut: 'Ctrl+J', run: () => useAppStore.getState().setBottomPanelOpen(!useAppStore.getState().bottomPanelOpen) },
  ...modules.map<UIAction>((m) => ({
    id: `module.show.${m.id}`,
    title: `Show ${m.title}`,
    group: 'Modules',
    run: () => useAppStore.getState().setActiveModule(m.id),
    when: () => m.availability === 'always' || useAppStore.getState().activeWorkspaceId !== null,
  })),
];

export function registerShellActions(): () => void {
  const unregisterShell = registerActions(shellActions);
  const unregisterModules = modules.flatMap((m) => (m.actions ? [registerActions(m.actions)] : []));
  return () => {
    unregisterShell();
    unregisterModules.forEach((u) => u());
  };
}

/** Global keyboard shortcuts. Editors handle their own Ctrl+S / Ctrl+Enter. */
export function handleShortcut(e: KeyboardEvent): void {
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return;
  const key = e.key.toLowerCase();
  const run = (id: string) => {
    e.preventDefault();
    const action = shellActions.find((a) => a.id === id) ?? modules.flatMap((m) => m.actions ?? []).find((a) => a.id === id);
    if (action && (!action.when || action.when())) void action.run();
  };
  if (key === 'k' || (e.shiftKey && key === 'p')) return run('palette.open');
  if (key === 'o') return run('workspace.open');
  if (key === ',') return run('settings.open');
  if (key === 'w') return run('tab.close');
  if (key === 'j') return run('panel.toggle');
  if (key === 'n') return run('api.request.new');
  if (e.shiftKey && key === 'q') return run('db.query.new');
  if (/^[1-9]$/.test(key)) {
    const ws = useAppStore.getState().workspaces[Number(key) - 1];
    if (ws) {
      e.preventDefault();
      useAppStore.getState().setActiveWorkspace(ws.id);
    }
  }
}
