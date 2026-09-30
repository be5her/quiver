import { sortTodos, toErrorPayload, type TodoItem } from '@quiver/core';
import { Button, Checkbox, IconButton, Input, SectionHeader, Spinner, cn, invoke, notify, useInvoke } from '@quiver/ui';
import { ChevronDown, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

async function run(id: string, input: unknown): Promise<void> {
  try {
    await invoke(id, input);
  } catch (err) {
    notify(toErrorPayload(err).message, 'error');
  }
}

/** The day's list: type a line and press Enter, tick it off, open a line to read it in full and write notes, clear the done ones. */
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
      <div className="flex-1 min-h-0 overflow-y-auto" data-testid="todo-list">
        {todos.loading && !todos.data && (
          <div className="px-3 py-2">
            <Spinner />
          </div>
        )}
        {todos.data?.length === 0 && <p className="px-3 py-2 text-xs text-muted">Nothing yet. Add what you plan to do today; the list stays on this machine and is not committed.</p>}
        {items.map((item) => (
          <div key={item.id} className={cn('group border-b border-edge/60', item.done && 'text-muted')} data-testid="todo-item" data-done={item.done || undefined} data-title={item.title}>
            {open === item.id ? <TodoEditor item={item} onCollapse={() => setOpen(null)} /> : <TodoLine item={item} onOpen={() => setOpen(item.id)} />}
          </div>
        ))}
        {todos.error && <p className="px-3 py-2 text-xs text-danger">{todos.error.message}</p>}
      </div>
    </div>
  );
}

function Tick({ item }: { item: TodoItem }) {
  // Sits on the first line of the title, however many lines that wraps to.
  return <Checkbox className="mt-[3px] shrink-0" checked={item.done} onChange={(e) => void run('todo.update', { id: item.id, done: e.target.checked })} aria-label={`Done: ${item.title}`} data-testid="todo-toggle" />;
}

/** A todo at rest: the title wraps instead of being cut at the panel's edge, with the start of its notes underneath. Click to open it. */
function TodoLine({ item, onOpen }: { item: TodoItem; onOpen(): void }) {
  const notes = item.notes.trim();
  return (
    <div className="flex items-start gap-2 pl-3 pr-1.5 py-1.5">
      <Tick item={item} />
      <button type="button" onClick={onOpen} className="flex-1 min-w-0 text-left rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50" data-testid="todo-title">
        <span className={cn('text-[13px] leading-5 wrap-anywhere line-clamp-3', item.done && 'line-through')}>{item.title}</span>
        {notes && (
          <span className="mt-0.5 text-xs leading-[1.125rem] text-muted wrap-anywhere line-clamp-2" data-testid="todo-notes-preview">
            {notes}
          </span>
        )}
      </button>
      <IconButton label="Remove" size="sm" className="shrink-0 -mt-0.5 opacity-0 group-hover:opacity-100 focus-visible:opacity-100" onClick={() => void run('todo.remove', { id: item.id })} data-testid="todo-remove">
        <X className="size-3.5" />
      </IconButton>
    </div>
  );
}

// Fields as tall as their text, so a long title or long notes are read without scrolling inside a small box.
const FIELD = 'field-sizing-content resize-none rounded-md border bg-transparent text-fg placeholder:text-muted/70 focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/30';

/** An open todo: the whole title and the notes, both editable in place, saved a moment after typing stops and when a field loses focus. */
function TodoEditor({ item, onCollapse }: { item: TodoItem; onCollapse(): void }) {
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
    <>
      <div className="flex items-start gap-2 pl-3 pr-1.5 pt-1.5">
        <Tick item={item} />
        {/* Padding and negative margin cancel out, so the text stays where it was in the closed row. */}
        <textarea
          value={title}
          rows={1}
          spellCheck={false}
          className={cn(FIELD, 'flex-1 min-w-0 -mx-[7px] -my-[3px] px-1.5 py-0.5 border-transparent hover:border-edge text-[13px] leading-5 wrap-anywhere', item.done && 'line-through')}
          onChange={(e) => {
            // A title is one line of text, however many rows it wraps to.
            const next = e.target.value.replace(/\s*\n\s*/g, ' ');
            setTitle(next);
            schedule({ title: next, notes });
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              e.currentTarget.blur();
            }
          }}
          onBlur={flush}
          aria-label="Title"
          data-testid="todo-edit-title"
        />
        <IconButton label="Collapse" size="sm" className="shrink-0 -mt-0.5" onClick={onCollapse} data-testid="todo-collapse">
          <ChevronDown className="size-3.5" />
        </IconButton>
      </div>
      <div className="flex flex-col gap-1.5 px-3 pt-2 pb-2">
        <textarea
          value={notes}
          placeholder="Notes"
          spellCheck={false}
          className={cn(FIELD, 'w-full min-h-16 max-h-[50vh] px-2.5 py-1.5 border-edge text-[13px] leading-relaxed wrap-anywhere')}
          onChange={(e) => {
            setNotes(e.target.value);
            schedule({ title, notes: e.target.value });
          }}
          onBlur={flush}
          aria-label="Notes"
          data-testid="todo-notes"
        />
        <div className="flex items-center gap-2 min-w-0">
          <p className="flex-1 min-w-0 truncate text-[11px] text-muted" data-testid="todo-dates">
            {item.completedAt ? `Done ${new Date(item.completedAt).toLocaleString()}` : `Added ${new Date(item.createdAt).toLocaleString()}`}
          </p>
          <Button size="sm" variant="danger" icon={<X className="size-3.5" />} onClick={() => void run('todo.remove', { id: item.id })} data-testid="todo-remove">
            Remove
          </Button>
        </div>
      </div>
    </>
  );
}
