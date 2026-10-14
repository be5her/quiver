import { Component, computed, inject, input, output, signal } from '@angular/core';
import { dbDataCollection, prettyJson, type DbQueryResult, type RedisKeyDetail as KeyDetail } from '@quiver/core';
import { Button, CodeEditor, Dialogs, HostBridge, Icon, IconButton, Spinner, Toasts, invokeResource } from '@quiver/ui';
import { Check, Copy, Pencil, Plus, RefreshCw, TextCursorInput, Timer, Trash2, X } from 'lucide';
import { DbError } from './db-error';
import { formatCount, formatTtl } from './db-format';
import { RedisTypeBadge } from './redis-type-badge';
import { ResultGrid, type CellEdit } from './result-grid';

/** A placeholder no real list holds, used to delete one list element by index (LSET, then LREM). */
const LIST_TOMBSTONE = '__quiver_deleted__';

/**
 * One key: type, TTL and size, then its value as a grid (hash, list, set, zset, stream) or text.
 * Strings are edited in place (Save keeps the TTL); hash fields and set, zset and list items are
 * edited, added and removed from the grid; the TTL and the name can be changed; the key deleted.
 */
@Component({
  selector: 'q-redis-key-detail',
  imports: [Button, CodeEditor, DbError, Icon, IconButton, RedisTypeBadge, ResultGrid, Spinner],
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
  readonly renamed = output<string>();

  protected readonly icons = { Check, Copy, Pencil, Plus, RefreshCw, TextCursorInput, Timer, Trash2, X };
  protected readonly formatTtl = formatTtl;
  protected readonly formatCount = formatCount;
  protected readonly detail = invokeResource<KeyDetail>('db.redis.key', () => ({ connectionId: this.connectionId(), key: this.keyName(), limit: 500 }), {
    refreshOn: () => [dbDataCollection(this.connectionId())],
  });
  protected readonly editing = signal(false);
  protected readonly draft = signal('');
  protected readonly busy = signal(false);
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
  protected readonly editableCollection = computed(() => ['hash', 'list', 'set', 'zset'].includes(this.detail.value()?.type ?? ''));
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

  /** Run commands with exact arguments, then reload; errors become toasts. True on success. */
  private async exec(commands: string[][], done?: string): Promise<boolean> {
    this.busy.set(true);
    try {
      await this.host.invoke<DbQueryResult[]>('db.redis.command', { connectionId: this.connectionId(), commands });
      if (done) this.toasts.notify(done, 'success');
      this.detail.reload();
      return true;
    } catch (err) {
      this.toasts.error(err);
      return false;
    } finally {
      this.busy.set(false);
    }
  }

  // ---------- the key itself ----------

  protected async remove(): Promise<void> {
    const key = this.keyName();
    if (!(await this.dialogs.confirm({ title: `Delete key "${key}"?`, danger: true, confirmLabel: 'Delete' }))) return;
    if (await this.exec([['DEL', key]], 'Key deleted')) this.deleted.emit();
  }

  protected async rename(): Promise<void> {
    const key = this.keyName();
    const next = (await this.dialogs.prompt({ title: 'Rename key', label: 'New name', defaultValue: key, confirmLabel: 'Rename' }))?.trim();
    if (!next || next === key) return;
    if (await this.exec([['RENAME', key, next]], `Renamed to ${next}`)) this.renamed.emit(next);
  }

  protected async setTtl(): Promise<void> {
    const key = this.keyName();
    const current = this.detail.value()?.ttl ?? -1;
    const answer = await this.dialogs.prompt({
      title: 'Expire key',
      label: 'Seconds from now (leave empty to remove the expiry)',
      defaultValue: current > 0 ? String(current) : '',
      confirmLabel: 'Set',
    });
    if (answer === null) return;
    const seconds = answer.trim();
    if (!seconds) {
      await this.exec([['PERSIST', key]], 'Expiry removed');
      return;
    }
    if (!/^\d+$/.test(seconds) || Number(seconds) <= 0) {
      this.toasts.notify('Enter a whole number of seconds', 'error');
      return;
    }
    await this.exec([['EXPIRE', key, seconds]], `Expires in ${formatTtl(Number(seconds))}`);
  }

  protected copyValue(): void {
    const detail = this.detail.value();
    if (!detail) return;
    const text = typeof detail.value === 'string' ? detail.value : JSON.stringify(detail.value, null, 2);
    void navigator.clipboard.writeText(text).then(() => this.toasts.notify('Copied value', 'success'));
  }

  // ---------- strings ----------

  protected startEdit(): void {
    const text = this.text();
    if (!text) return;
    this.draft.set(text.text);
    this.editing.set(true);
  }

  protected cancelEdit(): void {
    this.editing.set(false);
  }

  /** JSON shown pretty is saved minified, as it was stored; anything else goes as typed. */
  protected async saveString(): Promise<void> {
    const draft = this.draft();
    let value = draft;
    if (this.text()?.language === 'json') {
      try {
        value = JSON.stringify(JSON.parse(draft));
      } catch {
        value = draft;
      }
    }
    if (await this.exec([['SET', this.keyName(), value, 'KEEPTTL']], 'Value saved')) this.editing.set(false);
  }

  // ---------- collections ----------

  protected async cellEdit({ row, col, value }: CellEdit): Promise<void> {
    const detail = this.detail.value();
    const grid = this.grid();
    if (!detail || !grid) return;
    const key = this.keyName();
    const text = value === null || value === undefined ? '' : String(value);
    const current = grid.rows[row];
    switch (detail.type) {
      case 'hash': {
        const field = String(current[0]);
        if (col === 0) {
          if (text === field) return;
          await this.exec([['HDEL', key, field], ['HSET', key, text, String(current[1] ?? '')]]);
        } else await this.exec([['HSET', key, field, text]]);
        return;
      }
      case 'list':
        if (col === 0) {
          this.toasts.notify('List positions cannot be edited', 'info');
          return;
        }
        await this.exec([['LSET', key, String(current[0]), text]]);
        return;
      case 'set':
        if (col === 0) {
          this.toasts.notify('Set members have no position', 'info');
          return;
        }
        if (text === String(current[1])) return;
        await this.exec([['SREM', key, String(current[1])], ['SADD', key, text]]);
        return;
      case 'zset': {
        const member = String(current[0]);
        const score = String(current[1]);
        if (col === 0) {
          if (text === member) return;
          await this.exec([['ZREM', key, member], ['ZADD', key, score, text]]);
        } else {
          if (!/^-?(\d+(\.\d+)?|inf)$/i.test(text.trim())) {
            this.toasts.notify('A score is a number', 'error');
            return;
          }
          await this.exec([['ZADD', key, text.trim(), member]]);
        }
        return;
      }
      default:
        return;
    }
  }

  protected async removeItem(row: number): Promise<void> {
    const detail = this.detail.value();
    const grid = this.grid();
    if (!detail || !grid) return;
    const key = this.keyName();
    const current = grid.rows[row];
    switch (detail.type) {
      case 'hash':
        await this.exec([['HDEL', key, String(current[0])]], 'Field removed');
        return;
      case 'list':
        await this.exec([['LSET', key, String(current[0]), LIST_TOMBSTONE], ['LREM', key, '1', LIST_TOMBSTONE]], 'Item removed');
        return;
      case 'set':
        await this.exec([['SREM', key, String(current[1])]], 'Member removed');
        return;
      case 'zset':
        await this.exec([['ZREM', key, String(current[0])]], 'Member removed');
        return;
      default:
        return;
    }
  }

  protected async addItem(): Promise<void> {
    const detail = this.detail.value();
    if (!detail) return;
    const key = this.keyName();
    switch (detail.type) {
      case 'hash': {
        const field = (await this.dialogs.prompt({ title: 'Add field', label: 'Field', confirmLabel: 'Next' }))?.trim();
        if (!field) return;
        const value = await this.dialogs.prompt({ title: `Value of ${field}`, label: 'Value', confirmLabel: 'Add' });
        if (value === null) return;
        await this.exec([['HSET', key, field, value]], 'Field added');
        return;
      }
      case 'list': {
        const value = await this.dialogs.prompt({ title: 'Append to list', label: 'Value', confirmLabel: 'Add' });
        if (value === null) return;
        await this.exec([['RPUSH', key, value]], 'Item added');
        return;
      }
      case 'set': {
        const member = await this.dialogs.prompt({ title: 'Add member', label: 'Member', confirmLabel: 'Add' });
        if (member === null) return;
        await this.exec([['SADD', key, member]], 'Member added');
        return;
      }
      case 'zset': {
        const member = await this.dialogs.prompt({ title: 'Add member', label: 'Member', confirmLabel: 'Next' });
        if (member === null) return;
        const score = (await this.dialogs.prompt({ title: `Score of ${member}`, label: 'Score', defaultValue: '0', confirmLabel: 'Add' }))?.trim();
        if (!score || !/^-?(\d+(\.\d+)?|inf)$/i.test(score)) return;
        await this.exec([['ZADD', key, score, member]], 'Member added');
        return;
      }
      default:
        return;
    }
  }
}
