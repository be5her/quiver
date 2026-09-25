import type { DbResultColumn } from '@quiver/core';
import { IconButton, cn, notify } from '@quiver/ui';
import { ArrowDown, ArrowUp, Copy } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { formatCell, formatCellFull } from './shared';

const ROW_HEIGHT = 26;
const HEADER_HEIGHT = 28;
const INDEX_WIDTH = 48;
const OVERSCAN = 8;

export interface ResultGridProps {
  columns: DbResultColumn[];
  rows: unknown[][];
  /** Optional sort indicator and handler for header clicks. */
  sort?: { column: string; direction: 'asc' | 'desc' } | null;
  onSort?(column: string): void;
  className?: string;
  /** Shown under the grid when nothing is selected. */
  emptyMessage?: string;
}

/**
 * Windowed grid: only rows inside the viewport (plus a few) exist in the DOM, so
 * 5,000 rows by 40 columns scroll as smoothly as 50. Click a cell to see its full value.
 */
export function ResultGrid({ columns, rows, sort, onSort, className, emptyMessage = 'No rows' }: ResultGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 400 });
  const [selected, setSelected] = useState<{ row: number; col: number } | null>(null);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setViewport((v) => (v.height === el.clientHeight ? v : { ...v, height: el.clientHeight }));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    setSelected(null);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [rows]);

  const widths = useMemo(() => {
    const sample = rows.slice(0, 200);
    return columns.map((c, i) => {
      let max = c.name.length;
      for (const r of sample) max = Math.max(max, formatCell(r[i]).length);
      return Math.min(360, Math.max(72, Math.round(max * 7.2) + 20));
    });
  }, [columns, rows]);
  const totalWidth = INDEX_WIDTH + widths.reduce((a, b) => a + b, 0);
  const template = `${INDEX_WIDTH}px ${widths.map((w) => `${w}px`).join(' ')}`;

  const start = Math.max(0, Math.floor(viewport.top / ROW_HEIGHT) - OVERSCAN);
  const end = Math.min(rows.length, Math.ceil((viewport.top + viewport.height) / ROW_HEIGHT) + OVERSCAN);
  const visible = rows.slice(start, end);

  const onScroll = () => {
    const el = scrollRef.current;
    if (el) setViewport((v) => (v.top === el.scrollTop ? v : { ...v, top: el.scrollTop }));
  };

  const selectedValue = selected ? rows[selected.row]?.[selected.col] : undefined;

  return (
    <div className={cn('flex flex-col h-full min-h-0', className)}>
      <div ref={scrollRef} onScroll={onScroll} className="flex-1 min-h-0 overflow-auto font-mono text-xs select-text" role="grid" aria-rowcount={rows.length} aria-colcount={columns.length}>
        <div style={{ width: totalWidth, height: HEADER_HEIGHT + rows.length * ROW_HEIGHT, position: 'relative' }}>
          <div
            className="sticky top-0 z-10 grid bg-elevated border-b border-edge font-sans font-medium text-muted"
            style={{ gridTemplateColumns: template, height: HEADER_HEIGHT }}
            role="row"
          >
            <div className="px-2 flex items-center justify-end border-r border-edge/60">#</div>
            {columns.map((c, i) => {
              const sorted = sort?.column === c.name ? sort.direction : null;
              return (
                <button
                  key={`${c.name}-${i}`}
                  type="button"
                  role="columnheader"
                  onClick={() => onSort?.(c.name)}
                  className={cn('px-2 flex items-center gap-1 min-w-0 border-r border-edge/60 text-left', onSort ? 'hover:text-fg cursor-pointer' : 'cursor-default')}
                  title={c.type ? `${c.name}: ${c.type}` : c.name}
                >
                  <span className="truncate">{c.name}</span>
                  {sorted === 'asc' && <ArrowUp className="size-3 shrink-0" />}
                  {sorted === 'desc' && <ArrowDown className="size-3 shrink-0" />}
                </button>
              );
            })}
          </div>
          {visible.map((row, i) => {
            const index = start + i;
            return (
              <div
                key={index}
                role="row"
                className={cn('absolute left-0 grid items-center hover:bg-elevated/60', index % 2 === 1 && 'bg-elevated/25')}
                style={{ top: HEADER_HEIGHT + index * ROW_HEIGHT, height: ROW_HEIGHT, gridTemplateColumns: template, width: totalWidth }}
              >
                <div className="px-2 text-right text-muted border-r border-edge/40">{index + 1}</div>
                {columns.map((_, col) => {
                  const value = row[col];
                  const isNull = value === null || value === undefined;
                  const active = selected?.row === index && selected.col === col;
                  return (
                    <div
                      key={col}
                      role="gridcell"
                      onClick={() => setSelected({ row: index, col })}
                      className={cn('px-2 truncate h-full leading-[26px] border-r border-edge/40 cursor-default', isNull && 'text-muted italic', active && 'ring-1 ring-inset ring-accent bg-accent/10')}
                    >
                      {formatCell(value)}
                    </div>
                  );
                })}
              </div>
            );
          })}
          {rows.length === 0 && <div className="absolute inset-x-0 top-8 p-4 text-center text-muted font-sans">{emptyMessage}</div>}
        </div>
      </div>
      {selected && (
        <div className="shrink-0 border-t border-edge bg-surface flex items-start gap-2 px-2 py-1 max-h-32">
          <span className="text-[10px] uppercase tracking-wide text-muted shrink-0 pt-1">
            {columns[selected.col]?.name} · row {selected.row + 1}
          </span>
          <pre className="flex-1 min-w-0 overflow-auto text-xs font-mono whitespace-pre-wrap break-all max-h-28">{formatCellFull(selectedValue)}</pre>
          <IconButton
            label="Copy value"
            size="sm"
            onClick={() => {
              void navigator.clipboard.writeText(formatCellFull(selectedValue));
              notify('Copied', 'success');
            }}
          >
            <Copy className="size-3.5" />
          </IconButton>
        </div>
      )}
    </div>
  );
}
