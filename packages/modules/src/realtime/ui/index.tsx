import { toErrorPayload, type RealtimeConnectionSummary, type RealtimeKind } from '@quiver/core';
import { confirmDialog, defineModuleUI, invoke, notify, promptDialog, selectScope, useAppStore, useTabsStore } from '@quiver/ui';
import { Radio } from 'lucide-react';
import { ConnectionTab } from './ConnectionTab';
import { RealtimeSidebar } from './Sidebar';

export type ConnectionView = 'messages' | 'headers' | 'auth' | 'saved' | 'settings';

const scopeNow = () => selectScope(useAppStore.getState());
const hasWorkspace = () => useAppStore.getState().activeWorkspaceId !== null;

export function openConnectionTab(conn: { id: string; name: string }, view?: ConnectionView): void {
  const tabs = useTabsStore.getState();
  const scope = scopeNow();
  const tab = tabs.openTab(scope, { type: 'realtime.connection', title: conn.name, data: { id: conn.id, view } }, { singletonKey: `realtime.connection:${conn.id}` });
  if (view) tabs.updateTab(scope, tab.id, { data: { ...tab.data, id: conn.id, view, nonce: Date.now() } });
}

export async function createConnection(kind: RealtimeKind = 'websocket'): Promise<void> {
  const name = await promptDialog({
    title: kind === 'sse' ? 'New event stream (SSE)' : 'New WebSocket connection',
    label: 'Name',
    placeholder: kind === 'sse' ? 'e.g. order updates' : 'e.g. chat gateway',
    confirmLabel: 'Create',
  });
  if (!name?.trim()) return;
  try {
    const created = await invoke<RealtimeConnectionSummary>('realtime.connection.save', { connection: { name: name.trim(), kind, url: '' } });
    openConnectionTab(created, 'messages');
  } catch (err) {
    notify(toErrorPayload(err).message, 'error');
  }
}

export async function toggleConnection(conn: Pick<RealtimeConnectionSummary, 'id' | 'status'>): Promise<void> {
  try {
    if (conn.status === 'disconnected') {
      const opened = await invoke<RealtimeConnectionSummary>('realtime.connect', { id: conn.id });
      if (opened.error && opened.status === 'disconnected') notify(opened.error, 'error');
    } else {
      await invoke('realtime.disconnect', { id: conn.id });
    }
  } catch (err) {
    notify(toErrorPayload(err).message, 'error');
  }
}

export async function deleteConnection(conn: { id: string; name: string }): Promise<void> {
  if (!(await confirmDialog({ title: `Delete "${conn.name}"?`, message: 'The connection and its message log are removed.', danger: true, confirmLabel: 'Delete' }))) return;
  try {
    await invoke('realtime.connection.delete', { id: conn.id });
    useTabsStore.getState().closeWhere(scopeNow(), (t) => t.type === 'realtime.connection' && t.data?.id === conn.id);
  } catch (err) {
    notify(toErrorPayload(err).message, 'error');
  }
}

export const realtimeModuleUI = defineModuleUI({
  id: 'realtime',
  title: 'Realtime',
  icon: Radio,
  order: 15,
  availability: 'workspace',
  Sidebar: RealtimeSidebar,
  tabs: {
    'realtime.connection': ConnectionTab,
  },
  actions: [
    { id: 'realtime.websocket.new', title: 'New WebSocket connection', group: 'Realtime', run: () => createConnection('websocket'), when: hasWorkspace },
    { id: 'realtime.sse.new', title: 'New event stream (SSE)', group: 'Realtime', run: () => createConnection('sse'), when: hasWorkspace },
  ],
});
