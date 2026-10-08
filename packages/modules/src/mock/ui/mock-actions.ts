import { Service, inject, untracked } from '@angular/core';
import type { MockServerSummary } from '@quiver/core';
import { AppState, Dialogs, HostBridge, TabsState, Toasts } from '@quiver/ui';

export type ServerView = 'routes' | 'requests' | 'settings';
export type ServerKind = 'mock' | 'webhook';

/** Opens, creates, starts and stops mock servers. */
@Service()
export class MockActions {
  private readonly app = inject(AppState);
  private readonly host = inject(HostBridge);
  private readonly tabs = inject(TabsState);
  private readonly dialogs = inject(Dialogs);
  private readonly toasts = inject(Toasts);

  /** Remembered across tabs so replaying several webhooks to the same dev server is one click. */
  lastReplayTarget = 'http://localhost:3000';

  /** Open (or focus) the tab of a server; `view` and `routeId` steer it to a section. */
  openServerTab(server: { id: string; name: string }, view?: ServerView, routeId?: string): void {
    const scope = untracked(this.app.scope);
    const tab = this.tabs.openTab(scope, { type: 'mock.server', title: server.name, data: { id: server.id, view, routeId } }, { singletonKey: `mock.server:${server.id}` });
    if (view || routeId) this.tabs.updateTab(scope, tab.id, { data: { ...tab.data, id: server.id, view, routeId, nonce: Date.now() } });
  }

  /** A webhook receiver is a server with no routes that answers 200 to everything. */
  async createServer(kind: ServerKind = 'mock'): Promise<void> {
    const name = await this.dialogs.prompt({
      title: kind === 'webhook' ? 'New webhook receiver' : 'New mock server',
      label: 'Name',
      placeholder: kind === 'webhook' ? 'e.g. Stripe webhooks' : 'e.g. payments API',
      confirmLabel: 'Create',
    });
    if (!name?.trim()) return;
    try {
      const server = await this.host.invoke<MockServerSummary>('mock.server.save', {
        server: {
          name: name.trim(),
          autoStart: kind === 'webhook',
          fallback:
            kind === 'webhook' ? { type: 'respond', status: 200, headers: [], body: '{"ok":true}' } : { type: 'respond', status: 404, headers: [], body: '{"error":"no mock route matched"}' },
        },
      });
      try {
        await this.host.invoke('mock.server.start', { id: server.id });
      } catch (err) {
        this.toasts.error(err);
      }
      this.openServerTab(server, kind === 'webhook' ? 'requests' : 'routes');
    } catch (err) {
      this.toasts.error(err);
    }
  }

  async toggleServer(server: Pick<MockServerSummary, 'id' | 'running'>): Promise<void> {
    try {
      await this.host.invoke(server.running ? 'mock.server.stop' : 'mock.server.start', { id: server.id });
    } catch (err) {
      this.toasts.error(err);
    }
  }

  async deleteServer(server: { id: string; name: string }): Promise<void> {
    if (!(await this.dialogs.confirm({ title: `Delete "${server.name}"?`, message: 'Its routes and captured requests are removed.', danger: true, confirmLabel: 'Delete' }))) return;
    try {
      await this.host.invoke('mock.server.delete', { id: server.id });
      this.tabs.closeWhere(untracked(this.app.scope), (t) => t.type === 'mock.server' && t.data?.['id'] === server.id);
    } catch (err) {
      this.toasts.error(err);
    }
  }
}
