import { Component, computed, inject, input, signal } from '@angular/core';
import { FormField, form } from '@angular/forms/signals';
import type { McpServerSummary } from '@quiver/core';
import { Button, CodeEditor, HostBridge, Input, Toasts, formatMs } from '@quiver/ui';
import { Send } from 'lucide';

/** Any JSON-RPC method with optional params, for what the tabs above do not cover. */
@Component({
  selector: 'q-mcp-raw-request',
  imports: [Button, CodeEditor, FormField, Input],
  template: `
    <div class="w-52 shrink-0">
      <input qInput [formField]="requestForm.method" placeholder="method, e.g. ping" class="font-mono h-7 text-xs" data-testid="mcp-raw-method" />
    </div>
    <div class="flex-1 min-w-0 h-7 border border-edge rounded-md">
      <q-code-editor [formField]="requestForm.params" language="json" fill [placeholder]="paramsPlaceholder" (run)="send()" />
    </div>
    <button qButton size="sm" variant="secondary" [icon]="sendIcon" [loading]="sending()" [disabled]="!connected()" title="Send a raw JSON-RPC request (Ctrl+Enter)" data-testid="mcp-raw-send" (click)="send()">Send</button>
  `,
  host: { class: 'border-t border-edge shrink-0 flex items-end gap-2 p-2', 'data-testid': 'mcp-raw-request' },
})
export class McpRawRequest {
  private readonly host = inject(HostBridge);
  private readonly toasts = inject(Toasts);

  readonly server = input.required<McpServerSummary>();

  protected readonly sendIcon = Send;
  protected readonly paramsPlaceholder = 'params, e.g. {"level":"debug"}';
  protected readonly request = signal({ method: 'ping', params: '' });
  protected readonly requestForm = form(this.request);
  protected readonly sending = signal(false);
  protected readonly connected = computed(() => this.server().status === 'connected');

  protected async send(): Promise<void> {
    const method = this.request().method.trim();
    const params = this.request().params;
    if (!this.connected() || this.sending() || !method) return;
    let parsed: Record<string, unknown> | undefined;
    try {
      parsed = params.trim() ? (JSON.parse(params) as Record<string, unknown>) : undefined;
    } catch (err) {
      this.toasts.notify(`Params: ${(err as Error).message}`, 'error');
      return;
    }
    this.sending.set(true);
    try {
      const out = await this.host.invoke<{ result: unknown; durationMs: number }>('mcp.request', { id: this.server().id, method, params: parsed });
      this.toasts.notify(`${method} answered in ${formatMs(out.durationMs)}`, 'success');
    } catch (err) {
      this.toasts.error(err);
    } finally {
      this.sending.set(false);
    }
  }
}
