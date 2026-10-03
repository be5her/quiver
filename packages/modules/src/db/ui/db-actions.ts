import { Service, inject, untracked } from '@angular/core';
import { newId, type DbConnectionSummary, type DbKind, type SavedQuery } from '@quiver/core';
import { AppState, Dialogs, HostBridge, TabsState, TreeState } from '@quiver/ui';
import { firstLine } from './db-format';

export interface OpenQueryOptions {
  queryId?: string;
  connectionId?: string | null;
  database?: string | null;
  text?: string;
  title?: string;
}

/** Opens the Databases module's tabs and runs its sidebar actions. */
@Service()
export class DbActions {
  private readonly app = inject(AppState);
  private readonly host = inject(HostBridge);
  private readonly tabs = inject(TabsState);
  private readonly tree = inject(TreeState);
  private readonly dialogs = inject(Dialogs);

  openConnectionTab(conn: { id: string; name: string }): void {
    this.tabs.openTab(this.scope(), { type: 'db.connection', title: conn.name, data: { id: conn.id } }, { singletonKey: `db.connection:${conn.id}` });
  }

  /** One draft tab per kind; it turns into the real connection's tab on save. */
  openNewConnectionTab(kind: DbKind = 'mysql'): void {
    this.tabs.openTab(this.scope(), { type: 'db.connection', title: 'New connection', data: { id: `new-${kind}`, kind } }, { singletonKey: `db.connection:new-${kind}` });
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

  openTableTab(connectionId: string, table: string, database: string | null): void {
    const id = `${connectionId}:${database ?? ''}:${table}`;
    this.tabs.openTab(this.scope(), { type: 'db.table', title: table, data: { id, connectionId, table, database } }, { singletonKey: `db.table:${id}` });
  }

  openRedisTab(conn: { id: string; name: string }): void {
    this.tabs.openTab(this.scope(), { type: 'db.redis', title: `${conn.name} keys`, data: { id: conn.id, connectionId: conn.id } }, { singletonKey: `db.redis:${conn.id}` });
  }

  /** Switch to the Databases module and expand a connection in its tree. */
  revealConnection(conn: { id: string; name: string; kind: DbKind }): void {
    this.app.setActiveModule('db');
    this.tree.expand(`conn/${conn.id}`);
    if (conn.kind === 'redis') this.openRedisTab(conn);
    else this.openQueryTab({ connectionId: conn.id, title: conn.name });
  }

  async newQueryForFirstConnection(): Promise<void> {
    const connections = await this.host.invoke<DbConnectionSummary[]>('db.connection.list');
    this.openQueryTab({ connectionId: connections[0]?.id ?? null });
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

  async clearHistory(): Promise<void> {
    if (await this.dialogs.confirm({ title: 'Clear query history?', danger: true, confirmLabel: 'Clear' })) await this.host.invoke('db.history.clear');
  }

  private scope(): string {
    return untracked(this.app.scope);
  }
}
