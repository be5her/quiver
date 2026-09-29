import { describe, expect, it } from 'vitest';
import { addTodo, clearCompletedTodos, sortTodos, updateTodo, type TodoItem } from './todo';

const T0 = '2026-09-29T08:00:00.000Z';
const T1 = '2026-09-29T09:00:00.000Z';

describe('todo list', () => {
  it('adds a trimmed item at the end', () => {
    const { items, item } = addTodo([], '  fix the build ', '', 'a', T0);
    expect(item).toEqual({ id: 'a', title: 'fix the build', notes: '', done: false, createdAt: T0 });
    expect(items).toEqual([item]);
  });

  it('marks done with a completion time, and undone clears it', () => {
    const base = addTodo([], 'x', '', 'a', T0).items;
    const done = updateTodo(base, 'a', { done: true }, T1)!;
    expect(done.item.completedAt).toBe(T1);
    // Saving notes on a finished item keeps the original completion time.
    expect(updateTodo(done.items, 'a', { notes: 'n' }, '2026-09-30T00:00:00.000Z')!.item.completedAt).toBe(T1);
    expect(updateTodo(done.items, 'a', { done: false }, T1)!.item.completedAt).toBeUndefined();
    expect(updateTodo(base, 'nope', { done: true }, T1)).toBeNull();
  });

  it('keeps the old title when the new one is blank', () => {
    const base = addTodo([], 'keep me', 'note', 'a', T0).items;
    expect(updateTodo(base, 'a', { title: '   ' }, T1)!.item.title).toBe('keep me');
    expect(updateTodo(base, 'a', { title: ' new ' }, T1)!.item.title).toBe('new');
  });

  it('clears completed items and sorts open ones first', () => {
    const items: TodoItem[] = [
      { id: 'a', title: 'a', notes: '', done: true, createdAt: T0, completedAt: T1 },
      { id: 'b', title: 'b', notes: '', done: false, createdAt: T0 },
      { id: 'c', title: 'c', notes: '', done: true, createdAt: T0, completedAt: T1 },
    ];
    expect(sortTodos(items).map((t) => t.id)).toEqual(['b', 'a', 'c']);
    const cleared = clearCompletedTodos(items);
    expect(cleared.removed).toBe(2);
    expect(cleared.items.map((t) => t.id)).toEqual(['b']);
  });
});
