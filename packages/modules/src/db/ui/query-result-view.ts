import { Component, computed, input } from '@angular/core';
import type { DbQueryResult } from '@quiver/core';
import { formatCount } from './db-format';
import { ResultGrid } from './result-grid';

const VALUE_COLUMNS = [
  { name: 'index', type: null },
  { name: 'value', type: null },
];

/** One statement's result: rows in a grid, an affected-rows line, or a Redis reply. */
@Component({
  selector: 'q-query-result-view',
  imports: [ResultGrid],
  template: `
    @switch (result().kind) {
      @case ('rows') {
        <q-result-grid [columns]="rowColumns()" [rows]="rowValues()" emptyMessage="Empty result set" />
      }
      @case ('affected') {
        <div class="p-3 text-sm">
          <p class="text-fg">OK, {{ affected() }} row{{ affectedCount() === 1 ? '' : 's' }} affected@if (insertId()) {<span class="text-muted"> · insert id {{ insertId() }}</span>}</p>
          @if (message()) {
            <p class="text-xs text-muted mt-1 font-mono">{{ message() }}</p>
          }
        </div>
      }
      @default {
        @if (replyRows(); as rows) {
          <q-result-grid [columns]="valueColumns" [rows]="rows" emptyMessage="(empty array)" />
        } @else {
          <pre class="p-3 text-xs font-mono whitespace-pre-wrap break-all overflow-auto h-full" [class]="replyIsNull() ? 'text-muted italic' : ''">{{ replyText() }}</pre>
        }
      }
    }
  `,
  host: { class: 'contents' },
})
export class QueryResultView {
  readonly result = input.required<DbQueryResult>();

  protected readonly valueColumns = VALUE_COLUMNS;
  protected readonly rowColumns = computed(() => {
    const r = this.result();
    return r.kind === 'rows' ? r.columns : [];
  });
  protected readonly rowValues = computed(() => {
    const r = this.result();
    return r.kind === 'rows' ? r.rows : [];
  });
  protected readonly affectedCount = computed(() => {
    const r = this.result();
    return r.kind === 'affected' ? (r.affectedRows ?? 0) : 0;
  });
  protected readonly affected = computed(() => formatCount(this.affectedCount()));
  protected readonly insertId = computed(() => {
    const r = this.result();
    return r.kind === 'affected' ? r.insertId : null;
  });
  protected readonly message = computed(() => {
    const r = this.result();
    return r.kind === 'affected' ? r.message : null;
  });
  private readonly reply = computed(() => {
    const r = this.result();
    return r.kind === 'value' ? r.value : undefined;
  });
  /** Redis arrays become a one-column grid. */
  protected readonly replyRows = computed(() => {
    const value = this.reply();
    return Array.isArray(value) ? value.map((v, i) => [i, v]) : null;
  });
  protected readonly replyIsNull = computed(() => this.reply() === null);
  protected readonly replyText = computed(() => {
    const value = this.reply();
    return value === null ? '(nil)' : typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  });
}
