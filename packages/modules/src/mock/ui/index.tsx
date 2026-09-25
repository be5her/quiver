import { toErrorPayload, type MockServerSummary } from '@quiver/core';
import { confirmDialog, defineModuleUI, invoke, notify, promptDialog, selectScope, useAppStore, useTabsStore } from '@quiver/ui';
import { Server } from 'lucide-react';
import { ServerTab } from './ServerTab';
import { MockSidebar } from './Sidebar';

export type ServerView = 'routes' | 'requests' | 'settings';
export type ServerKind = 'mock' | 'webhook';

const scopeNow = () => selectScope(useAppStore.getState());
const hasWorkspace = () => useAppStore.getState().activeWorkspaceId !== null;

/** Open (or focus) the tab of a server; `view` and `routeId` steer it to a section. */
export function openServerTab(server: { id: string; name: string }, view?: ServerView, routeId?: string): void {
  const tabs = useTabsStore.getState();
  const scope = scopeNow();
  const tab = tabs.openTab(scope, { type: 'mock.server', title: server.name, data: { id: server.id, view, routeId } }, { singletonKey: `mock.server:${server.id}` });
  if (view || routeId) tabs.updateTab(scope, tab.id, { data: { ...tab.data, id: server.id, view, routeId, nonce: Date.now() } });
}

/** A webhook receiver is a server with no routes that answers 200 to everything. */
export async function createServer(kind: ServerKind = 'mock'): Promise<void> {
  const name = await promptDialog({
    title: kind === 'webhook' ? 'New webhook receiver' : 'New mock server',
    label: 'Name',
    placeholder: kind === 'webhook' ? 'e.g. Stripe webhooks' : 'e.g. payments API',
    confirmLabel: 'Create',
  });
  if (!name?.trim()) return;
  try {
    const server = await invoke<MockServerSummary>('mock.server.save', {
      server: {
        name: name.trim(),
        autoStart: kind === 'webhook',
        fallback: kind === 'webhook' ? { type: 'respond', status: 200, headers: [], body: '{"ok":true}' } : { type: 'respond', status: 404, headers: [], body: '{"error":"no mock route matched"}' },
      },
    });
    try {
      await invoke('mock.server.start', { id: server.id });
    } catch (err) {
      notify(toErrorPayload(err).message, 'error');
    }
    openServerTab(server, kind === 'webhook' ? 'requests' : 'routes');
  } catch (err) {
    notify(toErrorPayload(err).message, 'error');
  }
}

export async function toggleServer(server: Pick<MockServerSummary, 'id' | 'running'>): Promise<void> {
  try {
    await invoke(server.running ? 'mock.server.stop' : 'mock.server.start', { id: server.id });
  } catch (err) {
    notify(toErrorPayload(err).message, 'error');
  }
}

export async function deleteServer(server: { id: string; name: string }): Promise<void> {
  if (!(await confirmDialog({ title: `Delete "${server.name}"?`, message: 'Its routes and captured requests are removed.', danger: true, confirmLabel: 'Delete' }))) return;
  try {
    await invoke('mock.server.delete', { id: server.id });
    useTabsStore.getState().closeWhere(scopeNow(), (t) => t.type === 'mock.server' && t.data?.id === server.id);
  } catch (err) {
    notify(toErrorPayload(err).message, 'error');
  }
}

export const mockModuleUI = defineModuleUI({
  id: 'mock',
  title: 'Mock servers',
  icon: Server,
  order: 30,
  availability: 'workspace',
  Sidebar: MockSidebar,
  tabs: {
    'mock.server': ServerTab,
  },
  actions: [
    { id: 'mock.server.new', title: 'New mock server', group: 'Mock servers', run: () => createServer('mock'), when: hasWorkspace },
    { id: 'mock.webhook.new', title: 'New webhook receiver', group: 'Mock servers', run: () => createServer('webhook'), when: hasWorkspace },
  ],
});
