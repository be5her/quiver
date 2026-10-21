import path from 'node:path';
import {
  KeyValueSchema,
  QuiverError,
  RunnerTaskIdSchema,
  RunnerTaskSchema,
  newId,
  type CommandContext,
  type RunnerDiscoveredTask,
  type RunnerTask,
  type WorkspaceApi,
} from '@quiver/core';
import { z } from 'zod';
import { compilePattern, getProc, leavesFolder, stopTask, type RunnerProcInfo } from './supervisor';

// Saved tasks: one committed file per task in `.quiver/runner/<id>.json`, read by the supervisor with the same schema.

export const TASKS_COLLECTION = 'runner';

/** A task id, which names its file: what the store accepts, refused as invalid input rather than failing in the store. */
export const TaskIdSchema = RunnerTaskIdSchema;

/**
 * A task to save. Without `id` it is a new task; with one, the fields given replace the saved ones and the rest stay.
 * An empty `readyPattern` or `envProfile`, or a null `port`, clears it. A discovered task can be passed as it is.
 */
export const RunnerTaskDraftSchema = z.object({
  id: TaskIdSchema.optional(),
  name: z.string().optional(),
  command: z.string().optional(),
  cwd: z.string().optional(),
  env: z.array(KeyValueSchema).optional(),
  envProfile: z.string().optional(),
  autoRestart: z.boolean().optional(),
  readyPattern: z.string().optional(),
  port: z.number().int().min(1).max(65535).nullable().optional(),
  // Without the schema's 'saved' default: an update that leaves source out (a rename) must keep a discovered task's.
  source: RunnerTaskSchema.shape.source.unwrap().optional(),
});
export type RunnerTaskDraft = z.infer<typeof RunnerTaskDraftSchema>;

/** A discovered task, with the saved task it was saved as, if any. */
export interface RunnerDiscoveredRow extends RunnerDiscoveredTask {
  taskId?: string;
}

