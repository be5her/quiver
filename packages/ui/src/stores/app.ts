import type { CommandMeta, GlobalConfig, WorkspaceInfo } from '@quiver/core';
import { create } from 'zustand';

export const GLOBAL_SCOPE = '__global__';

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'error';
  message: string;
}

export interface McpStatus {
  running: boolean;
  port: number;
  error?: string;
}

interface AppState {
  ready: boolean;
  config: GlobalConfig | null;
  commands: CommandMeta[];
  workspaces: WorkspaceInfo[];
  activeWorkspaceId: string | null;
  activeModuleByScope: Record<string, string>;
  paletteOpen: boolean;
  bottomPanelOpen: boolean;
  resolvedTheme: 'light' | 'dark';
  mcpStatus: McpStatus | null;
  toasts: Toast[];

  setReady(ready: boolean): void;
  setConfig(config: GlobalConfig): void;
  setCommands(commands: CommandMeta[]): void;
  setWorkspaces(workspaces: WorkspaceInfo[]): void;
  setActiveWorkspace(id: string | null): void;
  setActiveModule(moduleId: string): void;
  setPaletteOpen(open: boolean): void;
  setBottomPanelOpen(open: boolean): void;
  setResolvedTheme(theme: 'light' | 'dark'): void;
  setMcpStatus(status: McpStatus): void;
  notify(message: string, kind?: Toast['kind']): void;
  dismissToast(id: number): void;
}

let toastSeq = 0;

export const useAppStore = create<AppState>((set, get) => ({
  ready: false,
  config: null,
  commands: [],
  workspaces: [],
  activeWorkspaceId: null,
  activeModuleByScope: {},
  paletteOpen: false,
  bottomPanelOpen: false,
  resolvedTheme: 'light',
  mcpStatus: null,
  toasts: [],

  setReady: (ready) => set({ ready }),
  setConfig: (config) => set({ config }),
  setCommands: (commands) => set({ commands }),
  setWorkspaces: (workspaces) => {
    const { activeWorkspaceId } = get();
    const stillOpen = workspaces.some((w) => w.id === activeWorkspaceId);
    set({ workspaces, activeWorkspaceId: stillOpen ? activeWorkspaceId : (workspaces[0]?.id ?? null) });
  },
  setActiveWorkspace: (id) => set({ activeWorkspaceId: id }),
  setActiveModule: (moduleId) => {
    const scope = get().activeWorkspaceId ?? GLOBAL_SCOPE;
    set({ activeModuleByScope: { ...get().activeModuleByScope, [scope]: moduleId } });
  },
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  setBottomPanelOpen: (bottomPanelOpen) => set({ bottomPanelOpen }),
  setResolvedTheme: (resolvedTheme) => set({ resolvedTheme }),
  setMcpStatus: (mcpStatus) => set({ mcpStatus }),
  notify: (message, kind = 'info') => {
    const id = ++toastSeq;
    set({ toasts: [...get().toasts, { id, kind, message }] });
    setTimeout(() => get().dismissToast(id), kind === 'error' ? 6000 : 3000);
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));

export const selectScope = (s: AppState): string => s.activeWorkspaceId ?? GLOBAL_SCOPE;
export const selectActiveWorkspace = (s: AppState): WorkspaceInfo | undefined =>
  s.workspaces.find((w) => w.id === s.activeWorkspaceId);
export const selectActiveModule = (s: AppState): string | undefined => s.activeModuleByScope[selectScope(s)];

export function notify(message: string, kind: Toast['kind'] = 'info'): void {
  useAppStore.getState().notify(message, kind);
}
