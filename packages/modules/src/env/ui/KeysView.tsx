import { ENV_MASK, isValidDotenvKey, toErrorPayload, type DotenvEntry, type EnvFileContent } from '@quiver/core';
import { Button, IconButton, Input, cn, confirmDialog, invoke, notify } from '@quiver/ui';
import { Check, Eye, EyeOff, Plus, Trash2, X } from 'lucide-react';
import { useEffect, useState } from 'react';

export function KeysView({ content, reveal, onChanged }: { content: EnvFileContent; reveal: boolean; onChanged(): Promise<void> }) {
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [adding, setAdding] = useState(false);

  useEffect(() => setRevealed(new Set()), [content.path]);

  const setValue = async (key: string, value: string, comment?: string | null) => {
    try {
      await invoke('env.file.set', { path: content.path, entries: [{ key, value, ...(comment !== undefined ? { comment } : {}) }] });
      await onChanged();
      return true;
    } catch (err) {
      notify(toErrorPayload(err).message, 'error');
      return false;
    }
  };

  const remove = async (key: string) => {
    if (!(await confirmDialog({ title: `Remove ${key}?`, message: 'Every line defining this key is removed from the file.', danger: true, confirmLabel: 'Remove' }))) return;
    try {
      await invoke('env.file.unset', { path: content.path, keys: [key] });
      await onChanged();
    } catch (err) {
      notify(toErrorPayload(err).message, 'error');
    }
  };

  const add = async () => {
    const key = newKey.trim();
    if (!isValidDotenvKey(key)) {
      notify('Keys use letters, digits, _ . and - only', 'error');
      return;
    }
    if (content.entries.some((e) => e.key === key && !e.shadowed)) {
      notify(`${key} already exists; edit it in the table`, 'error');
      return;
    }
    setAdding(true);
    if (await setValue(key, newValue)) {
      setNewKey('');
      setNewValue('');
    }
    setAdding(false);
  };

  const entries = content.entries;

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex-1 min-h-0 overflow-auto">
        {entries.length === 0 && <p className="px-3 py-3 text-xs text-muted">No keys yet. Add one below, or paste a whole file in the Text view.</p>}
        {entries.length > 0 && (
          <table className="w-full text-[12.5px] border-collapse">
            <thead className="sticky top-0 bg-canvas z-10">
              <tr className="text-[11px] uppercase tracking-wide text-muted text-left">
                <th className="px-3 py-1.5 font-medium w-[32%]">Key</th>
                <th className="px-2 py-1.5 font-medium">Value</th>
                <th className="px-2 py-1.5 font-medium w-8" />
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <EntryRow
                  key={`${e.key}:${e.line}`}
                  entry={e}
                  shown={reveal || revealed.has(`${e.key}:${e.line}`)}
                  onToggle={() =>
                    setRevealed((s) => {
                      const next = new Set(s);
                      const id = `${e.key}:${e.line}`;
                      if (next.has(id)) next.delete(id);
                      else next.add(id);
                      return next;
                    })
                  }
                  onSave={(value) => setValue(e.key, value)}
                  onRemove={() => remove(e.key)}
                />
              ))}
            </tbody>
          </table>
        )}
        {content.invalid > 0 && (
          <p className="px-3 py-2 text-[11px] text-warning">
            {content.invalid} line{content.invalid > 1 ? 's' : ''} could not be parsed and {content.invalid > 1 ? 'are' : 'is'} kept as is. See the Text view.
          </p>
        )}
      </div>
      <div className="flex items-center gap-2 px-3 py-2 border-t border-edge shrink-0">
        <Input value={newKey} onChange={(e) => setNewKey(e.target.value.toUpperCase())} placeholder="NEW_KEY" className="w-56 h-7 font-mono text-xs" data-testid="env-add-key" onKeyDown={(e) => e.key === 'Enter' && void add()} />
        <Input value={newValue} onChange={(e) => setNewValue(e.target.value)} placeholder="value" className="h-7 font-mono text-xs" data-testid="env-add-value" onKeyDown={(e) => e.key === 'Enter' && void add()} />
        <Button size="sm" variant="secondary" icon={<Plus className="size-3.5" />} loading={adding} disabled={!newKey.trim()} onClick={() => void add()} data-testid="env-add">
          Add
        </Button>
      </div>
    </div>
  );
}

