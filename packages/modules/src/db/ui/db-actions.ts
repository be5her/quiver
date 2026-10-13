import { Service, inject, untracked } from '@angular/core';
import { newId, type DbConnectionSummary, type DbKind, type SavedQuery } from '@quiver/core';
import { AppState, Dialogs, HostBridge, TabsState, Toasts, TreeState, type ContextMenuItem } from '@quiver/ui';
import { firstLine } from './db-format';

export interface OpenQueryOptions {
  queryId?: string;
  connectionId?: string | null;
  database?: string | null;
  text?: string;
  title?: string;
}

/** What `db.connection.list` adds to a saved connection. */
export interface DbConnectionRow extends DbConnectionSummary {
  connected?: boolean;
  inTransaction?: boolean;
}

/** Opens the Databases module's tabs and runs its sidebar actions. */
@Service()
export class DbActions {
  private readonly app = inject(AppState);
  private readonly host = inject(HostBridge);
  private readonly tabs = inject(TabsState);
  private readonly tree = inject(TreeState);
  private readonly dialogs = inject(Dialogs);
  private readonly toasts = inject(Toasts);

  openConnectionTab(conn: { id: string; name: string }): void {
    this.tabs.openTab(this.scope(), { type: 'db.connection', title: conn.name, data: { id: conn.id } }, { singletonKey: `db.connection:${conn.id}` });
  }

  /** One draft tab per kind; it turns into the real connection's tab on save. A pasted URL prefills it. */
  openNewConnectionTab(kind: DbKind = 'mysql', options: { url?: string } = {}): void {
    const key = `db.connection:new-${kind}`;
    const existing = this.tabs.scope(this.scope()).tabs.find((t) => t.type === 'db.connection' && t.data?.['id'] === `new-${kind}`);
    if (existing && options.url) this.tabs.updateTab(this.scope(), existing.id, { data: { ...existing.data, url: options.url } });
    this.tabs.openTab(this.scope(), { type: 'db.connection', title: 'New connection', data: { id: `new-${kind}`, kind, ...(options.url ? { url: options.url } : {}) } }, { singletonKey: key });
  }

  openQueryTab(options: OpenQueryOptions = {}): void {
    const id = options.queryId ?? newId();
    this.tabs.openTab(
      this.scope(),
      {
        type: 'db.query',
        title: options.title ?? (options.text ? firstLine(options.text, 32) : 'Query'),
        data: { id, queryId: options.queryId, connectionId: options.connectionId ?? null, database: options.database ?? null, text: options.text ?? '' },
      },
      options.queryId ? { singletonKey: `db.query:${options.queryId}` } : undefined,
    );
  }

  /** A table's tab; `where` presets its filter (foreign-key navigation, "filter by this value"). An open tab takes the new filter. */
  openTableTab(connectionId: string, table: string, database: string | null, options: { where?: string } = {}): void {
    const id = `${connectionId}:${database ?? ''}:${table}`;
    const key = `db.table:${id}`;
    const scope = this.scope();
    const existing = untracked(() => this.tabs.scope(scope)).tabs.find((t) => t.type === 'db.table' && t.data?.['id'] === id);
    if (existing && options.where !== undefined) this.tabs.updateTab(scope, existing.id, { data: { ...existing.data, where: options.where, whereAt: Date.now() } });
    this.tabs.openTab(scope, { type: 'db.table', title: table, data: { id, connectionId, table, database, where: options.where ?? null, whereAt: Date.now() } }, { singletonKey: key });
  }

  openRedisTab(conn: { id: string; name: string }): void {
    this.tabs.openTab(this.scope(), { type: 'db.redis', title: `${conn.name} keys`, data: { id: conn.id, connectionId: conn.id } }, { singletonKey: `db.redis:${conn.id}` });
  }

  openHistoryTab(): void {
    this.tabs.openTab(this.scope(), { type: 'db.history', title: 'Query history', data: { id: 'history' } }, { singletonKey: 'db.history:history' });
  }

  openSearchTab(query = ''): void {
    const scope = this.scope();
    const existing = untracked(() => this.tabs.scope(scope)).tabs.find((t) => t.type === 'db.search');
    if (existing && query) this.tabs.updateTab(scope, existing.id, { data: { ...existing.data, query } });
    this.tabs.openTab(scope, { type: 'db.search', title: 'Schema search', data: { id: 'search', query } }, { singletonKey: 'db.search:search' });
  }

  /** The connection's main view: its keys for Redis, a query for the rest. */
  openConnection(conn: { id: string; name: string; kind: DbKind; database?: string }): void {
    if (conn.kind === 'redis') this.openRedisTab(conn);
    else this.openQueryTab({ connectionId: conn.id, database: conn.database || null, title: conn.name });
  }

