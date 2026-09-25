import { toErrorPayload, type McpServerSummary, type McpTransport } from '@quiver/core';
import { confirmDialog, defineModuleUI, invoke, notify, promptDialog, selectActiveWorkspace, selectScope, useAppStore, useTabsStore } from '@quiver/ui';
import { Plug } from 'lucide-react';
import { ServerTab } from './ServerTab';
import { McpSidebar } from './Sidebar';

export type ServerView = 'tools' | 'resources' | 'prompts' | 'log' | 'info' | 'settings';

const scopeNow = () => selectScope(useAppStore.getState());
const hasWorkspace = () => useAppStore.getState().activeWorkspaceId !== null;

export function openServerTab(server: { id: string; name: string }, view?: ServerView): void {
  const tabs = useTabsStore.getState();
  const scope = scopeNow();
  const tab = tabs.openTab(scope, { type: 'mcp.server', title: server.name, data: { id: server.id, view } }, { singletonKey: `mcp.server:${server.id}` });
  if (view) tabs.updateTab(scope, tab.id, { data: { ...tab.data, id: server.id, view, nonce: Date.now() } });
}

const TRANSPORT_TITLE: Record<McpTransport, string> = { stdio: 'New command server (stdio)', http: 'New HTTP server', sse: 'New SSE server (legacy)' };

export async function createServer(transport: McpTransport = 'stdio'): Promise<void> {
  const name = await promptDialog({
    title: TRANSPORT_TITLE[transport],
    label: 'Name',
    placeholder: transport === 'stdio' ? 'e.g. filesystem' : 'e.g. my api',
    confirmLabel: 'Create',
  });
  if (!name?.trim()) return;
  try {
    const created = await invoke<McpServerSummary>('mcp.server.save', { server: { name: name.trim(), transport } });
    openServerTab(created, 'settings');
  } catch (err) {
    notify(toErrorPayload(err).message, 'error');
  }
}

/** Add Quiver's own MCP server bound to the active workspace, to see exactly what agents see. */
export async function addThisQuiver(): Promise<void> {
  const state = useAppStore.getState();
  const config = state.config;
  const workspace = selectActiveWorkspace(state);
  if (!config || !workspace) return;
  if (!config.mcp.enabled) {
    notify("Quiver's own MCP server is disabled in Settings", 'error');
    return;
  }
  try {
    const url = `http://127.0.0.1:${config.mcp.port}/mcp?workspace=${encodeURIComponent(workspace.path)}`;
    const created = await invoke<McpServerSummary>('mcp.server.save', { server: { name: 'Quiver (this app)', transport: 'http', url } });
    openServerTab(created, 'tools');
    const opened = await invoke<McpServerSummary>('mcp.connect', { id: created.id });
    if (opened.error && opened.status === 'disconnected') notify(opened.error, 'error');
  } catch (err) {
    notify(toErrorPayload(err).message, 'error');
  }
}

export async function importServers(file?: string): Promise<void> {
  try {
    const imported = await invoke<McpServerSummary[]>('mcp.server.import', file ? { file } : {});
    if (imported.length === 0) notify(file ? `No servers found in ${file}` : 'No MCP config files found in the project', 'info');
    else notify(`Imported ${imported.length} server${imported.length === 1 ? '' : 's'}${file ? ` from ${file}` : ''}`, 'success');
    if (imported.length === 1) openServerTab(imported[0]);
  } catch (err) {
    notify(toErrorPayload(err).message, 'error');
  }
}

export async function toggleServer(server: Pick<McpServerSummary, 'id' | 'status'>): Promise<void> {
  try {
    if (server.status === 'disconnected') {
      const opened = await invoke<McpServerSummary>('mcp.connect', { id: server.id });
      if (opened.error && opened.status === 'disconnected') notify(opened.error, 'error');
    } else {
      await invoke('mcp.disconnect', { id: server.id });
    }
  } catch (err) {
    notify(toErrorPayload(err).message, 'error');
  }
}

export async function deleteServer(server: { id: string; name: string }): Promise<void> {
  if (!(await confirmDialog({ title: `Delete "${server.name}"?`, message: 'The server definition and its log are removed. A running stdio server is stopped.', danger: true, confirmLabel: 'Delete' }))) return;
  try {
    await invoke('mcp.server.delete', { id: server.id });
    useTabsStore.getState().closeWhere(scopeNow(), (t) => t.type === 'mcp.server' && t.data?.id === server.id);
  } catch (err) {
    notify(toErrorPayload(err).message, 'error');
  }
}

export const mcpModuleUI = defineModuleUI({
  id: 'mcp',
  title: 'MCP inspector',
  icon: Plug,
  order: 40,
  availability: 'workspace',
  Sidebar: McpSidebar,
  tabs: {
    'mcp.server': ServerTab,
  },
  actions: [
    { id: 'mcp.server.new', title: 'New MCP server (command)', group: 'MCP inspector', run: () => createServer('stdio'), when: hasWorkspace },
    { id: 'mcp.server.newHttp', title: 'New MCP server (HTTP)', group: 'MCP inspector', run: () => createServer('http'), when: hasWorkspace },
    { id: 'mcp.server.import', title: 'Import MCP servers from project files', group: 'MCP inspector', run: () => importServers(), when: hasWorkspace },
    { id: 'mcp.server.self', title: "Inspect Quiver's own MCP server", group: 'MCP inspector', run: () => addThisQuiver(), when: hasWorkspace },
  ],
});
