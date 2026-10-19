import { Service, inject, untracked } from '@angular/core';
import { newId, type MetabaseConnectionSummary, type MetabaseSession } from '@quiver/core';
import { AppState, Dialogs, HostBridge, TabsState, Toasts, type ContextMenuItem } from '@quiver/ui';

export interface OpenMetabaseQueryOptions {
  databaseId?: number | null;
  sql?: string;
  title?: string;
}

/** Opens Metabase's tabs, creates and deletes connections, and signs in and out of their server. */
@Service()
export class MetabaseActions {
  private readonly app = inject(AppState);
  private readonly host = inject(HostBridge);
  private readonly tabs = inject(TabsState);
  private readonly dialogs = inject(Dialogs);
  private readonly toasts = inject(Toasts);

  private scope(): string {
    return untracked(this.app.scope);
  }

  /** Open (or focus) the settings tab of a connection. */
  openConnectionTab(conn: { id: string; name: string }): void {
    this.tabs.openTab(this.scope(), { type: 'metabase.connection', title: conn.name, data: { id: conn.id } }, { singletonKey: `metabase.connection:${conn.id}` });
  }

  /** Open (or focus) a saved question; it runs when the tab opens. */
  openQuestion(conn: { id: string }, card: { id: number; name: string }): void {
    const id = `${conn.id}:${card.id}`;
    this.tabs.openTab(this.scope(), { type: 'metabase.question', title: card.name, data: { id, connectionId: conn.id, cardId: card.id } }, { singletonKey: `metabase.question:${id}` });
  }

  /** A new native query on a connection, optionally on a database and with SQL to start from. */
  openQuery(conn: { id: string; name?: string }, options: OpenMetabaseQueryOptions = {}): void {
    const id = newId();
    this.tabs.openTab(
      this.scope(),
      { type: 'metabase.query', title: options.title ?? 'Metabase query', data: { id, connectionId: conn.id, databaseId: options.databaseId ?? null, sql: options.sql ?? '' } },
      { singletonKey: `metabase.query:${id}` },
    );
  }

  /** A query on the first connection, for the palette. */
  async newQueryForFirstConnection(): Promise<void> {
    try {
      const list = await this.host.invoke<MetabaseConnectionSummary[]>('metabase.connection.list', {});
      if (list[0]) this.openQuery(list[0]);
      else await this.createConnection();
    } catch (err) {
      this.toasts.error(err);
    }
  }

  async createConnection(): Promise<void> {
    const url = await this.dialogs.prompt({
      title: 'New Metabase connection',
      label: 'Metabase address',
      placeholder: 'https://metabase.example.com',
      confirmLabel: 'Create',
    });
    if (!url?.trim()) return;
    try {
      const created = await this.host.invoke<MetabaseConnectionSummary>('metabase.connection.save', { connection: { url: url.trim() } });
      this.openConnectionTab(created);
    } catch (err) {
      this.toasts.error(err);
    }
  }

  /** The sign-in window; resolves to whether the user came back signed in. */
  async signIn(conn: { id: string }): Promise<boolean> {
    try {
      const session = await this.host.invoke<MetabaseSession>('metabase.signin', { connectionId: conn.id });
      if (session.state === 'signed-in') this.toasts.notify(`Signed in to Metabase as ${session.user?.name || session.user?.email || 'you'}`, 'success');
      else if (session.error) this.toasts.notify(session.error, 'error');
      return session.state === 'signed-in';
    } catch (err) {
      this.toasts.error(err);
      return false;
    }
  }

  async signOut(conn: { id: string; url: string }): Promise<void> {
    const host = conn.url.replace(/^[a-z]+:\/\//i, '').split('/')[0];
    if (!(await this.dialogs.confirm({ title: `Sign out of ${host}?`, message: 'Every Metabase connection to this server signs out on this machine.', confirmLabel: 'Sign out' }))) return;
    try {
      await this.host.invoke('metabase.signout', { connectionId: conn.id });
    } catch (err) {
      this.toasts.error(err);
    }
  }

  async deleteConnection(conn: { id: string; name: string }): Promise<void> {
    if (!(await this.dialogs.confirm({ title: `Delete "${conn.name}"?`, message: 'The connection is removed from the project, with its API key on this machine. A browser sign-in to the server stays.', danger: true, confirmLabel: 'Delete' }))) return;
    try {
      await this.host.invoke('metabase.connection.delete', { id: conn.id });
      this.tabs.closeWhere(this.scope(), (t) => (t.type === 'metabase.connection' && t.data?.['id'] === conn.id) || ((t.type === 'metabase.question' || t.type === 'metabase.query') && t.data?.['connectionId'] === conn.id));
    } catch (err) {
      this.toasts.error(err);
    }
  }

  /** The `…` and right-click menu of a connection. */
  connectionMenu(conn: MetabaseConnectionSummary): ContextMenuItem[] {
    const items: ContextMenuItem[] = [
      { label: 'New query', testId: 'mb-menu-new-query', select: () => this.openQuery(conn) },
      { label: 'Edit connection', testId: 'mb-menu-edit', select: () => this.openConnectionTab(conn) },
    ];
    if (conn.auth === 'browser') items.push({ label: 'Sign out', testId: 'mb-menu-signout', disabled: conn.session.state !== 'signed-in', select: () => void this.signOut(conn) });
    items.push('separator', { label: 'Delete connection', testId: 'mb-menu-delete', danger: true, select: () => void this.deleteConnection(conn) });
    return items;
  }
}
