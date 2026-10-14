import { Injector, Service, inject, runInInjectionContext, untracked } from '@angular/core';
import type { WorkspaceInfo } from '@quiver/core';
import { AppState, Dialogs, HostBridge, TabsState, Theme, Toasts, UiActions, type UIAction } from '@quiver/ui';
import { modules } from './modules';
import { Updates } from './updates';

/** What the shell itself can do: workspaces, tabs, settings and theme, plus the palette and keyboard wiring. */
@Service()
export class ShellActions {
  private readonly app = inject(AppState);
  private readonly host = inject(HostBridge);
  private readonly tabs = inject(TabsState);
  private readonly dialogs = inject(Dialogs);
  private readonly toasts = inject(Toasts);
  private readonly theme = inject(Theme);
  private readonly updates = inject(Updates);
  private readonly actions = inject(UiActions);
  private readonly injector = inject(Injector);

  private readonly shellActions: UIAction[] = [
    { id: 'palette.open', title: 'Command palette', group: 'App', shortcut: 'Ctrl+K', run: () => this.app.paletteOpen.set(true) },
    { id: 'workspace.open', title: 'Open folder as workspace', group: 'Workspace', shortcut: 'Ctrl+O', run: () => this.openWorkspace() },
    {
      id: 'workspace.close',
      title: 'Close current workspace',
      group: 'Workspace',
      run: () => {
        const id = untracked(this.app.activeWorkspaceId);
        if (id) void this.closeWorkspace(id);
      },
      when: () => untracked(this.app.activeWorkspaceId) !== null,
    },
    { id: 'settings.open', title: 'Settings', group: 'App', shortcut: 'Ctrl+,', run: () => this.openSettings() },
    { id: 'theme.toggle', title: 'Toggle light / dark theme', group: 'App', run: () => this.toggleTheme() },
    { id: 'app.update.check', title: 'Check for updates', group: 'App', run: () => this.updates.check() },
    {
      id: 'tab.close',
      title: 'Close tab',
      group: 'Tabs',
      shortcut: 'Ctrl+W',
      run: () => {
        const scope = untracked(this.app.scope);
        const { activeTabId } = untracked(() => this.tabs.scope(scope));
        if (activeTabId) this.tabs.closeTab(scope, activeTabId);
      },
    },
    { id: 'tab.closeAll', title: 'Close all tabs', group: 'Tabs', run: () => this.tabs.closeAll(untracked(this.app.scope)) },
    { id: 'panel.toggle', title: 'Toggle bottom panel', group: 'App', shortcut: 'Ctrl+J', run: () => this.app.bottomPanelOpen.update((open) => !open) },
    ...modules.map<UIAction>((m) => ({
      id: `module.show.${m.id}`,
      title: `Show ${m.title}`,
      group: 'Modules',
      run: () => this.app.setActiveModule(m.id),
      when: () => m.availability === 'always' || untracked(this.app.activeWorkspaceId) !== null,
    })),
  ];
  private moduleActions: UIAction[] = [];

  /** Put the shell's and the modules' actions in the palette; returns the function that takes them out. */
  register(): () => void {
    // Module actions are built in an injection context so they can reach their module's services.
    this.moduleActions = runInInjectionContext(this.injector, () => modules.flatMap((m) => m.actions?.() ?? []));
    const offs = [this.actions.register(this.shellActions), this.actions.register(this.moduleActions)];
    return () => offs.forEach((off) => off());
  }

  openSettings(): void {
    this.tabs.openTab(untracked(this.app.scope), { type: 'shell.settings', title: 'Settings', data: { key: 'settings' } }, { singletonKey: 'shell.settings:settings' });
  }

  async openWorkspace(path?: string): Promise<void> {
    try {
      const info = await this.host.invoke<WorkspaceInfo | null>('workspace.open', path ? { path } : {}, null);
      if (info) this.app.activeWorkspaceId.set(info.id);
    } catch (err) {
      this.toasts.error(err);
    }
  }

  async closeWorkspace(id: string): Promise<void> {
    await this.closeWorkspaces([id]);
  }

  /** Close several workspaces, with one question for all their unsaved tabs. */
  async closeWorkspaces(ids: string[]): Promise<void> {
    const scopes = untracked(this.tabs.scopes);
    const dirty = ids.filter((id) => scopes[id]?.tabs.some((t) => t.dirty));
    if (
      dirty.length &&
      !(await this.dialogs.confirm({
        title: dirty.length === 1 && ids.length === 1 ? 'Close workspace with unsaved tabs?' : `Close ${ids.length} workspaces, ${dirty.length} with unsaved tabs?`,
        danger: true,
        confirmLabel: 'Close',
      }))
    )
      return;
    for (const id of ids) await this.host.invoke('workspace.close', { id }, null);
  }

  /** Close several tabs of a scope at once, asking first when any of them has unsaved changes. */
  async closeTabs(scope: string, ids: string[]): Promise<void> {
    const { tabs } = untracked(() => this.tabs.scope(scope));
    const dirty = tabs.filter((t) => ids.includes(t.id) && t.dirty);
    if (dirty.length) {
      const ok = await this.dialogs.confirm({
        title: dirty.length === 1 ? `Close "${dirty[0].title}" with unsaved changes?` : `Close ${dirty.length} tabs with unsaved changes?`,
        message: 'Unsaved changes in those tabs are lost.',
        danger: true,
        confirmLabel: 'Close',
      });
      if (!ok) return;
    }
    this.tabs.closeWhere(scope, (t) => ids.includes(t.id));
  }

  async revealWorkspace(id: string): Promise<void> {
    try {
      await this.host.invoke('workspace.reveal', { id }, null);
    } catch (err) {
      this.toasts.error(err);
    }
  }

  async toggleTheme(): Promise<void> {
    if (!untracked(this.app.config)) return;
    const next = untracked(this.app.resolvedTheme) === 'dark' ? 'light' : 'dark';
    this.theme.apply(next);
    await this.host.invoke('config.update', { patch: { theme: next } }, null);
  }

  /** Global keyboard shortcuts. Editors handle their own Ctrl+S / Ctrl+Enter. */
  handleShortcut(e: KeyboardEvent): void {
    if (!(e.ctrlKey || e.metaKey)) return;
    const key = e.key.toLowerCase();
    const run = (id: string) => {
      e.preventDefault();
      const action = this.shellActions.find((a) => a.id === id) ?? this.moduleActions.find((a) => a.id === id);
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
      const ws = untracked(this.app.workspaces)[Number(key) - 1];
      if (ws) {
        e.preventDefault();
        this.app.activeWorkspaceId.set(ws.id);
      }
    }
  }
}
