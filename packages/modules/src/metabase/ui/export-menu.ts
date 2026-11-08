import { Component, ElementRef, effect, inject, input, signal } from '@angular/core';
import {
  EXPORT_LABELS,
  METABASE_EXPORT_FORMATS,
  METABASE_EXPORT_LABELS,
  formatRows,
  type DbExportFormat,
  type DbResultColumn,
  type MetabaseExportFormat,
  type MetabaseExportResult,
  type MetabaseParameterValue,
  type MetabaseTableFilter,
  type MetabaseTableOrder,
} from '@quiver/core';
import { HostBridge, Icon, IconButton, Toasts } from '@quiver/ui';
import { Download } from 'lucide';

const COPY_FORMATS: DbExportFormat[] = ['csv', 'json', 'markdown'];

/** What Metabase runs again for "Save all rows": a saved question with its parameters, a native query, or a table through its filters and order (every row, not one page). */
export type MetabaseExportSource =
  | { cardId: number; parameters: MetabaseParameterValue[] }
  | { databaseId: number; sql: string }
  | { tableId: number; databaseId: number; orderBy?: MetabaseTableOrder; filters: MetabaseTableFilter[] };

/**
 * The export menu of a Metabase result: copy the rows in hand as CSV, JSON or Markdown, or have
 * Metabase run the query again and save every row (past its interactive cap) through `metabase.export`.
 */
@Component({
  selector: 'q-mb-export-menu',
  imports: [Icon, IconButton],
  template: `
    <button qIconButton label="Export" size="sm" data-testid="mb-export" (click)="open.set(!open())"><svg [qIcon]="icon" class="size-3.5"></svg></button>
    @if (open()) {
      <div class="absolute right-0 top-full mt-1 z-20 min-w-48 rounded-md border border-edge bg-elevated shadow-lg py-1 text-xs normal-case tracking-normal font-normal text-fg" role="menu">
        <div class="px-3 py-1 text-[10px] uppercase tracking-wide text-muted">Copy {{ count() }} rows as</div>
        @for (format of copyFormats; track format) {
          <button type="button" role="menuitem" class="w-full text-left px-3 py-1.5 hover:bg-surface" [attr.data-testid]="'mb-export-copy-' + format" (click)="copy(format)">{{ copyLabels[format] }}</button>
        }
        @if (source()) {
          <div class="my-1 h-px bg-edge"></div>
          <div class="px-3 py-1 text-[10px] uppercase tracking-wide text-muted">Save all rows as</div>
          @for (format of saveFormats; track format) {
            <button type="button" role="menuitem" class="w-full text-left px-3 py-1.5 hover:bg-surface" [attr.data-testid]="'mb-export-save-' + format" (click)="save(format)">{{ saveLabels[format] }}…</button>
          }
        }
      </div>
    }
  `,
  host: { class: 'relative block' },
})
export class MetabaseExportMenu {
  private readonly host = inject(HostBridge);
  private readonly toasts = inject(Toasts);
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly connectionId = input.required<string>();
  readonly columns = input.required<DbResultColumn[]>();
  readonly rows = input.required<unknown[][]>();
  /** The file name offered, without its extension. */
  readonly name = input('export');
  readonly source = input<MetabaseExportSource | null>(null);

  protected readonly icon = Download;
  protected readonly copyFormats = COPY_FORMATS;
  protected readonly copyLabels = EXPORT_LABELS;
  protected readonly saveFormats = METABASE_EXPORT_FORMATS;
  protected readonly saveLabels = METABASE_EXPORT_LABELS;
  protected readonly open = signal(false);

  constructor() {
    effect((onCleanup) => {
      if (!this.open()) return;
      const onDown = (e: MouseEvent) => {
        if (!this.element.nativeElement.contains(e.target as Node)) this.open.set(false);
      };
      document.addEventListener('mousedown', onDown);
      onCleanup(() => document.removeEventListener('mousedown', onDown));
    });
  }

  protected count(): string {
    return this.rows().length.toLocaleString();
  }

  protected copy(format: DbExportFormat): void {
    this.open.set(false);
    // Values are quoted the PostgreSQL way; INSERT statements are not offered, so the flavour hardly shows.
    const text = formatRows({ format, columns: this.columns(), rows: this.rows(), kind: 'postgres', table: this.name(), database: null });
    this.toasts.copy(text, `Copied ${EXPORT_LABELS[format]}`);
  }

  protected async save(format: MetabaseExportFormat): Promise<void> {
    this.open.set(false);
    const source = this.source();
    if (!source) return;
    const fileName = `${safeFileName(this.name())}.${format}`;
    try {
      const { path } = await this.host.invoke<{ path: string | null }>('app.pickSavePath', { title: 'Export rows', defaultPath: fileName, filters: [{ name: METABASE_EXPORT_LABELS[format], extensions: [format] }] }, null);
      if (!path) return;
      const result = await this.host.invoke<MetabaseExportResult>('metabase.export', { connectionId: this.connectionId(), format, path, ...source });
      this.toasts.notify(`Saved ${formatBytes(result.bytes)} to ${result.path ?? path}`, 'success');
    } catch (err) {
      this.toasts.error(err);
    }
  }
}

function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'export';
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
