import { Service, computed, signal, untracked } from '@angular/core';
import type { CommandMeta, GlobalConfig, UpdateState, WorkspaceInfo } from '@quiver/core';

/** Scope key of the tabs and module choice shown while no workspace is active. */
export const GLOBAL_SCOPE = '__global__';

export interface McpStatus {
  running: boolean;
  port: number;
  error?: string;
}

/** What the whole renderer shares: config, workspaces, the active module per scope, and host status. */
@Service()
export class AppState {
  readonly ready = signal(false);
  readonly config = signal<GlobalConfig | null>(null);
  readonly commands = signal<CommandMeta[]>([]);
  readonly activeWorkspaceId = signal<string | null>(null);
  readonly paletteOpen = signal(false);
  readonly bottomPanelOpen = signal(false);
  readonly resolvedTheme = signal<'light' | 'dark'>('light');
  readonly mcpStatus = signal<McpStatus | null>(null);
  /** In-app updater state, mirrored from the host. */
  readonly update = signal<UpdateState | null>(null);

  private readonly workspaceList = signal<WorkspaceInfo[]>([]);
  private readonly moduleByScope = signal<Record<string, string>>({});

  readonly workspaces = this.workspaceList.asReadonly();
  readonly activeModuleByScope = this.moduleByScope.asReadonly();
  /** Scope key the shell shows: the active workspace id, or the global scope. */
  readonly scope = computed(() => this.activeWorkspaceId() ?? GLOBAL_SCOPE);
  readonly activeWorkspace = computed(() => this.workspaceList().find((w) => w.id === this.activeWorkspaceId()));
  readonly activeModule = computed<string | undefined>(() => this.moduleByScope()[this.scope()]);
  readonly hasWorkspace = computed(() => this.activeWorkspaceId() !== null);

  /** Replace the open workspaces; the active one stays when still open, otherwise the first one takes over. */
  setWorkspaces(workspaces: WorkspaceInfo[]): void {
    const active = untracked(this.activeWorkspaceId);
    this.workspaceList.set(workspaces);
    if (!workspaces.some((w) => w.id === active)) this.activeWorkspaceId.set(workspaces[0]?.id ?? null);
  }

  /** Show a module in the current scope. */
  setActiveModule(moduleId: string): void {
    const scope = untracked(this.scope);
    this.moduleByScope.update((byScope) => ({ ...byScope, [scope]: moduleId }));
  }
}
