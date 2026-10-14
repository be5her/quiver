import { Component, computed, inject, input, signal } from '@angular/core';
import { skeletonFromSchema, toErrorPayload, type McpServerSummary, type McpTool, type McpToolCallOutcome } from '@quiver/core';
import { Button, EmptyState, HostBridge, Input, Spinner, Toasts } from '@quiver/ui';
import { RefreshCw } from 'lucide';
import { injectServerQuery } from './server-query';
import { McpToolDetail, type CallState } from './tool-detail';

/** The tools of a connected server, and the one being called. Arguments and the last result are kept per tool. */
@Component({
  selector: 'q-mcp-tools-view',
  imports: [Button, EmptyState, Input, McpToolDetail, Spinner],
  templateUrl: './tools-view.html',
  host: { class: 'contents' },
})
export class McpToolsView {
  private readonly host = inject(HostBridge);
  private readonly toasts = inject(Toasts);

  readonly server = input.required<McpServerSummary>();

  protected readonly refreshIcon = RefreshCw;
  protected readonly tools = injectServerQuery<McpTool[]>('mcp.tool.list', () => ({ id: this.server().id }), this.server, ['lists', 'status']);
  protected readonly selectedName = signal<string | null>(null);
  protected readonly filter = signal('');
  private readonly argsByTool = signal<Record<string, string>>({});
  private readonly calls = signal<Record<string, CallState>>({});
  private readonly busyTool = signal<string | null>(null);

  protected readonly list = computed(() => this.tools.value() ?? []);
  protected readonly filtered = computed(() => {
    const needle = this.filter().trim().toLowerCase();
    return needle ? this.list().filter((t) => `${t.name} ${t.title ?? ''} ${t.description ?? ''}`.toLowerCase().includes(needle)) : this.list();
  });
  protected readonly selected = computed(() => this.list().find((t) => t.name === this.selectedName()) ?? null);
  protected readonly argsText = computed(() => {
    const tool = this.selected();
    return tool ? (this.argsByTool()[tool.name] ?? JSON.stringify(skeletonFromSchema(tool.inputSchema) ?? {}, null, 2)) : '';
  });
  protected readonly callState = computed(() => {
    const tool = this.selected();
    return tool ? (this.calls()[tool.name] ?? null) : null;
  });
  protected readonly busy = computed(() => this.busyTool() !== null && this.busyTool() === this.selectedName());

  protected typed(event: Event): void {
    this.filter.set((event.target as HTMLInputElement).value);
  }

  protected setArgs(name: string, text: string): void {
    this.argsByTool.update((all) => ({ ...all, [name]: text }));
  }

  protected async refresh(): Promise<void> {
    try {
      await this.host.invoke('mcp.tool.list', { id: this.server().id, refresh: true });
      this.tools.reload();
    } catch (err) {
      this.toasts.error(err);
    }
  }

  protected async call(tool: McpTool): Promise<void> {
    let args: Record<string, unknown>;
    try {
      const text = this.argsText();
      const parsed: unknown = text.trim() ? JSON.parse(text) : {};
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Arguments must be a JSON object');
      args = parsed as Record<string, unknown>;
    } catch (err) {
      this.toasts.notify(`Arguments: ${(err as Error).message}`, 'error');
      return;
    }
    this.busyTool.set(tool.name);
    try {
      const outcome = await this.host.invoke<McpToolCallOutcome>('mcp.tool.call', { id: this.server().id, name: tool.name, arguments: args });
      this.calls.update((c) => ({ ...c, [tool.name]: { at: new Date().toISOString(), outcome, error: null } }));
    } catch (err) {
      this.calls.update((c) => ({ ...c, [tool.name]: { at: new Date().toISOString(), outcome: null, error: toErrorPayload(err).message } }));
    } finally {
      this.busyTool.set(null);
    }
  }
}
