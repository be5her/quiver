import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { dbDataCollection, toErrorPayload, type ErrorPayload, type RedisInfo, type RedisKeyInfo, type RedisScanResult } from '@quiver/core';
import { Button, Dialogs, HostBridge, Icon, IconButton, Input, Spinner, Toasts, injectHostEvent, invokeResource, type Tab, type TabComponent } from '@quiver/ui';
import { Plus, RefreshCw, Search } from 'lucide';
import { DbError } from './db-error';
import { formatCount, formatTtl, formatUptime } from './db-format';
import { RedisKeyDetail } from './redis-key-detail';
import { RedisTypeBadge } from './redis-type-badge';

const SCAN_COUNT = 200;

const NEW_KEY_TYPES = [
  { value: 'string', label: 'String' },
  { value: 'hash', label: 'Hash' },
  { value: 'list', label: 'List' },
  { value: 'set', label: 'Set' },
  { value: 'zset', label: 'Sorted set' },
];

/** What a key of each type starts as: the smallest value Redis accepts, edited from the detail afterwards. */
const FIRST_VALUE: Record<string, (key: string) => string[]> = {
  string: (key) => ['SET', key, ''],
  hash: (key) => ['HSET', key, 'field', 'value'],
  list: (key) => ['RPUSH', key, 'value'],
  set: (key) => ['SADD', key, 'member'],
  zset: (key) => ['ZADD', key, '0', 'member'],
};

/** A Redis connection's keys, scanned by pattern a page at a time, the server's vitals, and the selected key's value. */
@Component({
  selector: 'q-redis-tab',
  imports: [Button, DbError, Icon, IconButton, Input, RedisKeyDetail, RedisTypeBadge, Spinner],
  templateUrl: './redis-tab.html',
  host: { class: 'flex h-full min-h-0' },
})
export class RedisTab implements TabComponent {
  private readonly host = inject(HostBridge);
  private readonly dialogs = inject(Dialogs);
  private readonly toasts = inject(Toasts);

  readonly tab = input.required<Tab>();
  readonly scope = input.required<string>();

  protected readonly icons = { Plus, RefreshCw, Search };
  protected readonly formatTtl = formatTtl;
  protected readonly connectionId = computed(() => String(this.tab().data?.['connectionId'] ?? ''));
  protected readonly pattern = signal('*');
  protected readonly keys = signal<RedisKeyInfo[]>([]);
  protected readonly cursor = signal<string | null>(null);
  protected readonly scanning = signal(false);
  protected readonly scanError = signal<ErrorPayload | null>(null);
  protected readonly selected = signal<string | null>(null);
  protected readonly count = computed(() => `${formatCount(this.keys().length)} keys${this.cursor() ? '+' : ''}`);
  protected readonly info = invokeResource<RedisInfo>('db.redis.info', () => ({ connectionId: this.connectionId() }), { refreshOn: () => [dbDataCollection(this.connectionId())] });
  /** The vitals as one line: version, uptime, clients, memory, keys, throughput, hit rate. */
  protected readonly vitals = computed(() => {
    const i = this.info.value();
    if (!i) return [];
    const parts: string[] = [];
    if (i.version) parts.push(`Redis ${i.version}${i.mode && i.mode !== 'standalone' ? ` (${i.mode})` : ''}`);
    if (i.role && i.role !== 'master') parts.push(i.role);
    if (i.uptimeSeconds !== null) parts.push(`up ${formatUptime(i.uptimeSeconds)}`);
    if (i.connectedClients !== null) parts.push(`${formatCount(i.connectedClients)} client${i.connectedClients === 1 ? '' : 's'}`);
    if (i.usedMemoryHuman) parts.push(`${i.usedMemoryHuman}${i.maxMemoryHuman && i.maxMemoryHuman !== '0B' ? ` of ${i.maxMemoryHuman}` : ''}`);
    if (i.keys !== null) parts.push(`${formatCount(i.keys)} key${i.keys === 1 ? '' : 's'}`);
    if (i.opsPerSecond !== null) parts.push(`${formatCount(i.opsPerSecond)} ops/s`);
    if (i.hitRate !== null) parts.push(`${Math.round(i.hitRate * 100)}% hits`);
    return parts;
  });

  constructor() {
    effect(() => {
      this.connectionId();
      untracked(() => void this.scan(true));
    });
    // A write from a query tab, an agent or the key detail: scan the same pattern again.
    injectHostEvent('store.changed', (p) => p.workspaceId === this.scope() && p.collection === dbDataCollection(this.connectionId()) && void this.scan(true));
  }

  protected typed(event: Event): void {
    this.pattern.set((event.target as HTMLInputElement).value);
  }

  protected async scan(fresh: boolean): Promise<void> {
    if (this.scanning()) return;
    this.scanning.set(true);
    this.scanError.set(null);
    try {
      const out = await this.host.invoke<RedisScanResult>('db.redis.keys', {
        connectionId: this.connectionId(),
        pattern: this.pattern().trim() || '*',
        cursor: fresh ? '0' : (this.cursor() ?? '0'),
        count: SCAN_COUNT,
      });
      this.keys.update((prev) => {
        const merged = fresh ? out.keys : [...prev, ...out.keys.filter((k) => !prev.some((p) => p.key === k.key))];
        return merged.sort((a, b) => a.key.localeCompare(b.key));
      });
      this.cursor.set(out.done ? null : out.cursor);
    } catch (err) {
      this.scanError.set(toErrorPayload(err));
    } finally {
      this.scanning.set(false);
    }
  }

  protected removeKey(key: string): void {
    this.keys.update((keys) => keys.filter((k) => k.key !== key));
    if (this.selected() === key) this.selected.set(null);
  }

  protected renamedKey(next: string): void {
    this.selected.set(next);
    void this.scan(true);
  }

  /** A new key of the chosen type with a first value, then selected so it can be filled in. */
  protected async newKey(): Promise<void> {
    const answer = await this.dialogs.promptWithChoice({
      title: 'New key',
      label: 'Key',
      placeholder: 'user:42',
      confirmLabel: 'Create',
      choice: { label: 'Type', options: NEW_KEY_TYPES, defaultValue: 'string' },
    });
    const key = answer?.value.trim();
    if (!key) return;
    const first = FIRST_VALUE[answer!.choice] ?? FIRST_VALUE['string'];
    try {
      const [exists] = await this.host.invoke<{ value: unknown }[]>('db.redis.command', { connectionId: this.connectionId(), commands: [['EXISTS', key]] });
      if (Number(exists?.value) > 0) {
        this.toasts.notify(`${key} already exists`, 'error');
        return;
      }
      await this.host.invoke('db.redis.command', { connectionId: this.connectionId(), commands: [first(key)] });
      this.toasts.notify(`Created ${key}`, 'success');
      this.selected.set(key);
      await this.scan(true);
    } catch (err) {
      this.toasts.error(err);
    }
  }
}
