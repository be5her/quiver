import { Component, computed, inject, signal } from '@angular/core';
import { FormField, form } from '@angular/forms/signals';
import { DEFAULT_DNS_TYPES, DNS_RECORD_TYPES, formatDnsData, groupDnsRecords, toErrorPayload, type DnsRecord, type DnsRecordType } from '@quiver/core';
import { Button, HostBridge, Input } from '@quiver/ui';

/** What `tools.dns.lookup` returns, as far as the tab reads it. */
interface DnsLookupResult {
  name: string;
  asciiName: string;
  server: { address: string; port: number; source: 'custom' | 'system' };
  types: DnsRecordType[];
  records: DnsRecord[];
  chain: { name: string; target: string }[];
  reverse?: { address: string; names: string[] };
  empty: { type: string; code: 'ENODATA' | 'ENOTFOUND' }[];
  errors: { type: string; code: string; message: string }[];
  durationMs: number;
}

interface Column {
  label: string;
  value: (r: DnsRecord) => string;
  /** Right-aligned numbers. */
  numeric?: boolean;
}

const field = (key: string) => (r: DnsRecord) => String((r.data as unknown as Record<string, unknown>)[key] ?? '');

/** The columns after name and TTL, per type. */
const COLUMNS: Record<string, Column[]> = {
  A: [{ label: 'Address', value: field('address') }],
  AAAA: [{ label: 'Address', value: field('address') }],
  CNAME: [{ label: 'Target', value: field('target') }],
  NS: [{ label: 'Name server', value: field('target') }],
  PTR: [{ label: 'Points to', value: field('target') }],
  MX: [
    { label: 'Priority', value: field('priority'), numeric: true },
    { label: 'Exchange', value: field('exchange') },
  ],
  TXT: [{ label: 'Text', value: (r) => formatDnsData('TXT', r.data) }],
  SOA: [
    { label: 'Primary NS', value: field('nsname') },
    { label: 'Hostmaster', value: field('hostmaster') },
    { label: 'Serial', value: field('serial'), numeric: true },
    { label: 'Refresh', value: field('refresh'), numeric: true },
    { label: 'Retry', value: field('retry'), numeric: true },
    { label: 'Expire', value: field('expire'), numeric: true },
    { label: 'Min TTL', value: field('minttl'), numeric: true },
  ],
  SRV: [
    { label: 'Priority', value: field('priority'), numeric: true },
    { label: 'Weight', value: field('weight'), numeric: true },
    { label: 'Port', value: field('port'), numeric: true },
    { label: 'Target', value: field('target') },
  ],
  CAA: [
    { label: 'Flags', value: field('critical'), numeric: true },
    { label: 'Tag', value: field('tag') },
    { label: 'Value', value: field('value') },
  ],
  ANY: [
    { label: 'Type', value: (r) => r.type },
    { label: 'Data', value: (r) => formatDnsData(r.type, r.data) },
  ],
};

/**
 * The DNS lookup tool: a name, a resolver and the record types in the header; one table per type below, with the
 * CNAME chain, the resolver used and the time taken above them. Not live: each lookup is a network call.
 */
