import { Component, DestroyRef, ElementRef, afterNextRender, afterRenderEffect, booleanAttribute, computed, inject, input, linkedSignal, output, signal, viewChild } from '@angular/core';
import type { DbResultColumn } from '@quiver/core';
import { Icon, IconButton, Toasts } from '@quiver/ui';
import { ArrowDown, ArrowUp, Copy } from 'lucide';
import { formatCell, formatCellFull } from './db-format';

const ROW_HEIGHT = 26;
const HEADER_HEIGHT = 28;
const INDEX_WIDTH = 48;
const OVERSCAN = 8;

export interface GridSort {
  column: string;
  direction: 'asc' | 'desc';
}

/**
 * Windowed grid: only rows inside the viewport (plus a few) exist in the DOM, so 5,000 rows by 40
 * columns scroll as smoothly as 50. Click a cell to see its full value.
 */
@Component({
  selector: 'q-result-grid',
  imports: [Icon, IconButton],
  templateUrl: './result-grid.html',
  host: { class: 'flex flex-col h-full min-h-0' },
})
export class ResultGrid {
  private readonly toasts = inject(Toasts);
  private readonly scroller = viewChild.required<ElementRef<HTMLDivElement>>('scroller');

  readonly columns = input.required<DbResultColumn[]>();
  readonly rows = input.required<unknown[][]>();
  /** Sort indicator for the header. */
  readonly sort = input<GridSort | null>(null);
  /** Header clicks ask for a sort. */
  readonly sortable = input(false, { transform: booleanAttribute });
  /** Shown in the grid when there are no rows. */
  readonly emptyMessage = input('No rows');
  readonly sortBy = output<string>();

  protected readonly icons = { ArrowDown, ArrowUp, Copy };
  protected readonly rowHeight = ROW_HEIGHT;
  protected readonly headerHeight = HEADER_HEIGHT;
  protected readonly formatCell = formatCell;
  private readonly viewport = signal({ top: 0, height: 400 });
  /** The clicked cell; a new result clears it. */
  protected readonly selected = linkedSignal<unknown[][], { row: number; col: number } | null>({ source: this.rows, computation: () => null });
  protected readonly widths = computed(() => {
    const rows = this.rows().slice(0, 200);
    return this.columns().map((c, i) => {
      let max = c.name.length;
      for (const r of rows) max = Math.max(max, formatCell(r[i]).length);
      return Math.min(360, Math.max(72, Math.round(max * 7.2) + 20));
    });
  });
  protected readonly totalWidth = computed(() => INDEX_WIDTH + this.widths().reduce((a, b) => a + b, 0));
  protected readonly template = computed(() => `${INDEX_WIDTH}px ${this.widths().map((w) => `${w}px`).join(' ')}`);
  protected readonly visible = computed(() => {
    const { top, height } = this.viewport();
    const rows = this.rows();
    const start = Math.max(0, Math.floor(top / ROW_HEIGHT) - OVERSCAN);
    const end = Math.min(rows.length, Math.ceil((top + height) / ROW_HEIGHT) + OVERSCAN);
    return rows.slice(start, end).map((cells, i) => ({ index: start + i, cells }));
  });
  protected readonly selectedText = computed(() => {
    const selected = this.selected();
    return selected ? formatCellFull(this.rows()[selected.row]?.[selected.col]) : '';
  });

  constructor() {
    const destroyRef = inject(DestroyRef);
    afterNextRender(() => {
      const el = this.scroller().nativeElement;
      const measure = () => this.viewport.update((v) => (v.height === el.clientHeight ? v : { ...v, height: el.clientHeight }));
      measure();
      const observer = new ResizeObserver(measure);
      observer.observe(el);
      destroyRef.onDestroy(() => observer.disconnect());
    });

    // A new result starts at the top; the scroll event that follows moves the window of rows.
    afterRenderEffect({
      write: () => {
        this.rows();
        this.scroller().nativeElement.scrollTop = 0;
      },
    });
  }

  protected scrolled(): void {
    const top = this.scroller().nativeElement.scrollTop;
    this.viewport.update((v) => (v.top === top ? v : { ...v, top }));
  }

  protected requestSort(column: string): void {
    if (this.sortable()) this.sortBy.emit(column);
  }

  protected select(row: number, col: number): void {
    this.selected.set({ row, col });
  }

  protected isNull(value: unknown): boolean {
    return value === null || value === undefined;
  }

  protected copySelected(): void {
    this.toasts.copy(this.selectedText());
  }
}
