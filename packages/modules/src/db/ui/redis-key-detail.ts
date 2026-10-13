import { Component, computed, inject, input, output } from '@angular/core';
import { dbDataCollection, prettyJson, type RedisKeyDetail as KeyDetail } from '@quiver/core';
import { CodeEditor, Dialogs, HostBridge, Icon, IconButton, Spinner, Toasts, invokeResource } from '@quiver/ui';
import { Copy, RefreshCw, Trash2 } from 'lucide';
import { DbError } from './db-error';
import { formatCount, formatTtl, redisQuote } from './db-format';
import { RedisTypeBadge } from './redis-type-badge';
import { ResultGrid } from './result-grid';

/** One key: type, TTL and size, then its value as a grid (hash, list, set, zset, stream) or text. */
@Component({
  selector: 'q-redis-key-detail',
  imports: [CodeEditor, DbError, Icon, IconButton, RedisTypeBadge, ResultGrid, Spinner],
  templateUrl: './redis-key-detail.html',
  host: { class: 'contents' },
})
export class RedisKeyDetail {
  private readonly host = inject(HostBridge);
  private readonly dialogs = inject(Dialogs);
  private readonly toasts = inject(Toasts);

  readonly connectionId = input.required<string>();
  readonly keyName = input.required<string>();
  readonly deleted = output<void>();

  protected readonly icons = { Copy, RefreshCw, Trash2 };
  protected readonly formatTtl = formatTtl;
  protected readonly formatCount = formatCount;
  protected readonly detail = invokeResource<KeyDetail>('db.redis.key', () => ({ connectionId: this.connectionId(), key: this.keyName(), limit: 500 }), {
    refreshOn: () => [dbDataCollection(this.connectionId())],
  });
  /** Collections as rows of a two-column grid; null for strings and types that are not previewed. */
  protected readonly grid = computed(() => {
    const detail = this.detail.value();
    if (!detail) return null;
    const { type, value } = detail;
    if (type === 'hash' && value && typeof value === 'object' && !Array.isArray(value)) {
      return { columns: [{ name: 'field', type: null }, { name: 'value', type: null }], rows: Object.entries(value as Record<string, unknown>) };
    }
    if ((type === 'list' || type === 'set') && Array.isArray(value)) {
      return { columns: [{ name: 'index', type: null }, { name: 'value', type: null }], rows: value.map((v, i) => [i, v]) };
    }
    if (type === 'zset' && Array.isArray(value)) {
      return { columns: [{ name: 'member', type: null }, { name: 'score', type: null }], rows: value as unknown[][] };
    }
    if (type === 'stream' && Array.isArray(value)) {
      return { columns: [{ name: 'id', type: null }, { name: 'fields', type: null }], rows: (value as { id: string; fields: unknown }[]).map((e) => [e.id, e.fields]) };
    }
    return null;
  });
  protected readonly text = computed(() => {
    const detail = this.detail.value();
    if (!detail || detail.type !== 'string') return null;
    const text = String(detail.value ?? '');
    const json = prettyJson(text);
    return { text: json ?? text, language: json ? ('json' as const) : ('text' as const) };
  });
  protected readonly raw = computed(() => {
    const detail = this.detail.value();
    if (!detail) return '';
    return detail.value === null ? `(${detail.type} values are not previewed)` : JSON.stringify(detail.value, null, 2);
  });
  protected readonly shownCount = computed(() => {
    const value = this.detail.value()?.value;
    return formatCount(Array.isArray(value) ? value.length : 500);
  });

  protected async remove(): Promise<void> {
    const key = this.keyName();
    if (!(await this.dialogs.confirm({ title: `Delete key "${key}"?`, danger: true, confirmLabel: 'Delete' }))) return;
    try {
      await this.host.invoke('db.query.run', { connectionId: this.connectionId(), query: `DEL ${redisQuote(key)}`, record: false });
      this.toasts.notify('Key deleted', 'success');
      this.deleted.emit();
    } catch (err) {
      this.toasts.error(err);
    }
  }

  protected copyValue(): void {
    const detail = this.detail.value();
    if (!detail) return;
    const text = typeof detail.value === 'string' ? detail.value : JSON.stringify(detail.value, null, 2);
    void navigator.clipboard.writeText(text).then(() => this.toasts.notify('Copied value', 'success'));
  }
}
