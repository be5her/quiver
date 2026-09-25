import { keyValue, type KeyValue } from '@quiver/core';
import { Plus, Trash2 } from 'lucide-react';
import { cn } from '../cn';
import { Checkbox, IconButton, Input } from './primitives';

export interface KeyValueEditorProps<T extends KeyValue> {
  rows: T[];
  onChange(rows: T[]): void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  /** Extra column rendered per row, e.g. a "secret" toggle. */
  extra?: (row: T, update: (patch: Partial<T>) => void) => React.ReactNode;
  extraHeader?: string;
  readOnly?: boolean;
  className?: string;
}

/** Table editor for params, headers, form fields and variables. Always keeps one blank row at the bottom. */
export function KeyValueEditor<T extends KeyValue>({
  rows,
  onChange,
  keyPlaceholder = 'Key',
  valuePlaceholder = 'Value',
  extra,
  extraHeader,
  readOnly,
  className,
}: KeyValueEditorProps<T>) {
  const update = (id: string, patch: Partial<T>) => onChange(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const remove = (id: string) => onChange(rows.filter((r) => r.id !== id));
  const add = () => onChange([...rows, keyValue() as T]);

  return (
    <div className={cn('text-sm', className)}>
      <div className="grid grid-cols-[24px_1fr_1fr_auto] gap-1 px-1 py-1 text-[11px] font-medium text-muted uppercase tracking-wide items-center">
        <span />
        <span>{keyPlaceholder}</span>
        <span>{valuePlaceholder}</span>
        <span className="w-16 text-right">{extraHeader ?? ''}</span>
      </div>
      <div className="flex flex-col gap-1">
        {rows.map((row) => (
          <div key={row.id} className="grid grid-cols-[24px_1fr_1fr_auto] gap-1 items-center px-1">
            <Checkbox checked={row.enabled} onChange={(e) => update(row.id, { enabled: e.target.checked } as Partial<T>)} disabled={readOnly} />
            <Input
              value={row.key}
              placeholder={keyPlaceholder}
              onChange={(e) => update(row.id, { key: e.target.value } as Partial<T>)}
              readOnly={readOnly}
              className="h-7 font-mono text-xs"
            />
            <Input
              value={row.value}
              placeholder={valuePlaceholder}
              onChange={(e) => update(row.id, { value: e.target.value } as Partial<T>)}
              readOnly={readOnly}
              className="h-7 font-mono text-xs"
            />
            <div className="flex items-center justify-end gap-1 w-16">
              {extra?.(row, (patch) => update(row.id, patch))}
              {!readOnly && (
                <IconButton label="Remove" size="sm" onClick={() => remove(row.id)}>
                  <Trash2 className="size-3.5" />
                </IconButton>
              )}
            </div>
          </div>
        ))}
      </div>
      {!readOnly && (
        <button
          type="button"
          onClick={add}
          className="mt-1 ml-8 inline-flex items-center gap-1 text-xs text-muted hover:text-fg px-1 py-1"
        >
          <Plus className="size-3.5" /> Add row
        </button>
      )}
    </div>
  );
}
