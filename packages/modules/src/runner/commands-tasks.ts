import { defineCommand, type CommandContext, type CommandDefinition, type WorkspaceApi } from '@quiver/core';
import { z } from 'zod';
import { discoverTasks } from './discover';
import { RunnerTaskDraftSchema, TaskIdSchema, deleteTask, discoveredRows, getTask, listTasks, saveTask } from './tasks';

// Lane R1: saved and discovered tasks. Saved tasks are committed under `.quiver/runner/<id>.json`.

function ws(ctx: CommandContext): WorkspaceApi {
  return ctx.workspace!;
}

const taskList = defineCommand({
  id: 'runner.task.list',
  title: 'List saved tasks',
  description: 'Lists the tasks saved with the project (`.quiver/runner`), by name: command, folder (`cwd`, relative to the workspace), env, env profile, auto restart, ready pattern and port. Start one with runner.proc.start.',
  scope: 'workspace',
  input: z.object({}),
  handler: async (_input, ctx) => listTasks(ws(ctx)),
});

const taskDiscover = defineCommand({
  id: 'runner.task.discover',
  title: 'Discover tasks',
  description:
    'Finds the scripts the project already defines: package.json scripts (run with npm, pnpm or yarn, picked from the packageManager field or the lockfile; lifecycle scripts and pre/post hooks left out), Makefile targets, justfile recipes and docker compose services, in the workspace folder and in every workspace package (package.json `workspaces`, pnpm-workspace.yaml). Only reads files inside the workspace folder and runs nothing; a name a shell would read as something else is left out. Each has `source`, `name`, `command`, `cwd`, `file`, and `taskId` when it is saved already. Pass one to runner.task.save as `task` to save it.',
  scope: 'workspace',
  input: z.object({}),
  handler: async (_input, ctx) => discoveredRows(ws(ctx), await discoverTasks(ws(ctx))),
});

const taskGet = defineCommand({
  id: 'runner.task.get',
  title: 'Get saved task',
  description: 'Returns one saved task.',
  scope: 'workspace',
  input: z.object({ id: TaskIdSchema.describe('Id of a saved task (see runner.task.list)') }),
  handler: async ({ id }, ctx) => getTask(ws(ctx), id),
});

const taskSave = defineCommand({
  id: 'runner.task.save',
  title: 'Save task',
  description:
    'Creates a task (omit id) or updates one (the fields given replace the saved ones; an empty readyPattern or envProfile, or a null port, clears it). A task runs `command` through the shell in `cwd` (relative to the workspace). `readyPattern` is a case-insensitive regular expression on the output that marks it ready; `port` marks it ready once it accepts connections. `env` entries are committed with the project in plain text, like the rest of the task: put secrets in an env file and name it with `envProfile` instead. A task without a name is named after its command. A discovered task (runner.task.discover) can be passed as it is; saving the same discovered script again updates its task and keeps its name.',
  scope: 'workspace',
  mutating: true,
  input: z.object({ task: RunnerTaskDraftSchema }),
  handler: async ({ task }, ctx) => saveTask(ctx, task),
});

const taskDelete = defineCommand({
  id: 'runner.task.delete',
  title: 'Delete task',
  description:
    'Deletes a saved task. A task that is running, waiting to restart or being started is stopped too, with every process it started (its file goes first, so nothing starts it again meanwhile); `stopped` is that run.',
  scope: 'workspace',
  mutating: true,
  input: z.object({ id: TaskIdSchema }),
  handler: async ({ id }, ctx) => deleteTask(ctx, id),
});

export const taskCommands: CommandDefinition[] = [taskList, taskDiscover, taskGet, taskSave, taskDelete];
