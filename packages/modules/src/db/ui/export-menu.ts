import { Component, ElementRef, effect, inject, input, signal } from '@angular/core';
import { EXPORT_EXTENSIONS, EXPORT_LABELS, formatRows, type DbExportFormat, type DbExportResult, type DbResultColumn, type SqlKind } from '@quiver/core';
import { HostBridge, Icon, IconButton, Toasts } from '@quiver/ui';
import { Download } from 'lucide';

const FORMATS: DbExportFormat[] = ['csv', 'json', 'markdown', 'sql'];

/** Where the rows came from, so "Save as…" can read them all again on the host, not just the page in hand. */
export type ExportSource =
  | { query: string; database: string | null }
  | { table: string; database: string | null; where: string | null; orderBy: string | null; direction: 'asc' | 'desc' | undefined };

/**
 * The export menu of a result: copy the rows in hand as CSV, JSON, Markdown or INSERT statements,
 * or save every row of the source to a file through `db.export`.
 */
@Component({
  selector: 'q-db-export-menu',
  imports: [Icon, IconButton],
  template: `
    <button qIconButton label="Export" size="sm" data-testid="db-export" (click)="open.set(!open())"><svg [qIcon]="icon" class="size-3.5"></svg></button>
    @if (open()) {
      <div class="absolute right-0 top-full mt-1 z-20 min-w-48 rounded-md border border-edge bg-elevated shadow-lg py-1 text-xs normal-case tracking-normal font-normal text-fg" role="menu">
        <div class="px-3 py-1 text-[10px] uppercase tracking-wide text-muted">Copy {{ count() }} rows as</div>
        @for (format of formats; track format) {
          <button type="button" role="menuitem" class="w-full text-left px-3 py-1.5 hover:bg-surface" (click)="copy(format)">{{ labels[format] }}</button>
        }
        @if (source()) {
          <div class="my-1 h-px bg-edge"></div>
          <div class="px-3 py-1 text-[10px] uppercase tracking-wide text-muted">Save all rows as</div>
          @for (format of formats; track format) {
            <button type="button" role="menuitem" class="w-full text-left px-3 py-1.5 hover:bg-surface" (click)="save(format)">{{ labels[format] }}…</button>
          }
        }
      </div>
    }
  `,
  host: { class: 'relative block' },
})
export class ExportMenu {
  private readonly host = inject(HostBridge);
  private readonly toasts = inject(Toasts);
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly connectionId = input.required<string>();
  readonly kind = input<SqlKind | null>(null);
  readonly columns = input.required<DbResultColumn[]>();
  readonly rows = input.required<unknown[][]>();
  /** The table INSERT statements target; the query's name otherwise. */
  readonly table = input<string | null>(null);
  readonly database = input<string | null>(null);
  readonly source = input<ExportSource | null>(null);

  protected readonly icon = Download;
  protected readonly formats = FORMATS;
  protected readonly labels = EXPORT_LABELS;
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
    const text = formatRows({ format, columns: this.columns(), rows: this.rows(), kind: this.kind() ?? 'mysql', table: this.table() ?? 'export', database: this.database() });
    this.toasts.copy(text, `Copied ${EXPORT_LABELS[format]}`);
  }

  protected async save(format: DbExportFormat): Promise<void> {
    this.open.set(false);
    const source = this.source();
    if (!source) return;
    const name = `${this.table() ?? 'export'}.${EXPORT_EXTENSIONS[format]}`;
    try {
      const { path } = await this.host.invoke<{ path: string | null }>('app.pickSavePath', { title: 'Export rows', defaultPath: name, filters: [{ name: EXPORT_LABELS[format], extensions: [EXPORT_EXTENSIONS[format]] }] }, null);
      if (!path) return;
      const result = await this.host.invoke<DbExportResult>('db.export', { connectionId: this.connectionId(), format, path, maxRows: 1_000_000, ...source });
      this.toasts.notify(`Saved ${result.rows.toLocaleString()} rows to ${path}${result.truncated ? ' (capped at one million rows)' : ''}`, 'success');
    } catch (err) {
      this.toasts.error(err);
    }
  }
}
