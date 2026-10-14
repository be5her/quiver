import { Service, inject, untracked } from '@angular/core';
import type { McpServerSummary, McpTransport } from '@quiver/core';
import { AppState, Dialogs, HostBridge, TabsState, Toasts } from '@quiver/ui';

export type ServerView = 'tools' | 'resources' | 'prompts' | 'log' | 'info' | 'settings';

const TRANSPORT_TITLE: Record<McpTransport, string> = { stdio: 'New command server (stdio)', http: 'New HTTP server', sse: 'New SSE server (legacy)' };

/** Opens, creates, imports, connects and deletes MCP servers. */
@Service()
export class McpActions {
  private readonly app = inject(AppState);
  private readonly host = inject(HostBridge);
  private readonly tabs = inject(TabsState);
  private readonly dialogs = inject(Dialogs);
  private readonly toasts = inject(Toasts);

  /** Open (or focus) the tab of a server; `view` steers it to a section. */
  openServerTab(server: { id: string; name: string }, view?: ServerView): void {
    const scope = untracked(this.app.scope);
    const tab = this.tabs.openTab(scope, { type: 'mcp.server', title: server.name, data: { id: server.id, view } }, { singletonKey: `mcp.server:${server.id}` });
    if (view) this.tabs.updateTab(scope, tab.id, { data: { ...tab.data, id: server.id, view, nonce: Date.now() } });
  }

  async createServer(transport: McpTransport = 'stdio'): Promise<void> {
    const name = await this.dialogs.prompt({
      title: TRANSPORT_TITLE[transport],
      label: 'Name',
      placeholder: transport === 'stdio' ? 'e.g. filesystem' : 'e.g. my api',
      confirmLabel: 'Create',
    });
    if (!name?.trim()) return;
    try {
      const created = await this.host.invoke<McpServerSummary>('mcp.server.save', { server: { name: name.trim(), transport } });
      this.openServerTab(created, 'settings');
    } catch (err) {
      this.toasts.error(err);
    }
  }

  /** Add Quiver's own MCP server bound to the active workspace, to see exactly what agents see. */
  async addThisQuiver(): Promise<void> {
    const config = untracked(this.app.config);
    const workspace = untracked(this.app.activeWorkspace);
    if (!config || !workspace) return;
    if (!config.mcp.enabled) {
      this.toasts.notify("Quiver's own MCP server is disabled in Settings", 'error');
      return;
    }
    try {
      const url = `http://127.0.0.1:${config.mcp.port}/mcp?workspace=${encodeURIComponent(workspace.path)}`;
      const created = await this.host.invoke<McpServerSummary>('mcp.server.save', { server: { name: 'Quiver (this app)', transport: 'http', url } });
      this.openServerTab(created, 'tools');
      const opened = await this.host.invoke<McpServerSummary>('mcp.connect', { id: created.id });
      if (opened.error && opened.status === 'disconnected') this.toasts.notify(opened.error, 'error');
    } catch (err) {
      this.toasts.error(err);
    }
  }

  async importServers(file?: string): Promise<void> {
    try {
      const imported = await this.host.invoke<McpServerSummary[]>('mcp.server.import', file ? { file } : {});
      if (imported.length === 0) this.toasts.notify(file ? `No servers found in ${file}` : 'No MCP config files found in the project', 'info');
      else this.toasts.notify(`Imported ${imported.length} server${imported.length === 1 ? '' : 's'}${file ? ` from ${file}` : ''}`, 'success');
      if (imported.length === 1) this.openServerTab(imported[0]);
    } catch (err) {
      this.toasts.error(err);
    }
  }

  async toggleServer(server: Pick<McpServerSummary, 'id' | 'status'>): Promise<void> {
    try {
      if (server.status === 'disconnected') {
        const opened = await this.host.invoke<McpServerSummary>('mcp.connect', { id: server.id });
        if (opened.error && opened.status === 'disconnected') this.toasts.notify(opened.error, 'error');
      } else {
        await this.host.invoke('mcp.disconnect', { id: server.id });
      }
    } catch (err) {
      this.toasts.error(err);
    }
  }

  async deleteServer(server: { id: string; name: string }): Promise<void> {
    if (!(await this.dialogs.confirm({ title: `Delete "${server.name}"?`, message: 'The server definition and its log are removed. A running stdio server is stopped.', danger: true, confirmLabel: 'Delete' }))) return;
    try {
      await this.host.invoke('mcp.server.delete', { id: server.id });
      this.tabs.closeWhere(untracked(this.app.scope), (t) => t.type === 'mcp.server' && t.data?.['id'] === server.id);
    } catch (err) {
      this.toasts.error(err);
    }
  }
}
