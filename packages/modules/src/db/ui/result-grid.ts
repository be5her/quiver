import { Component, DestroyRef, ElementRef, afterNextRender, afterRenderEffect, booleanAttribute, computed, inject, input, linkedSignal, output, signal, viewChild } from '@angular/core';
import { coerceCellInput, sqlLiteral, type DbForeignKey, type DbResultColumn, type SqlKind } from '@quiver/core';
import { Autofocus, ContextMenu, Icon, IconButton, Toasts, type ContextMenuItem } from '@quiver/ui';
import { ArrowDown, ArrowUp, ArrowUpRight, Copy, PanelRight } from 'lucide';
import { formatCell, formatCellFull } from './db-format';

const ROW_HEIGHT = 26;
const HEADER_HEIGHT = 28;
const INDEX_WIDTH = 48;
const OVERSCAN = 8;

export interface GridSort {
  column: string;
  direction: 'asc' | 'desc';
}

export interface CellEdit {
  row: number;
  col: number;
  /** The typed text coerced to the column's type, or null for "set NULL". */
  value: unknown;
}

export interface FollowKey {
  key: DbForeignKey;
  /** The values of the key's columns in the row, in key order. */
  values: unknown[];
}

export interface FilterBy {
  column: string;
  value: unknown;
}

interface CellRef {
  row: number;
  col: number;
}

/**
 * Windowed grid: only rows inside the viewport (plus a few) exist in the DOM, so 5,000 rows by 40
 * columns scroll as smoothly as 50. Click a cell to see its full value, right-click it for actions,
 * and in `editable` mode double-click (or Enter) to change it. Pending changes come back in from the
 * parent (`changes`, `deleted`, `insertedFrom`) so the grid itself stays stateless about them.
 */
@Component({
  selector: 'q-result-grid',
  imports: [Autofocus, Icon, IconButton],
  templateUrl: './result-grid.html',
  host: { class: 'flex flex-col h-full min-h-0', '(keydown)': 'keydown($event)' },
})
export class ResultGrid {
  private readonly toasts = inject(Toasts);
  private readonly contextMenu = inject(ContextMenu);
  private readonly scroller = viewChild.required<ElementRef<HTMLDivElement>>('scroller');

  readonly columns = input.required<DbResultColumn[]>();
  readonly rows = input.required<unknown[][]>();
  /** Sort indicator for the header. */
  readonly sort = input<GridSort | null>(null);
  /** Header clicks ask for a sort. */
  readonly sortable = input(false, { transform: booleanAttribute });
  /** Shown in the grid when there are no rows. */
  readonly emptyMessage = input('No rows');
  /** Cells can be edited and rows deleted; the parent collects the changes. */
  readonly editable = input(false, { transform: booleanAttribute });
  /** The context menu offers "Filter by this value". */
  readonly filterable = input(false, { transform: booleanAttribute });
  /** For "copy as SQL literal"; null hides it. */
  readonly sqlKind = input<SqlKind | null>(null);
  /** Foreign keys of the table shown; cells of their columns get a follow arrow. */
  readonly foreignKeys = input<DbForeignKey[]>([]);
  /** Pending edits: row index to column index to the new value. */
  readonly changes = input<Record<number, Record<number, unknown>>>({});
  /** Rows marked for deletion. */
  readonly deleted = input<readonly number[]>([]);
  /** Rows from this index on are new, not yet in the database. */
  readonly insertedFrom = input<number | null>(null);

  readonly sortBy = output<string>();
  readonly cellEdit = output<CellEdit>();
  readonly toggleDelete = output<number>();
  readonly filterBy = output<FilterBy>();
  readonly follow = output<FollowKey>();

