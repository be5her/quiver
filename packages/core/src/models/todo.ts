/** One line of the per-workspace todo list, kept per machine under `.quiver/local/todos.json`. */
export interface TodoItem {
  id: string;
  title: string;
  notes: string;
  done: boolean;
  createdAt: string;
  completedAt?: string;
}

export function addTodo(items: readonly TodoItem[], title: string, notes: string, id: string, now: string): { items: TodoItem[]; item: TodoItem } {
  const item: TodoItem = { id, title: title.trim(), notes, done: false, createdAt: now };
  return { items: [...items, item], item };
}

/** Change a todo's title, notes or done state; `completedAt` follows `done`. Returns null for an unknown id. */
export function updateTodo(items: readonly TodoItem[], id: string, patch: { title?: string; notes?: string; done?: boolean }, now: string): { items: TodoItem[]; item: TodoItem } | null {
  const index = items.findIndex((t) => t.id === id);
  if (index < 0) return null;
  const current = items[index];
  const done = patch.done ?? current.done;
  const item: TodoItem = {
    ...current,
    title: patch.title === undefined ? current.title : patch.title.trim() || current.title,
    notes: patch.notes ?? current.notes,
    done,
    completedAt: done ? (current.done ? current.completedAt : now) : undefined,
  };
  return { items: items.map((t, i) => (i === index ? item : t)), item };
}

/** Drop the completed todos. */
export function clearCompletedTodos(items: readonly TodoItem[]): { items: TodoItem[]; removed: number } {
  const kept = items.filter((t) => !t.done);
  return { items: kept, removed: items.length - kept.length };
}

/** Open todos first in the order they were added, then the completed ones. */
export function sortTodos(items: readonly TodoItem[]): TodoItem[] {
  return [...items.filter((t) => !t.done), ...items.filter((t) => t.done)];
}