@Component({
  selector: 'q-dns-lookup',
  imports: [Button, FormField, Input],
  template: `
    <div class="flex flex-col gap-2 px-3 py-2 border-b border-edge shrink-0">
      <div class="flex items-center gap-2">
        <span class="text-sm font-medium shrink-0">DNS lookup</span>
        <input qInput class="h-7 text-xs flex-[3] min-w-40" placeholder="example.com, or an IP address for a reverse lookup" [formField]="lookupForm.name" data-testid="dns-name" (keydown.enter)="lookup()" />
        <input qInput class="h-7 text-xs flex-1 min-w-28" placeholder="system" title="Resolver: an IP address with an optional port (1.1.1.1, 8.8.8.8:53, [2606:4700:4700::1111]:53). Empty uses the system's." [formField]="lookupForm.server" data-testid="dns-server" (keydown.enter)="lookup()" />
        <button qButton variant="primary" size="sm" class="shrink-0" [loading]="running()" data-testid="dns-lookup" (click)="lookup()">Lookup</button>
      </div>
      <div class="flex items-center gap-1 flex-wrap" role="group" aria-label="Record types">
        @for (type of allTypes; track type) {
          <button
            type="button"
            class="h-6 px-2 rounded-full border text-[11px] font-medium"
            [class]="picked().has(type) ? 'border-accent bg-accent/15 text-fg' : 'border-edge text-muted hover:text-fg'"
            [attr.aria-pressed]="picked().has(type)"
            [attr.data-testid]="'dns-type-' + type"
            (click)="toggle(type)"
          >
            {{ type }}
          </button>
        }
      </div>
    </div>
    <div class="@container flex-1 min-h-0 overflow-auto p-3 flex flex-col gap-4" data-testid="dns-output">
      @if (error(); as error) {
        <p class="text-xs text-danger" data-testid="dns-error">{{ error }}</p>
      } @else if (result(); as r) {
        <div class="flex flex-col gap-1 text-xs">
          @if (r.reverse; as rev) {
            <div class="break-all" data-testid="dns-reverse">
              Reverse lookup of <span class="font-mono">{{ rev.address }}</span> ({{ r.asciiName }}):
              <span class="font-mono">{{ rev.names.length ? rev.names.join(', ') : 'no names' }}</span>
            </div>
          } @else if (r.asciiName !== r.name) {
            <div class="text-muted">{{ r.name }} is looked up as <span class="font-mono">{{ r.asciiName }}</span></div>
          }
          @if (chainText(); as chain) {
            <div class="flex gap-1.5"><span class="text-muted shrink-0">CNAME chain</span><span class="font-mono break-all" data-testid="dns-chain">{{ chain }}</span></div>
          }
          <div class="text-muted" data-testid="dns-meta">Resolver {{ serverText() }} · {{ r.durationMs }} ms</div>
        </div>
        @for (group of groups(); track group.type) {
          <section [attr.data-testid]="'dns-group-' + group.type">
            <div class="flex items-baseline gap-2 mb-1">
              <h3 class="text-sm font-semibold">{{ group.type }}</h3>
              @if (group.records.length) {
                <span class="text-[11px] text-muted">{{ group.records.length }} record{{ group.records.length === 1 ? '' : 's' }}</span>
              }
            </div>
            @if (group.error; as e) {
              <p class="text-xs text-danger" data-testid="dns-group-error">{{ e.message }} ({{ e.code }})</p>
            } @else if (!group.records.length) {
              <p class="text-xs text-muted" data-testid="dns-group-empty">{{ group.empty === 'ENOTFOUND' ? 'No such name (NXDOMAIN)' : 'No records' }}</p>
            } @else {
              <table class="w-full text-xs">
                <thead class="text-muted text-left">
                  <tr class="border-b border-edge">
                    <th class="py-1 pr-4 @max-2xl:pr-2 font-medium w-px whitespace-nowrap">Name</th>
                    <th class="py-1 pr-4 @max-2xl:pr-2 font-medium w-px text-right">TTL</th>
                    @for (c of group.columns; track c.label) {
                      <th class="py-1 pr-4 @max-2xl:pr-2 font-medium" [class.text-right]="c.numeric" [class.w-px]="!$last" [class]="$last ? 'whitespace-nowrap' : 'whitespace-nowrap @max-2xl:whitespace-normal'">{{ c.label }}</th>
                    }
                  </tr>
                </thead>
                <tbody class="font-mono">
                  @for (rec of group.records; track $index) {
                    <tr class="border-b border-edge/60 align-top" data-testid="dns-row">
                      <td class="py-1 pr-4 @max-2xl:pr-2 whitespace-nowrap @max-2xl:whitespace-normal">@for (part of labels(rec.name); track $index) {<span>{{ part }}</span><wbr class="hidden @max-2xl:inline" />}</td>
                      <td class="py-1 pr-4 @max-2xl:pr-2 text-right text-muted whitespace-nowrap" [title]="rec.ttl === null ? 'Node reports the TTL for A and AAAA only' : ''">{{ rec.ttl ?? '—' }}</td>
                      @for (c of group.columns; track c.label) {
                        @if ($last) {
                          <td class="py-1 pr-4 @max-2xl:pr-2 break-all" [class.text-right]="c.numeric">{{ c.value(rec) }}</td>
                        } @else if (c.numeric) {
                          <td class="py-1 pr-4 @max-2xl:pr-2 text-right whitespace-nowrap">{{ c.value(rec) }}</td>
                        } @else {
                          <td class="py-1 pr-4 @max-2xl:pr-2 whitespace-nowrap @max-2xl:whitespace-normal">@for (part of labels(c.value(rec)); track $index) {<span>{{ part }}</span><wbr class="hidden @max-2xl:inline" />}</td>
                        }
                      }
                    </tr>
                  }
                </tbody>
              </table>
            }
          </section>
        }
      } @else {
        <p class="text-xs text-muted">Type a name and press Enter. Leave the resolver empty to use the system's.</p>
      }
    </div>
  `,
  host: { class: 'flex flex-col h-full min-h-0', 'data-testid': 'dns-lookup-tool' },
})
export class DnsLookup {
  private readonly host = inject(HostBridge);

  protected readonly allTypes = DNS_RECORD_TYPES;
  protected readonly lookupForm = form(signal({ name: '', server: '' }));
  protected readonly picked = signal(new Set<DnsRecordType>(DEFAULT_DNS_TYPES));
  protected readonly running = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly result = signal<DnsLookupResult | null>(null);

  protected readonly chainText = computed(() => {
    const chain = this.result()?.chain ?? [];
    return chain.length ? [chain[0].name, ...chain.map((l) => l.target)].join(' → ') : '';
  });

  protected readonly serverText = computed(() => {
    const s = this.result()?.server;
    if (!s) return '';
    const at = s.address ? (s.address.includes(':') ? `[${s.address}]:${s.port}` : `${s.address}:${s.port}`) : 'unknown';
    return s.source === 'system' ? `${at} (system)` : at;
  });

  protected readonly groups = computed(() => {
    const r = this.result();
    if (!r) return [];
    return groupDnsRecords(r.records, r.types).map((g) => ({
      ...g,
      columns: COLUMNS[g.type] ?? COLUMNS['ANY'],
      error: r.errors.find((e) => e.type === g.type) ?? null,
      empty: r.empty.find((e) => e.type === g.type)?.code ?? null,
    }));
  });

  /** A name split after each dot, so that in a narrow tab (under 42rem) a long name wraps between labels instead of overflowing. */
  protected labels(text: string): string[] {
    return text.split(/(?<=\.)/);
  }

  protected toggle(type: DnsRecordType): void {
    this.picked.update((set) => {
      const next = new Set(set);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }

  protected async lookup(): Promise<void> {
    const { name, server } = this.lookupForm().value();
    if (!name.trim() || this.running()) return;
    this.running.set(true);
    try {
      const types = DNS_RECORD_TYPES.filter((t) => this.picked().has(t));
      const payload: Record<string, unknown> = { name, types };
      if (server.trim()) payload['server'] = server.trim();
      this.result.set(await this.host.invoke<DnsLookupResult>('tools.dns.lookup', payload, null));
      this.error.set(null);
    } catch (err) {
      this.error.set(toErrorPayload(err).message);
      this.result.set(null);
    } finally {
      this.running.set(false);
    }
  }
}