  /** Switch to the Databases module and expand a connection in its tree. */
  revealConnection(conn: { id: string; name: string; kind: DbKind }): void {
    this.app.setActiveModule('db');
    this.tree.expand(`conn/${conn.id}`);
    this.openConnection(conn);
  }

  async newQueryForFirstConnection(): Promise<void> {
    const connections = await this.host.invoke<DbConnectionSummary[]>('db.connection.list');
    this.openQueryTab({ connectionId: connections[0]?.id ?? null });
  }

  /** The right-click (and "…") menu of a connection in the tree. */
  connectionMenu(conn: DbConnectionRow): ContextMenuItem[] {
    const items: ContextMenuItem[] = [{ label: conn.kind === 'redis' ? 'Browse keys' : 'New query', select: () => this.openConnection(conn) }];
    if (conn.kind === 'redis') items.push({ label: 'Console', select: () => this.openQueryTab({ connectionId: conn.id, title: conn.name }) });
    else items.push({ label: 'Search tables and columns', select: () => this.openSearchTab() });
    items.push('separator', { label: 'Edit connection', select: () => this.openConnectionTab(conn) });
    items.push({ label: 'Disconnect', disabled: !conn.connected, select: () => void this.disconnect(conn) });
    items.push('separator', { label: 'Delete connection', danger: true, select: () => void this.deleteConnection(conn).catch((err) => this.toasts.error(err)) });
    return items;
  }

  async disconnect(conn: { id: string; name: string }): Promise<void> {
    try {
      await this.host.invoke('db.connection.disconnect', { id: conn.id });
      this.toasts.notify(`Disconnected from ${conn.name}`, 'success');
    } catch (err) {
      this.toasts.error(err);
    }
  }

  async deleteConnection(conn: DbConnectionSummary): Promise<void> {
    if (!(await this.dialogs.confirm({ title: `Delete connection "${conn.name}"?`, message: 'Saved queries that reference it are kept.', danger: true, confirmLabel: 'Delete' }))) return;
    await this.host.invoke('db.connection.delete', { id: conn.id });
    this.tabs.closeWhere(this.scope(), (t) => (t.type === 'db.connection' && t.data?.['id'] === conn.id) || ((t.type === 'db.table' || t.type === 'db.redis') && t.data?.['connectionId'] === conn.id));
  }

  async renameQuery(query: SavedQuery): Promise<void> {
    const name = await this.dialogs.prompt({ title: 'Rename query', defaultValue: query.name, confirmLabel: 'Rename' });
    if (!name?.trim() || name === query.name) return;
    await this.host.invoke('db.query.save', { query: { ...query, name: name.trim() } });
    const scope = this.scope();
    const tab = untracked(() => this.tabs.scope(scope)).tabs.find((t) => t.type === 'db.query' && t.data?.['queryId'] === query.id);
    if (tab) this.tabs.updateTab(scope, tab.id, { title: name.trim() });
  }

  async deleteQuery(query: SavedQuery): Promise<void> {
    if (!(await this.dialogs.confirm({ title: `Delete query "${query.name}"?`, danger: true, confirmLabel: 'Delete' }))) return;
    await this.host.invoke('db.query.delete', { id: query.id });
    this.tabs.closeWhere(this.scope(), (t) => t.type === 'db.query' && t.data?.['queryId'] === query.id);
  }

  /** Keep a history entry as a saved query. */
  async saveFromHistory(entry: { text: string; connectionId: string; database: string | null }): Promise<SavedQuery | null> {
    const name = (await this.dialogs.prompt({ title: 'Save query', label: 'Name', defaultValue: firstLine(entry.text, 40), confirmLabel: 'Save' }))?.trim();
    if (!name) return null;
    try {
      const saved = await this.host.invoke<SavedQuery>('db.query.save', { query: { name, connectionId: entry.connectionId, database: entry.database, text: entry.text } });
      this.toasts.notify('Query saved', 'success');
      return saved;
    } catch (err) {
      this.toasts.error(err);
      return null;
    }
  }

  /** On a production connection, every write is confirmed first. True when the write may go ahead. */
  async confirmWrite(conn: { name: string; production: boolean }, what: string): Promise<boolean> {
    if (!conn.production) return true;
    return this.dialogs.confirm({ title: `Write to ${conn.name}?`, message: `This connection is marked as production. ${what}`, danger: true, confirmLabel: 'Run anyway' });
  }

  async clearHistory(): Promise<void> {
    if (await this.dialogs.confirm({ title: 'Clear query history?', danger: true, confirmLabel: 'Clear' })) await this.host.invoke('db.history.clear');
  }

  private scope(): string {
    return untracked(this.app.scope);
  }
}