/** The saved tasks by name, without those whose id get, save, delete and start would refuse. */
export async function listTasks(ws: WorkspaceApi): Promise<RunnerTask[]> {
  const items = await ws.store.list(TASKS_COLLECTION);
  return items
    .flatMap((item) => {
      const parsed = RunnerTaskSchema.safeParse(item);
      return parsed.success && TaskIdSchema.safeParse(parsed.data.id).success ? [parsed.data] : [];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function getTask(ws: WorkspaceApi, id: string): Promise<RunnerTask> {
  const item = TaskIdSchema.safeParse(id).success ? await ws.store.get(TASKS_COLLECTION, id) : undefined;
  const parsed = item ? RunnerTaskSchema.safeParse(item) : null;
  if (!parsed) throw new QuiverError('NOT_FOUND', `No saved task ${id}`);
  if (!parsed.success) throw new QuiverError('INVALID_INPUT', `The saved task ${id} is not valid: ${parsed.error.message}`);
  return parsed.data;
}

/** A folder relative to the workspace, with forward slashes; one that climbs out of it is refused. */
function relativeCwd(ws: WorkspaceApi, cwd: string): string {
  const root = path.resolve(ws.path);
  const back = path.relative(root, path.resolve(root, cwd.trim().replace(/\\/g, '/') || '.'));
  if (leavesFolder(back)) throw new QuiverError('INVALID_INPUT', `${cwd} is outside the workspace folder`);
  return back.split(path.sep).join('/');
}

/** What a saved task and a discovered script are matched on. */
function scriptKey(t: Pick<RunnerTask, 'source' | 'command' | 'cwd'>): string {
  return `${t.source}\u0000${t.command}\u0000${t.cwd}`;
}

/**
 * Whether saving a discovered script may update this saved task: one that runs the same script and adds no env entries
 * or env profile to it. A committed task with `NODE_OPTIONS=--require ./x.js` is not what a person saving `npm run dev`
 * asked for, so such a task is neither updated nor shown as that script saved; saving it gives a task of its own.
 */
function savedAs(task: RunnerTask, script: Pick<RunnerTask, 'source' | 'command' | 'cwd'>): boolean {
  return scriptKey(task) === scriptKey(script) && task.env.length === 0 && !task.envProfile;
}

/** Workspace id -> the last task write in line. */
const writes = new Map<string, Promise<unknown>>();

/**
 * Runs the task writes of one workspace one after another, so two saves of the same discovered script cannot both
 * miss the other and add two tasks, and an update reads what the write before it left.
 */
function inLine<T>(wsId: string, job: () => Promise<T>): Promise<T> {
  const result = (writes.get(wsId) ?? Promise.resolve()).then(job);
  const tail = result.catch(() => undefined);
  writes.set(wsId, tail);
  void tail.then(() => {
    if (writes.get(wsId) === tail) writes.delete(wsId);
  });
  return result;
}

/**
 * Creates or updates a task. A discovered script (a draft without id whose `source` is not `saved`) that is saved
 * already updates that task rather than adding a second one, keeping the name it was given, unless that task adds env
 * entries or an env profile (`savedAs`): then it is saved as a task of its own. A task without a name is named after
 * its command.
 */
export function saveTask(ctx: CommandContext, draft: RunnerTaskDraft): Promise<RunnerTask> {
  const w = ctx.workspace!;
  return inLine(w.id, async () => {
    const { port, readyPattern, envProfile, ...rest } = draft;
    const fields = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) as Partial<RunnerTask>;
    if (fields.cwd !== undefined) fields.cwd = relativeCwd(w, fields.cwd);
    let existing = draft.id ? await getTask(w, draft.id) : undefined;
    if (!existing && fields.source && fields.source !== 'saved') {
      existing = (await listTasks(w)).find((t) => savedAs(t, { source: fields.source!, command: fields.command ?? '', cwd: fields.cwd ?? '' }));
      // Saving the script again is not a rename: the discovered name gives way to the one the task has.
      if (existing) delete fields.name;
    }
    const merged: Record<string, unknown> = { ...(existing ?? {}), ...fields, id: existing?.id ?? newId() };
    if (port !== undefined) merged['port'] = port ?? undefined;
    if (readyPattern !== undefined) merged['readyPattern'] = readyPattern.trim() || undefined;
    if (envProfile !== undefined) merged['envProfile'] = envProfile.trim() || undefined;
    const command = typeof merged['command'] === 'string' ? merged['command'].trim() : '';
    merged['name'] = (typeof merged['name'] === 'string' ? merged['name'].trim() : '') || command.slice(0, 60) || 'Task';
    const task = RunnerTaskSchema.parse(merged);
    if (!command) throw new QuiverError('INVALID_INPUT', 'A task needs a command');
    if (task.readyPattern) compilePattern(task.readyPattern, 'The ready pattern');
    await w.store.put(TASKS_COLLECTION, task);
    ctx.host.emit('runner.changed', { workspaceId: w.id, reason: 'tasks', taskId: task.id });
    return task;
  });
}

/**
 * Deletes a task and stops its process tree when it is running, waiting to restart or being started. The file goes
 * first, so a start that comes in while the tree is stopped finds no task rather than starting it again.
 */
export function deleteTask(ctx: CommandContext, id: string): Promise<{ deleted: boolean; stopped: RunnerProcInfo | null }> {
  const w = ctx.workspace!;
  return inLine(w.id, async () => {
    const before = getProc(w, id);
    const deleted = await w.store.remove(TASKS_COLLECTION, id);
    if (deleted) ctx.host.emit('runner.changed', { workspaceId: w.id, reason: 'tasks', taskId: id });
    // Also waits for a start in flight and stops what it started.
    const after = await stopTask(w, id);
    const wasLive = before !== null && (!['exited', 'crashed'].includes(before.state) || before.restartAt !== undefined);
    const stopped = after && (wasLive || after.runId !== before?.runId) ? after : null;
    return { deleted, stopped };
  });
}

/** The discovered tasks, each with the id of the saved task that saving it would update (`savedAs`), if there is one. */
export async function discoveredRows(ws: WorkspaceApi, found: RunnerDiscoveredTask[]): Promise<RunnerDiscoveredRow[]> {
  // By key, the first by name as a save would find it, so many scripts and many saved tasks stay one pass each.
  const saved = new Map<string, string>();
  for (const t of await listTasks(ws)) if (savedAs(t, t) && !saved.has(scriptKey(t))) saved.set(scriptKey(t), t.id);
  return found.map((d) => {
    const taskId = saved.get(scriptKey(d));
    return taskId ? { ...d, taskId } : d;
  });
}
