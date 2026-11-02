import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormField, form } from '@angular/forms/signals';
import { DEFAULT_SCAN_PORTS, parsePorts, sortByAddress, toErrorPayload, type NetScanHost, type NetScanSubnet } from '@quiver/core';
import { Badge, Button, HostBridge, Input, invokeResource, injectHostEvent } from '@quiver/ui';

/** What `tools.netscan.run` returns, as far as the tab reads it. */
interface NetScanResult {
  scanId: string;
  target: string;
  scanned: number;
  total: number;
  hosts: NetScanHost[];
  durationMs: number;
  cancelled: boolean;
}

const FOUND_BY: Record<NetScanHost['foundBy'][number], string> = { ping: 'ping', tcp: 'TCP', arp: 'ARP table' };

/**
 * The network scanner: a target (this machine's networks are offered) and the ports in the header; the machines found
 * below, as they answer. Not live: each scan sends traffic to every address in the target.
 */
@Component({
  selector: 'q-net-scan',
  imports: [Badge, Button, FormField, Input],
  template: `
    <div class="flex flex-col gap-2 px-3 py-2 border-b border-edge shrink-0">
      <div class="flex items-center gap-2">
        <span class="text-sm font-medium shrink-0">Network scanner</span>
        <input qInput class="h-7 text-xs font-mono flex-[2] min-w-40" list="netscan-subnets" placeholder="192.168.1.0/24, 192.168.1.10-50 or 192.168.1.7" title="An address, a subnet or a range on a private network, 4096 addresses at most" [formField]="scanForm.target" data-testid="netscan-target" (keydown.enter)="scan()" />
        <datalist id="netscan-subnets">
          @for (s of subnets.value() ?? []; track s.name + s.address) {
            <option [value]="s.target">{{ s.name }} · {{ s.address }}</option>
          }
        </datalist>
        <input qInput class="h-7 text-xs font-mono flex-[3] min-w-32" placeholder="Ports to try; empty only pings" title="TCP ports to try on each address, separated by commas or spaces. Empty only pings." [formField]="scanForm.ports" data-testid="netscan-ports" (keydown.enter)="scan()" />
        @if (running()) {
          <button qButton variant="secondary" size="sm" class="shrink-0" data-testid="netscan-stop" (click)="stop()">Stop</button>
        } @else {
          <button qButton variant="primary" size="sm" class="shrink-0" data-testid="netscan-run" (click)="scan()">Scan</button>
        }
      </div>
      @if (running() || progress().total) {
        <div class="flex items-center gap-2 text-[11px] text-muted" data-testid="netscan-progress">
          <div class="flex-1 h-1 rounded-full bg-edge overflow-hidden"><div class="h-full bg-accent" [style.width.%]="percent()"></div></div>
          <span class="shrink-0">{{ progress().done }} of {{ progress().total }}</span>
        </div>
      }
    </div>
    <div class="@container flex-1 min-h-0 overflow-auto p-3 flex flex-col gap-2" data-testid="netscan-output">
      @if (error(); as error) {
        <p class="text-xs text-danger" data-testid="netscan-error">{{ error }}</p>
      }
      @if (hosts().length) {
        <div class="text-xs text-muted" data-testid="netscan-meta">{{ summary() }}</div>
        <table class="w-full text-xs">
          <thead class="text-muted text-left">
            <tr class="border-b border-edge">
              <th class="py-1 pr-4 font-medium w-px whitespace-nowrap">Address</th>
              <th class="py-1 pr-4 font-medium">Name</th>
              <th class="py-1 pr-4 font-medium w-px whitespace-nowrap">MAC</th>
              <th class="py-1 pr-4 font-medium w-px text-right whitespace-nowrap">Latency</th>
              <th class="py-1 pr-4 font-medium">Open ports</th>
              <th class="py-1 font-medium w-px whitespace-nowrap">Found by</th>
            </tr>
          </thead>
          <tbody class="font-mono select-text">
            @for (h of hosts(); track h.address) {
              <tr class="border-b border-edge/60 align-top" data-testid="netscan-row" [attr.data-address]="h.address">
                <td class="py-1 pr-4 whitespace-nowrap">{{ h.address }}</td>
                <td class="py-1 pr-4 break-all">{{ h.hostname ?? '' }}</td>
                <td class="py-1 pr-4 whitespace-nowrap">{{ h.mac ?? '' }}</td>
                <td class="py-1 pr-4 text-right whitespace-nowrap">{{ h.latencyMs === null ? '—' : h.latencyMs + ' ms' }}</td>
                <td class="py-1 pr-4">
                  <span class="flex flex-wrap gap-1">
                    @for (p of h.openPorts; track p) {
                      <span qBadge data-testid="netscan-port">{{ p }}</span>
                    }
                  </span>
                </td>
                <td class="py-1 whitespace-nowrap font-sans text-muted">{{ foundBy(h) }}</td>
              </tr>
            }
          </tbody>
        </table>
      } @else if (running()) {
        <p class="text-xs text-muted">Nothing has answered yet.</p>
      } @else if (result(); as r) {
        <p class="text-xs text-muted" data-testid="netscan-empty">Nothing answered in {{ r.target }}{{ r.cancelled ? ' before the scan was stopped' : '' }}. A firewall that drops everything hides a machine.</p>
      } @else if (!error()) {
        <p class="text-xs text-muted">Pick one of this machine's networks, or type an address or a range on a private network, and press Enter. It pings each address and tries each port, which a security system on the network may notice.</p>
      }
    </div>
  `,
  host: { class: 'flex flex-col h-full min-h-0', 'data-testid': 'net-scan-tool' },
})
export class NetScan {
  private readonly host = inject(HostBridge);

