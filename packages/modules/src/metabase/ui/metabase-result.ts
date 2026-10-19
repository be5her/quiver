import { Component, input, output } from '@angular/core';
import type { DbQueryResult, ErrorPayload, SqlKind } from '@quiver/core';
import { Badge } from '@quiver/ui';
import { ResultGrid } from '../../db/ui/result-grid';
import { MetabaseExportMenu, type MetabaseExportSource } from './export-menu';
import { MetabaseError } from './metabase-error';
import { resultSummary } from './metabase-format';

/** What a question or a native query answered: a line with the row count and the export menu, then the rows or the error. */
@Component({
  selector: 'q-mb-result',
  imports: [Badge, MetabaseError, MetabaseExportMenu, ResultGrid],
  template: `
    <div class="flex items-center gap-2 px-3 h-8 border-b border-edge shrink-0 text-xs text-muted">
      @if (result(); as r) {
        @if (!error()) {
          <span data-testid="mb-rowcount">{{ summary(r) }}</span>
          @if (r.truncated) {
            <span qBadge class="text-warning" data-testid="mb-truncated" title="Metabase caps what it answers interactively">Metabase returns the first rows only; export gets them all</span>
          }
        }
      } @else if (running()) {
        <span>Running…</span>
      }
      @if (error(); as error) {
        <span class="text-danger truncate">{{ error.message }}</span>
      }
      <div class="flex-1"></div>
      @if (result(); as r) {
        @if (!error() && r.rows.length > 0) {
          <q-mb-export-menu [connectionId]="connectionId()" [columns]="r.columns" [rows]="r.rows" [name]="exportName()" [source]="exportSource()" />
        }
      }
    </div>
    <div class="flex-1 min-h-0">
      @if (error(); as error) {
        <q-mb-error [error]="error" [connectionId]="connectionId()" (retry)="retry.emit()" />
      } @else if (result(); as r) {
        <div class="h-full" data-testid="mb-result" [attr.data-rows]="r.rows.length">
          <q-result-grid [columns]="r.columns" [rows]="r.rows" [sqlKind]="sqlKind()" emptyMessage="No rows" />
        </div>
      } @else {
        <div class="h-full flex items-center justify-center text-xs text-muted">{{ running() ? 'Running…' : emptyText() }}</div>
      }
    </div>
  `,
  host: { class: 'flex-1 min-h-0 flex flex-col' },
})
export class MetabaseResult {
  readonly connectionId = input.required<string>();
  readonly result = input<DbQueryResult | null>(null);
  readonly error = input<ErrorPayload | null>(null);
  readonly running = input(false);
  /** For the grid's "Copy as SQL literal". */
  readonly sqlKind = input<SqlKind | null>(null);
  readonly exportName = input('export');
  readonly exportSource = input<MetabaseExportSource | null>(null);
  readonly emptyText = input('Results appear here.');
  readonly retry = output<void>();

  protected readonly summary = resultSummary;
}
