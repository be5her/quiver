import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { toErrorPayload, type ErrorPayload, type RedisKeyInfo, type RedisScanResult } from '@quiver/core';
import { Button, HostBridge, Icon, IconButton, Input, Spinner, type Tab, type TabComponent } from '@quiver/ui';
import { Search } from 'lucide';
import { DbError } from './db-error';
import { formatCount, formatTtl } from './db-format';
import { RedisKeyDetail } from './redis-key-detail';
import { RedisTypeBadge } from './redis-type-badge';

const SCAN_COUNT = 200;

/** A Redis connection's keys, scanned by pattern a page at a time, and the selected key's value. */
@Component({
  selector: 'q-redis-tab',
  imports: [Button, DbError, Icon, IconButton, Input, RedisKeyDetail, RedisTypeBadge, Spinner],
  templateUrl: './redis-tab.html',
  host: { class: 'flex h-full min-h-0' },
})
export class RedisTab implements TabComponent {
  private readonly host = inject(HostBridge);

  readonly tab = input.required<Tab>();
  readonly scope = input.required<string>();

  protected readonly searchIcon = Search;
  protected readonly formatTtl = formatTtl;
  protected readonly connectionId = computed(() => String(this.tab().data?.['connectionId'] ?? ''));
  protected readonly pattern = signal('*');
  protected readonly keys = signal<RedisKeyInfo[]>([]);
  protected readonly cursor = signal<string | null>(null);
  protected readonly scanning = signal(false);
  protected readonly scanError = signal<ErrorPayload | null>(null);
  protected readonly selected = signal<string | null>(null);
  protected readonly count = computed(() => `${formatCount(this.keys().length)} keys${this.cursor() ? '+' : ''}`);

  constructor() {
    effect(() => {
      this.connectionId();
      untracked(() => void this.scan(true));
    });
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
}
