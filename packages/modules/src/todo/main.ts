import { QuiverError, addTodo, clearCompletedTodos, defineCommand, defineModule, newId, updateTodo, type CommandContext, type TodoItem, type WorkspaceApi } from '@quiver/core';
import { z } from 'zod';

const DOC = 'todos';

function ws(ctx: CommandContext): WorkspaceApi {
  if (!ctx.workspace) throw new QuiverError('NO_WORKSPACE', 'Open a workspace first');
  return ctx.workspace;
}

// Writes to one workspace's list run one after another, so two quick edits cannot lose each other.
const queues = new Map<string, Promise<unknown>>();

async function change<T>(w: WorkspaceApi, ctx: CommandContext, fn: (items: TodoItem[]) => { items: TodoItem[]; result: T }): Promise<T> {
  const run = async () => {
    const items = await w.store.readLocal<TodoItem[]>(DOC, []);
    const { items: next, result } = fn(items);
    await w.store.writeLocal(DOC, next);
    ctx.host.emit('todo.changed', { workspaceId: w.id });
    return result;
  };
  const queued = (queues.get(w.id) ?? Promise.resolve()).then(run, run);
  queues.set(w.id, queued.catch(() => undefined));
  return queued;
}

const list = defineCommand({
  id: 'todo.list',
  title: 'List todos',
  description: "The workspace's todo list: open items and the completed ones not cleared yet. Kept on this machine, not committed.",
  scope: 'workspace',
  input: z.object({}),
  handler: async (_i, ctx) => ws(ctx).store.readLocal<TodoItem[]>(DOC, []),
});

const add = defineCommand({
  id: 'todo.add',
  title: 'Add todo',
  description: 'Adds an item to the end of the workspace todo list, with optional notes.',
  scope: 'workspace',
  input: z.object({ title: z.string().trim().min(1), notes: z.string().default('') }),
  handler: async ({ title, notes }, ctx) =>
    change(ws(ctx), ctx, (items) => {
      const { items: next, item } = addTodo(items, title, notes, newId(), new Date().toISOString());
      return { items: next, result: item };
    }),
});

const update = defineCommand({
  id: 'todo.update',
  title: 'Update todo',
  description: 'Changes the title, notes or done state of a todo.',
  scope: 'workspace',
  input: z.object({ id: z.string(), title: z.string().optional(), notes: z.string().optional(), done: z.boolean().optional() }),
  handler: async ({ id, ...patch }, ctx) =>
    change(ws(ctx), ctx, (items) => {
      const updated = updateTodo(items, id, patch, new Date().toISOString());
      if (!updated) throw new QuiverError('NOT_FOUND', `Todo ${id} not found`);
      return { items: updated.items, result: updated.item };
    }),
});

const remove = defineCommand({
  id: 'todo.remove',
  title: 'Remove todo',
  description: 'Deletes one todo, done or not.',
  scope: 'workspace',
  mutating: true,
  input: z.object({ id: z.string() }),
  handler: async ({ id }, ctx) =>
    change(ws(ctx), ctx, (items) => ({ items: items.filter((t) => t.id !== id), result: { removed: items.some((t) => t.id === id) } })),
});

const clear = defineCommand({
  id: 'todo.clear',
  title: 'Clear completed todos',
  description: 'Deletes every completed todo.',
  scope: 'workspace',
  mutating: true,
  input: z.object({}),
  handler: async (_i, ctx) =>
    change(ws(ctx), ctx, (items) => {
      const { items: next, removed } = clearCompletedTodos(items);
      return { items: next, result: { removed } };
    }),
});

export const todoModule = defineModule({ id: 'todo', commands: [list, add, update, remove, clear] });
