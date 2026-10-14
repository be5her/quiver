import { DOCUMENT, Service, inject, untracked } from '@angular/core';
import type { UpdateChannel, UpdateState } from '@quiver/core';
import { AppState, Dialogs, HostBridge, TabsState, Toasts } from '@quiver/ui';

/** The in-app updater as the UI sees it: the host's state, plus the actions the user can take. */
@Service()
export class Updates {
  private readonly app = inject(AppState);
  private readonly host = inject(HostBridge);
  private readonly toasts = inject(Toasts);
  private readonly dialogs = inject(Dialogs);
  private readonly tabs = inject(TabsState);
  private readonly window = inject(DOCUMENT).defaultView!;

  /** Keeps the state in step with the host and tells the user about outcomes they asked for. */
  handleEvent(state: UpdateState): void {
    const prev = untracked(this.app.update);
    this.app.update.set(state);
    if (prev?.status === state.status) return;
    if (state.status === 'downloaded') {
      this.toasts.notify(`Quiver ${state.version} is ready. Restart to install it.`, 'success');
      return;
    }
    // Automatic checks stay quiet: the status bar shows what they found.
    if (state.trigger !== 'manual') return;
    if (state.status === 'available') this.toasts.notify(`Quiver ${state.version} is available.`, 'info');
    else if (state.status === 'none') this.toasts.notify(`Quiver ${state.current} is the latest version.`, 'success');
    else if (state.status === 'error') this.toasts.notify(`Update check failed: ${state.error ?? 'unknown error'}`, 'error');
  }

  async check(): Promise<void> {
    try {
      const state = await this.host.invoke<UpdateState>('app.update.check', {}, null);
      this.app.update.set(state);
      if (!state.supported) this.toasts.notify(state.reason ?? 'Updates are not available in this build.', 'info');
    } catch (err) {
      this.toasts.error(err);
    }
  }

  /** Joins or leaves the beta channel; the host checks right away so the user sees what the channel offers. */
  async setChannel(channel: UpdateChannel): Promise<void> {
    try {
      this.app.update.set(await this.host.invoke<UpdateState>('app.update.channel', { channel }, null));
    } catch (err) {
      this.toasts.error(err);
    }
  }

  async download(): Promise<void> {
    try {
      this.app.update.set(await this.host.invoke<UpdateState>('app.update.download', {}, null));
    } catch (err) {
      this.toasts.error(err);
    }
  }

  async install(): Promise<void> {
    const update = untracked(this.app.update);
    const dirty = Object.values(untracked(this.tabs.scopes)).some((s) => s.tabs.some((t) => t.dirty));
    const ok = await this.dialogs.confirm({
      title: `Restart Quiver to install ${update?.version ?? 'the update'}?`,
      message: dirty ? 'Some tabs have unsaved changes; they will be lost.' : 'Quiver closes, installs the update and opens again.',
      danger: dirty,
      confirmLabel: 'Restart now',
    });
    if (!ok) return;
    try {
      await this.host.invoke('app.update.install', {}, null);
    } catch (err) {
      this.toasts.error(err);
    }
  }

  /** Links open in the system browser through the main process's window-open handler. */
  openExternal(url: string | undefined): void {
    if (url) this.window.open(url, '_blank', 'noopener');
  }
}
