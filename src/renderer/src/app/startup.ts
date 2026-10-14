import { DestroyRef, Service, effect, inject, untracked } from '@angular/core';
import { arrangeActivityBar, type GlobalConfig, type UpdateState, type WorkspaceInfo } from '@quiver/core';
import { AppState, GLOBAL_SCOPE, HostBridge, Theme } from '@quiver/ui';
import { modules } from './modules';
import { ShellPersistence } from './persistence';
import { ShellActions } from './shell-actions';
import { Updates } from './updates';

/**
 * Brings the shell up: loads what the host knows (config, commands, workspaces, MCP and updater
 * status), follows the host's events, and keeps the host told which workspace is on screen.
 */
@Service()
export class ShellStartup {
  private readonly app = inject(AppState);
  private readonly host = inject(HostBridge);
  private readonly theme = inject(Theme);
  private readonly updates = inject(Updates);
  private readonly actions = inject(ShellActions);
  private readonly destroyRef = inject(DestroyRef);

  constructor() {
    inject(ShellPersistence);
    const offs = [
      this.host.on('workspace.changed', ({ workspaces }) => this.app.setWorkspaces(workspaces)),
      this.host.on('config.changed', ({ config }) => {
        this.app.config.set(config);
        this.theme.apply(config.theme, config.palette);
      }),
      this.host.on('mcp.status', (status) => this.app.mcpStatus.set(status)),
      this.host.on('app.update', (state) => this.updates.handleEvent(state)),
      this.actions.register(),
    ];
    this.destroyRef.onDestroy(() => offs.forEach((off) => off()));
    this.theme.followSystem(this.destroyRef);

    // Tell the host which workspace the UI is showing, so MCP clients follow it.
    effect(() => {
      const id = this.app.activeWorkspaceId();
      if (this.app.ready()) void this.host.invoke('workspace.setActive', { id }, null).catch(() => {});
    });

    // Pick a module when a scope is shown for the first time, following the user's activity bar order.
    effect(() => {
      const workspaceId = this.app.activeWorkspaceId();
      const layout = this.app.config()?.activityBar;
      if (this.app.activeModuleByScope()[workspaceId ?? GLOBAL_SCOPE] || !layout) return;
      const shown = arrangeActivityBar(
        modules.map((m) => m.id),
        layout,
      ).visible.map((id) => modules.find((m) => m.id === id)!);
      const candidate = shown.find((m) => (workspaceId ? true : m.availability === 'always'));
      if (candidate) untracked(() => this.app.setActiveModule(candidate.id));
    });
  }

  /** Load the initial state; the shell renders once this resolves. */
  async load(): Promise<void> {
    const [config, commands, workspaces, info] = await Promise.all([
      this.host.invoke<GlobalConfig>('config.get', {}, null),
      this.host.listCommands(),
      this.host.invoke<WorkspaceInfo[]>('workspace.list', {}, null),
      this.host.invoke<{ mcp: { running: boolean; port: number }; update: UpdateState }>('app.info', {}, null),
    ]);
    this.app.config.set(config);
    this.theme.apply(config.theme, config.palette);
    this.app.commands.set(commands);
    this.app.setWorkspaces(workspaces);
    this.app.mcpStatus.set(info.mcp);
    this.app.update.set(info.update);
    this.app.ready.set(true);
  }
}