  protected readonly subnets = invokeResource<NetScanSubnet[]>('tools.netscan.interfaces', () => ({}), { workspaceId: null });
  protected readonly scanForm = form(signal({ target: '', ports: DEFAULT_SCAN_PORTS.join(', ') }));
  protected readonly running = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly result = signal<NetScanResult | null>(null);
  protected readonly progress = signal({ done: 0, total: 0 });
  protected readonly hosts = signal<NetScanHost[]>([]);
  private scanId: string | null = null;

  protected readonly percent = computed(() => {
    const { done, total } = this.progress();
    return total ? (done / total) * 100 : 0;
  });

  protected readonly summary = computed(() => {
    const count = this.hosts().length;
    const hosts = `${count} host${count === 1 ? '' : 's'}`;
    const r = this.result();
    if (!r) return `${hosts} so far`;
    const seconds = (r.durationMs / 1000).toFixed(1);
    return r.cancelled ? `${hosts} in ${r.scanned} of ${r.total} addresses of ${r.target}, stopped after ${seconds} s` : `${hosts} in ${r.target} (${r.total} address${r.total === 1 ? '' : 'es'}), ${seconds} s`;
  });

  constructor() {
    // The likeliest network to begin with, unless something has been typed.
    effect(() => {
      const first = this.subnets.value()?.[0];
      if (first && !untracked(() => this.scanForm.target().value())) this.scanForm.target().value.set(first.target);
    });
    injectHostEvent('tools.netscan.progress', (p) => {
      if (p.scanId !== this.scanId) return;
      this.progress.set({ done: p.done, total: p.total });
      const found = p.host;
      if (found) this.hosts.update((list) => sortByAddress([...list.filter((h) => h.address !== found.address), found]));
    });
  }

  protected foundBy(host: NetScanHost): string {
    return host.foundBy.map((f) => FOUND_BY[f]).join(', ');
  }

  protected async scan(): Promise<void> {
    if (this.running()) return;
    const { target, ports } = this.scanForm().value();
    if (!target.trim()) return;
    this.running.set(true);
    this.error.set(null);
    this.result.set(null);
    this.hosts.set([]);
    this.progress.set({ done: 0, total: 0 });
    const scanId = crypto.randomUUID();
    this.scanId = scanId;
    try {
      const result = await this.host.invoke<NetScanResult>('tools.netscan.run', { target, ports: parsePorts(ports), scanId }, null);
      this.result.set(result);
      this.hosts.set(result.hosts);
      this.progress.set({ done: result.scanned, total: result.total });
    } catch (err) {
      this.error.set(toErrorPayload(err).message);
      this.progress.set({ done: 0, total: 0 });
    } finally {
      this.running.set(false);
      this.scanId = null;
    }
  }

  protected stop(): void {
    if (this.scanId) void this.host.invoke('tools.netscan.cancel', { scanId: this.scanId }, null);
  }
}