  protected readonly icons = { ArrowDown, ArrowUp, ArrowUpRight, Copy, PanelRight };
  protected readonly rowHeight = ROW_HEIGHT;
  protected readonly headerHeight = HEADER_HEIGHT;
  protected readonly formatCell = formatCell;
  protected readonly formatCellFull = formatCellFull;
  private readonly viewport = signal({ top: 0, height: 400 });
  /** The clicked cell; a new result clears it. */
  protected readonly selected = linkedSignal<unknown[][], CellRef | null>({ source: this.rows, computation: () => null });
  /** The cell being edited inline. */
  protected readonly editing = linkedSignal<unknown[][], CellRef | null>({ source: this.rows, computation: () => null });
  protected readonly draft = signal('');
  /** The transposed view of the selected row. */
  protected readonly detailOpen = signal(false);
  private readonly deletedSet = computed(() => new Set(this.deleted()));
  /** Column index to the foreign key whose first column it is. */
  private readonly keyByColumn = computed(() => {
    const map = new Map<number, DbForeignKey>();
    const names = this.columns().map((c) => c.name);
    for (const key of this.foreignKeys()) {
      const index = names.indexOf(key.columns[0]);
      if (index >= 0 && !map.has(index)) map.set(index, key);
    }
    return map;
  });
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
    return selected ? formatCellFull(this.valueAt(selected.row, selected.col)) : '';
  });
  /** The selected row, column by column, for the detail panel. */
  protected readonly detailRows = computed(() => {
    const selected = this.selected();
    if (!selected || !this.detailOpen()) return [];
    return this.columns().map((c, i) => ({ name: c.name, type: c.type, value: this.valueAt(selected.row, i), changed: this.isChanged(selected.row, i) }));
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

  /** The value shown: the pending edit when there is one, else the stored value. */
  protected valueAt(row: number, col: number): unknown {
    const pending = this.changes()[row];
    return pending && col in pending ? pending[col] : this.rows()[row]?.[col];
  }

  protected isChanged(row: number, col: number): boolean {
    const pending = this.changes()[row];
    return Boolean(pending && col in pending);
  }

  protected isDeleted(row: number): boolean {
    return this.deletedSet().has(row);
  }

  protected isInserted(row: number): boolean {
    const from = this.insertedFrom();
    return from !== null && row >= from;
  }

  protected keyFor(col: number): DbForeignKey | undefined {
    return this.keyByColumn().get(col);
  }

  protected rowClass(row: number): string {
    return `${row % 2 === 1 ? 'bg-elevated/25' : ''}${this.isDeleted(row) ? ' line-through opacity-50' : ''}${this.isInserted(row) ? ' bg-success/10' : ''}`;
  }

  protected cellClass(row: number, col: number, value: unknown): string {
    const selected = this.selected();
    return (
      (this.isNull(value) ? 'text-muted italic' : '') +
      (this.isChanged(row, col) ? ' bg-warning/15' : '') +
      (selected?.row === row && selected?.col === col ? ' ring-1 ring-inset ring-accent bg-accent/10' : '')
    );
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

  protected toggleDetail(): void {
    this.detailOpen.update((open) => !open);
  }

  // ---------- editing ----------

  protected startEdit(row: number, col: number): void {
    if (!this.editable() || this.isDeleted(row)) return;
    const value = this.valueAt(row, col);
    if (value !== null && typeof value === 'object' && '$bytes' in (value as object)) {
      this.toasts.notify('Binary values cannot be edited here', 'info');
      return;
    }
    this.selected.set({ row, col });
    this.draft.set(this.isNull(value) ? '' : typeof value === 'string' ? value : formatCell(value));
    this.editing.set({ row, col });
  }

  protected draftTyped(event: Event): void {
    this.draft.set((event.target as HTMLInputElement).value);
  }

  protected commitEdit(move: 'next' | 'previous' | null = null): void {
    const editing = this.editing();
    if (!editing) return;
    const column = this.columns()[editing.col];
    const text = this.draft();
    const before = this.valueAt(editing.row, editing.col);
    const value = coerceCellInput(text, column?.type);
    // Typing the same text back is not a change; typing anything into a NULL cell is.
    if (this.isNull(before) ? true : formatCell(before) !== text) this.cellEdit.emit({ row: editing.row, col: editing.col, value });
    this.editing.set(null);
    if (move) {
      const cols = this.columns().length;
      const next = move === 'next' ? editing.col + 1 : editing.col - 1;
      if (next >= 0 && next < cols) this.startEdit(editing.row, next);
      else this.focusGrid();
    } else {
      this.focusGrid();
    }
  }

  protected cancelEdit(): void {
    this.editing.set(null);
    this.focusGrid();
  }

  protected editorKeys(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      this.commitEdit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      this.cancelEdit();
    } else if (event.key === 'Tab') {
      event.preventDefault();
      this.commitEdit(event.shiftKey ? 'previous' : 'next');
    }
    event.stopPropagation();
  }

  protected keydown(event: KeyboardEvent): void {
    if (this.editing()) return;
    const selected = this.selected();
    if (!selected) return;
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
    const rows = this.rows().length;
    const cols = this.columns().length;
    const move = (row: number, col: number) => {
      event.preventDefault();
      this.selected.set({ row: Math.max(0, Math.min(rows - 1, row)), col: Math.max(0, Math.min(cols - 1, col)) });
      this.scrollRowIntoView(row);
    };
    switch (event.key) {
      case 'ArrowDown':
        return move(selected.row + 1, selected.col);
      case 'ArrowUp':
        return move(selected.row - 1, selected.col);
      case 'ArrowRight':
        return move(selected.row, selected.col + 1);
      case 'ArrowLeft':
        return move(selected.row, selected.col - 1);
      case 'Enter':
      case 'F2':
        if (this.editable()) {
          event.preventDefault();
          this.startEdit(selected.row, selected.col);
        }
        return;
      case 'c':
      case 'C':
        if (event.ctrlKey || event.metaKey) {
          if (window.getSelection()?.toString()) return;
          event.preventDefault();
          this.copySelected();
        }
        return;
      default:
        return;
    }
  }

  private scrollRowIntoView(row: number): void {
    const el = this.scroller().nativeElement;
    const top = HEADER_HEIGHT + row * ROW_HEIGHT;
    if (top < el.scrollTop + HEADER_HEIGHT) el.scrollTop = top - HEADER_HEIGHT;
    else if (top + ROW_HEIGHT > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_HEIGHT - el.clientHeight;
  }

  private focusGrid(): void {
    this.scroller().nativeElement.focus({ preventScroll: true });
  }

  // ---------- context menu ----------

  protected openMenu(event: MouseEvent, row: number, col: number): void {
    this.selected.set({ row, col });
    const value = this.valueAt(row, col);
    const column = this.columns()[col];
    const kind = this.sqlKind();
    const key = this.keyFor(col);
    const items: ContextMenuItem[] = [
      { label: 'Copy value', shortcut: 'Ctrl+C', select: () => this.toasts.copy(formatCellFull(value)) },
      { label: 'Copy row as JSON', select: () => this.toasts.copy(JSON.stringify(Object.fromEntries(this.columns().map((c, i) => [c.name, this.valueAt(row, i) ?? null])), null, 2)) },
    ];
    if (kind) items.push({ label: 'Copy as SQL literal', select: () => this.toasts.copy(sqlLiteral(kind, value)) });
    if (this.filterable() || key) items.push('separator');
    if (this.filterable()) items.push({ label: `Filter by ${column.name} = this value`, select: () => this.filterBy.emit({ column: column.name, value }) });
    if (key) items.push({ label: `Open ${key.refTable} row`, disabled: this.isNull(value), select: () => this.followKey(row, key) });
    if (this.editable()) {
      const deleted = this.isDeleted(row);
      items.push('separator', { label: 'Edit cell', shortcut: 'Enter', disabled: deleted, select: () => this.startEdit(row, col) });
      // NULL is a SQL notion; a Redis grid removes items instead.
      if (kind) items.push({ label: 'Set NULL', disabled: deleted || this.isNull(value), select: () => this.cellEdit.emit({ row, col, value: null }) });
      items.push({ label: deleted ? 'Keep row' : this.isInserted(row) ? 'Remove new row' : kind ? 'Delete row' : 'Remove', danger: !deleted, select: () => this.toggleDelete.emit(row) });
    }
    items.push('separator', { label: this.detailOpen() ? 'Hide row detail' : 'Show row detail', select: () => this.toggleDetail() });
    this.contextMenu.open(event, items);
  }

  protected followKey(row: number, key: DbForeignKey): void {
    const names = this.columns().map((c) => c.name);
    this.follow.emit({ key, values: key.columns.map((name) => this.valueAt(row, names.indexOf(name))) });
  }
}