function EntryRow({ entry, shown, onToggle, onSave, onRemove }: { entry: DotenvEntry; shown: boolean; onToggle(): void; onSave(value: string): Promise<boolean>; onRemove(): void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(entry.value);
  const [saving, setSaving] = useState(false);
  const masked = entry.secret && entry.value !== '' && !shown;

  useEffect(() => {
    if (!editing) setDraft(entry.value);
  }, [entry.value, editing]);

  const commit = async () => {
    if (draft === entry.value) {
      setEditing(false);
      return;
    }
    setSaving(true);
    const ok = await onSave(draft);
    setSaving(false);
    if (ok) setEditing(false);
  };

  return (
    <tr className={cn('border-t border-edge/60 hover:bg-elevated/60 group align-top', entry.shadowed && 'opacity-60')} data-testid="env-entry" data-key={entry.key} data-masked={masked ? 'true' : 'false'}>
      <td className="px-3 py-1 font-mono whitespace-nowrap">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="truncate" title={`line ${entry.line}`}>
            {entry.exported && <span className="text-muted">export </span>}
            {entry.key}
          </span>
          {entry.shadowed && <Tag title="A later line defines this key again; that one wins">shadowed</Tag>}
          {entry.interpolates && <Tag title="References another variable (dotenv-expand syntax)">$ref</Tag>}
          {entry.value === '' && <Tag className="text-warning">empty</Tag>}
        </div>
      </td>
      <td className="px-2 py-1 font-mono min-w-0">
        {editing ? (
          <div className="flex items-center gap-1">
            <Input
              autoFocus
              type={entry.secret && !shown ? 'password' : 'text'}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="h-6 text-xs font-mono"
              data-testid="env-value-input"
              onKeyDown={(e) => {
                if (e.key === 'Enter') void commit();
                if (e.key === 'Escape') {
                  setDraft(entry.value);
                  setEditing(false);
                }
              }}
            />
            <IconButton label="Save value" size="sm" onClick={() => void commit()} disabled={saving} data-testid="env-value-save">
              <Check className="size-3.5" />
            </IconButton>
            <IconButton
              label="Cancel"
              size="sm"
              onClick={() => {
                setDraft(entry.value);
                setEditing(false);
              }}
            >
              <X className="size-3.5" />
            </IconButton>
          </div>
        ) : (
          <div className="flex items-start gap-1.5 min-w-0">
            <button
              type="button"
              className={cn('text-left break-all whitespace-pre-wrap flex-1 min-w-0 rounded px-1 -mx-1 hover:bg-surface', masked && 'tracking-wider text-muted', entry.value === '' && 'text-muted/60 italic')}
              onClick={() => setEditing(true)}
              title="Click to edit"
              data-testid="env-value"
            >
              {masked ? ENV_MASK : entry.value === '' ? '(empty)' : entry.value}
            </button>
            {entry.comment && (
              <span className="text-muted text-[11px] truncate max-w-[40%] shrink-0" title={entry.comment}>
                # {entry.comment}
              </span>
            )}
            {entry.secret && entry.value !== '' && (
              <IconButton label={shown ? 'Hide value' : 'Show value'} size="sm" className="opacity-0 group-hover:opacity-100 shrink-0" onClick={onToggle} data-testid="env-value-toggle">
                {shown ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
              </IconButton>
            )}
          </div>
        )}
      </td>
      <td className="px-1 py-1">
        <IconButton label="Remove key" size="sm" className="opacity-0 group-hover:opacity-100" onClick={onRemove}>
          <Trash2 className="size-3.5" />
        </IconButton>
      </td>
    </tr>
  );
}

function Tag({ children, title, className }: { children: React.ReactNode; title?: string; className?: string }) {
  return (
    <span className={cn('text-[10px] rounded bg-elevated px-1 text-muted shrink-0 font-sans', className)} title={title}>
      {children}
    </span>
  );
}
