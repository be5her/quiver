import { Component, computed, input } from '@angular/core';
import { capabilityLabels, describeMcpServer, type McpServerSummary } from '@quiver/core';
import { Badge, Label } from '@quiver/ui';

/** What the server announced in the handshake: who it is, its protocol, capabilities and instructions. */
@Component({
  selector: 'q-mcp-info-view',
  imports: [Badge, Label],
  template: `
    @let s = summary();
    <section class="grid grid-cols-[10rem_1fr] gap-x-3 gap-y-1.5 text-xs">
      <span class="text-muted">Server</span>
      <span>{{ serverLabel() }}</span>
      <span class="text-muted">Protocol version</span>
      <span class="font-mono">{{ s.protocolVersion ?? '–' }}</span>
      <span class="text-muted">Transport</span>
      <span class="font-mono break-all">{{ transport() }}</span>
      @if (s.pid !== null) {
        <span class="text-muted">Process id</span>
        <span class="font-mono">{{ s.pid }}</span>
      }
      <span class="text-muted">Connected since</span>
      <span>{{ connectedAt() }}</span>
      @if (s.importedFrom) {
        <span class="text-muted">Imported from</span>
        <span class="font-mono">{{ s.importedFrom }}</span>
      }
    </section>
    <section>
      <label qLabel>Capabilities</label>
      <div class="flex flex-wrap gap-1" data-testid="mcp-capabilities">
        @for (l of labels(); track l) {
          <span qBadge>{{ l }}</span>
        } @empty {
          <span class="text-xs text-muted">{{ s.status === 'connected' ? 'The server announced no capabilities.' : 'Connect to see what the server offers.' }}</span>
        }
      </div>
    </section>
    <section>
      <label qLabel>Instructions for agents</label>
      @if (s.instructions) {
        <p class="text-xs whitespace-pre-wrap rounded-md border border-edge bg-surface px-2 py-1.5" data-testid="mcp-instructions">{{ s.instructions }}</p>
      } @else {
        <span class="text-xs text-muted">None.</span>
      }
    </section>
    @if (s.capabilities) {
      <section>
        <label qLabel>Raw capabilities</label>
        <pre class="text-[11px] font-mono rounded-md border border-edge bg-surface px-2 py-1.5 overflow-x-auto">{{ rawCapabilities() }}</pre>
      </section>
    }
  `,
  host: { class: 'flex flex-col gap-4 p-3 overflow-y-auto h-full max-w-3xl text-sm', 'data-testid': 'mcp-info' },
})
export class McpInfoView {
  readonly summary = input.required<McpServerSummary>();

  protected readonly labels = computed(() => capabilityLabels(this.summary().capabilities));
  protected readonly transport = computed(() => describeMcpServer(this.summary()));
  protected readonly rawCapabilities = computed(() => JSON.stringify(this.summary().capabilities, null, 2));
  protected readonly connectedAt = computed(() => {
    const at = this.summary().connectedAt;
    return at ? new Date(at).toLocaleString() : '–';
  });
  protected readonly serverLabel = computed(() => {
    const s = this.summary();
    const info = s.serverInfo;
    if (!info) return s.status === 'connected' ? 'unknown' : 'not connected';
    return `${info.title ?? info.name} ${info.version}${info.title ? ` (${info.name})` : ''}`;
  });
}
