import { newId, type DbConnectionSummary, type DbKind } from '@quiver/core';
import { defineModuleUI, invoke, selectScope, useAppStore, useTabsStore } from '@quiver/ui';
import { Database } from 'lucide-react';
import { ConnectionTab } from './ConnectionTab';
import { QueryTab } from './QueryTab';
import { RedisTab } from './RedisTab';
import { DbSidebar } from './Sidebar';
import { TableTab } from './TableTab';
import { firstLine } from './shared';
import { expandNode } from './tree-store';

const scopeNow = () => selectScope(useAppStore.getState());
const hasWorkspace = () => useAppStore.getState().activeWorkspaceId !== null;

export function openConnectionTab(conn: { id: string; name: string }): void {
  useTabsStore.getState().openTab(scopeNow(), { type: 'db.connection', title: conn.name, data: { id: conn.id } }, { singletonKey: `db.connection:${conn.id}` });
}

/** One draft tab per kind; it turns into the real connection's tab on save. */
export function openNewConnectionTab(kind: DbKind = 'mysql'): void {
  useTabsStore.getState().openTab(scopeNow(), { type: 'db.connection', title: 'New connection', data: { id: `new-${kind}`, kind } }, { singletonKey: `db.connection:new-${kind}` });
}

export interface OpenQueryOptions {
  queryId?: string;
  connectionId?: string | null;
  database?: string | null;
  text?: string;
  title?: string;
}

export function openQueryTab(options: OpenQueryOptions = {}): void {
  const id = options.queryId ?? newId();
  useTabsStore.getState().openTab(
    scopeNow(),
    {
      type: 'db.query',
      title: options.title ?? (options.text ? firstLine(options.text, 32) : 'Query'),
      data: { id, queryId: options.queryId, connectionId: options.connectionId ?? null, database: options.database ?? null, text: options.text ?? '' },
    },
    options.queryId ? { singletonKey: `db.query:${options.queryId}` } : undefined,
  );
}

export function openTableTab(connectionId: string, table: string, database: string | null): void {
  const id = `${connectionId}:${database ?? ''}:${table}`;
  useTabsStore.getState().openTab(scopeNow(), { type: 'db.table', title: table, data: { id, connectionId, table, database } }, { singletonKey: `db.table:${id}` });
}

/** Switch to the Databases module and expand a connection in its tree. */
export function revealDbConnection(conn: { id: string; name: string; kind: DbKind }): void {
  useAppStore.getState().setActiveModule('db');
  expandNode(`conn/${conn.id}`);
  if (conn.kind === 'redis') openRedisTab(conn);
  else openQueryTab({ connectionId: conn.id, title: conn.name });
}

export function openRedisTab(conn: { id: string; name: string }): void {
  useTabsStore.getState().openTab(scopeNow(), { type: 'db.redis', title: `${conn.name} keys`, data: { id: conn.id, connectionId: conn.id } }, { singletonKey: `db.redis:${conn.id}` });
}

async function newQueryForFirstConnection(): Promise<void> {
  const connections = await invoke<DbConnectionSummary[]>('db.connection.list');
  openQueryTab({ connectionId: connections[0]?.id ?? null });
}

export const dbModuleUI = defineModuleUI({
  id: 'db',
  title: 'Databases',
  icon: Database,
  order: 20,
  availability: 'workspace',
  Sidebar: DbSidebar,
  tabs: {
    'db.connection': ConnectionTab,
    'db.query': QueryTab,
    'db.table': TableTab,
    'db.redis': RedisTab,
  },
  actions: [
    { id: 'db.connection.new', title: 'New database connection', group: 'Databases', run: () => openNewConnectionTab('mysql'), when: hasWorkspace },
    { id: 'db.query.new', title: 'New query', group: 'Databases', shortcut: 'Ctrl+Shift+Q', run: () => newQueryForFirstConnection(), when: hasWorkspace },
  ],
});
