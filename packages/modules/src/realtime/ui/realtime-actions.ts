import { Service, inject, untracked } from '@angular/core';
import type { RealtimeConnectionSummary, RealtimeKind } from '@quiver/core';
import { AppState, Dialogs, HostBridge, TabsState, Toasts } from '@quiver/ui';

export type ConnectionView = 'messages' | 'headers' | 'auth' | 'saved' | 'settings';

/** Opens, creates, connects and deletes realtime connections. */
@Service()
export class RealtimeActions {
  private readonly app = inject(AppState);
  private readonly host = inject(HostBridge);
  private readonly tabs = inject(TabsState);
  private readonly dialogs = inject(Dialogs);
  private readonly toasts = inject(Toasts);

  /** Open (or focus) the tab of a connection; `view` steers it to a section. */
  openConnectionTab(conn: { id: string; name: string }, view?: ConnectionView): void {
    const scope = untracked(this.app.scope);
    const tab = this.tabs.openTab(scope, { type: 'realtime.connection', title: conn.name, data: { id: conn.id, view } }, { singletonKey: `realtime.connection:${conn.id}` });
    if (view) this.tabs.updateTab(scope, tab.id, { data: { ...tab.data, id: conn.id, view, nonce: Date.now() } });
  }

  async createConnection(kind: RealtimeKind = 'websocket'): Promise<void> {
    const name = await this.dialogs.prompt({
      title: kind === 'sse' ? 'New event stream (SSE)' : 'New WebSocket connection',
      label: 'Name',
      placeholder: kind === 'sse' ? 'e.g. order updates' : 'e.g. chat gateway',
      confirmLabel: 'Create',
    });
    if (!name?.trim()) return;
    try {
      const created = await this.host.invoke<RealtimeConnectionSummary>('realtime.connection.save', { connection: { name: name.trim(), kind, url: '' } });
      this.openConnectionTab(created, 'messages');
    } catch (err) {
      this.toasts.error(err);
    }
  }

  async toggleConnection(conn: Pick<RealtimeConnectionSummary, 'id' | 'status'>): Promise<void> {
    try {
      if (conn.status === 'disconnected') {
        const opened = await this.host.invoke<RealtimeConnectionSummary>('realtime.connect', { id: conn.id });
        if (opened.error && opened.status === 'disconnected') this.toasts.notify(opened.error, 'error');
      } else {
        await this.host.invoke('realtime.disconnect', { id: conn.id });
      }
    } catch (err) {
      this.toasts.error(err);
    }
  }

  async deleteConnection(conn: { id: string; name: string }): Promise<void> {
    if (!(await this.dialogs.confirm({ title: `Delete "${conn.name}"?`, message: 'The connection and its message log are removed.', danger: true, confirmLabel: 'Delete' }))) return;
    try {
      await this.host.invoke('realtime.connection.delete', { id: conn.id });
      this.tabs.closeWhere(untracked(this.app.scope), (t) => t.type === 'realtime.connection' && t.data?.['id'] === conn.id);
    } catch (err) {
      this.toasts.error(err);
    }
  }
}
