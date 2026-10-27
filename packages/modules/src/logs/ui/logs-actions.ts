import { Service, inject, untracked } from '@angular/core';
import type { LogsConnectionSummary, LogsSession } from '@quiver/core';
import { AppState, Dialogs, HostBridge, TabsState, Toasts } from '@quiver/ui';

/** Opens, creates and deletes logs connections, and signs in and out of their Grafana. */
@Service()
export class LogsActions {
  private readonly app = inject(AppState);
  private readonly host = inject(HostBridge);
  private readonly tabs = inject(TabsState);
  private readonly dialogs = inject(Dialogs);
  private readonly toasts = inject(Toasts);

  /** Open (or focus) the tab of a connection. */
  openConnectionTab(conn: { id: string; name: string }): void {
    this.tabs.openTab(untracked(this.app.scope), { type: 'logs.connection', title: conn.name, data: { id: conn.id } }, { singletonKey: `logs.connection:${conn.id}` });
  }

  /** Ask for an address and how to reach it: through Grafana, or a VictoriaLogs server directly. */
  async createConnection(): Promise<void> {
    const answer = await this.dialogs.promptWithChoice({
      title: 'New logs connection',
      label: 'Address',
      placeholder: 'https://grafana.example.com or http://localhost:9428',
      confirmLabel: 'Create',
      choice: {
        label: 'Connect',
        defaultValue: 'grafana',
        options: [
          { value: 'grafana', label: 'Through Grafana' },
          { value: 'victorialogs', label: 'VictoriaLogs directly' },
        ],
        hint: (_text, kind) =>
          kind === 'victorialogs'
            ? 'The VictoriaLogs server (port 9428 by default); tenant and credentials come next.'
            : 'The Grafana you open VictoriaLogs in; you sign in with your browser account next.',
      },
    });
    const url = answer?.value.trim();
    if (!answer || !url) return;
    const connection = answer.choice === 'victorialogs' ? { name: '', kind: 'victorialogs', url } : { name: '', grafanaUrl: url };
    try {
      const created = await this.host.invoke<LogsConnectionSummary>('logs.connection.save', { connection });
      this.openConnectionTab(created);
    } catch (err) {
      this.toasts.error(err);
    }
  }

  /** The sign-in window; resolves to whether the user came back signed in. */
  async signIn(conn: { id: string }): Promise<boolean> {
    try {
      const session = await this.host.invoke<LogsSession>('logs.signin', { id: conn.id });
      if (session.state !== 'signed-in' && session.error) this.toasts.notify(session.error, 'error');
      return session.state === 'signed-in';
    } catch (err) {
      this.toasts.error(err);
      return false;
    }
  }

  async signOut(conn: { id: string; grafanaUrl: string }): Promise<void> {
    const host = conn.grafanaUrl.replace(/^[a-z]+:\/\//i, '').split('/')[0];
    if (!(await this.dialogs.confirm({ title: `Sign out of ${host}?`, message: 'Every logs connection to this Grafana signs out on this machine.', confirmLabel: 'Sign out' }))) return;
    try {
      await this.host.invoke('logs.signout', { id: conn.id });
    } catch (err) {
      this.toasts.error(err);
    }
  }

  async deleteConnection(conn: { id: string; name: string }): Promise<void> {
    if (!(await this.dialogs.confirm({ title: `Delete "${conn.name}"?`, message: 'The connection is removed from the project, with any password or token stored for it on this machine. A Grafana sign-in on this machine stays.', danger: true, confirmLabel: 'Delete' }))) return;
    try {
      await this.host.invoke('logs.connection.delete', { id: conn.id });
      this.tabs.closeWhere(untracked(this.app.scope), (t) => t.type === 'logs.connection' && t.data?.['id'] === conn.id);
    } catch (err) {
      this.toasts.error(err);
    }
  }
}
