import { sortTodos, toErrorPayload, type TodoItem } from '@quiver/core';
import { Checkbox, IconButton, Input, SectionHeader, Spinner, TextArea, cn, invoke, notify, useInvoke } from '@quiver/ui';
import { ChevronDown, ChevronRight, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

async function run(id: string, input: unknown): Promise<void> {
  try {
    await invoke(id, input);
  } catch (err) {
    notify(toErrorPayload(err).message, 'error');
  }
}

/** The day's list: type a line and press Enter, tick it off, open a line for notes, clear the done ones. */
export function TodoSidebar() {
  const todos = useInvoke<TodoItem[]>('todo.list', {}, { refreshOnEvents: ['todo.changed'] });
  const [draft, setDraft] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const items = sortTodos(todos.data ?? []);
  const done = items.filter((t) => t.done).length;

  const add = async () => {
    const title = draft.trim();
    if (!title) return;
    setDraft('');
    await run('todo.add', { title });
  };

  return (
    <div className="flex flex-col h-full min-h-0 text-sm">
      <SectionHeader
        title={items.length ? `List · ${done}/${items.length} done` : 'List'}
        actions={
          <IconButton label="Clear completed" size="sm" disabled={done === 0} onClick={() => void run('todo.clear', {})} data-testid="todo-clear">
            <Trash2 className="size-3.5" />
          </IconButton>
        }
      />
      <div className="px-3 pb-2">
        <Input
          value={draft}
          placeholder="Add a todo, then Enter"
          className="h-7"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void add();
            }
          }}
          data-testid="todo-input"
        />
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {todos.loading && !todos.data && (
          <div className="px-3 py-2">
            <Spinner />
          </div>
        )}
        {todos.data?.length === 0 && <p className="px-3 py-2 text-xs text-muted">Nothing yet. Add what you plan to do today; the list stays on this machine and is not committed.</p>}
        {items.map((item) => (
          <TodoRow key={item.id} item={item} open={open === item.id} onToggleOpen={() => setOpen(open === item.id ? null : item.id)} />
        ))}
        {todos.error && <p className="px-3 py-2 text-xs text-danger">{todos.error.message}</p>}
      </div>
    </div>
  );
}

function TodoRow({ item, open, onToggleOpen }: { item: TodoItem; open: boolean; onToggleOpen(): void }) {
  return (
    <div className={cn('group border-b border-edge/60', item.done && 'text-muted')} data-testid="todo-item" data-done={item.done || undefined} data-title={item.title}>
      <div className="flex items-center gap-2 pl-3 pr-1.5 h-8">
        <Checkbox checked={item.done} onChange={(e) => void run('todo.update', { id: item.id, done: e.target.checked })} aria-label={`Done: ${item.title}`} data-testid="todo-toggle" />
        <button type="button" onClick={onToggleOpen} className="flex-1 min-w-0 flex items-center gap-1 text-left" title={item.notes || undefined} data-testid="todo-title">
          <span className={cn('truncate', item.done && 'line-through')}>{item.title}</span>
          {item.notes && !open && <span className="size-1.5 rounded-full bg-accent/60 shrink-0" title="Has notes" />}
          <span className="flex-1" />
          {open ? <ChevronDown className="size-3.5 shrink-0 text-muted" /> : <ChevronRight className="size-3.5 shrink-0 text-muted opacity-0 group-hover:opacity-100" />}
        </button>
        <IconButton label="Remove" size="sm" className="opacity-0 group-hover:opacity-100" onClick={() => void run('todo.remove', { id: item.id })} data-testid="todo-remove">
          <X className="size-3.5" />
        </IconButton>
      </div>
      {open && <TodoDetails item={item} />}
    </div>
  );
}

/** Title and notes, saved a moment after typing stops and when the field loses focus. */
function TodoDetails({ item }: { item: TodoItem }) {
  const [title, setTitle] = useState(item.title);
  const [notes, setNotes] = useState(item.notes);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<{ title: string; notes: string } | null>(null);

  const flush = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const p = pending.current;
    pending.current = null;
    if (p && (p.title.trim() !== item.title || p.notes !== item.notes)) void run('todo.update', { id: item.id, title: p.title, notes: p.notes });
  };
  const schedule = (next: { title: string; notes: string }) => {
    pending.current = next;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, 600);
  };
  // Save what is still pending when the row is collapsed or the panel goes away.
  useEffect(() => flush, []);

  return (
    <div className="flex flex-col gap-1.5 px-3 pb-2.5">
      <Input
        value={title}
        className="h-7"
        onChange={(e) => {
          setTitle(e.target.value);
          schedule({ title: e.target.value, notes });
        }}
        onBlur={flush}
        aria-label="Title"
        data-testid="todo-edit-title"
      />
      <TextArea
        value={notes}
        rows={3}
        placeholder="Notes"
        className="text-xs font-sans py-1.5"
        onChange={(e) => {
          setNotes(e.target.value);
          schedule({ title, notes: e.target.value });
        }}
        onBlur={flush}
        aria-label="Notes"
        data-testid="todo-notes"
      />
      {item.completedAt && <p className="text-[11px] text-muted">Done {new Date(item.completedAt).toLocaleString()}</p>}
    </div>
  );
}
