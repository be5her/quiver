import {
  RunnerInputInputSchema,
  RunnerOutputInputSchema,
  RunnerTaskRefInputSchema,
  RunnerWaitInputSchema,
  defineCommand,
  type CommandContext,
  type CommandDefinition,
  type WorkspaceApi,
} from '@quiver/core';
import { z } from 'zod';
import { listProcs, readOutput, restartTask, startTask, stopTask, waitFor, writeInput } from './supervisor';

// Lane R2: the process supervisor's commands. Processes and their output live in memory on this machine.

function ws(ctx: CommandContext): WorkspaceApi {
  return ctx.workspace!;
}

const procList = defineCommand({
  id: 'runner.proc.list',
  title: 'List running tasks',
  description:
    'Lists the latest run of every task started since the workspace opened: `state` (starting, ready, running, stopping, exited, crashed), `pid`, `uptimeMs` while it runs, `port`, `restarts` (automatic restarts of this run) and `restartAt` when a crashed task with auto restart is waiting to start again. A task with a ready pattern or a port stays `starting` until the pattern prints or the port accepts connections; one without either is `running`.',
  scope: 'workspace',
  input: z.object({}),
  handler: async (_input, ctx) => listProcs(ws(ctx)),
});

const procStart = defineCommand({
  id: 'runner.proc.start',
  title: 'Start task',
  description:
    'Starts a saved task through the shell in its folder, as a new run with its own output. A task already running (or waiting to restart) is left alone and its run returned. Returns at once; use runner.proc.wait to wait until it is ready.',
  scope: 'workspace',
  mutating: true,
  input: RunnerTaskRefInputSchema,
  handler: async ({ taskId }, ctx) => startTask(ws(ctx), ctx.host, taskId),
});

const procStop = defineCommand({
  id: 'runner.proc.stop',
  title: 'Stop task',
  description: 'Stops the task and every process it started, waits until they exited and returns the run; null when the task has not run. A pending automatic restart is cancelled.',
  scope: 'workspace',
  mutating: true,
  input: RunnerTaskRefInputSchema,
  handler: async ({ taskId }, ctx) => stopTask(ws(ctx), taskId),
});

const procRestart = defineCommand({
  id: 'runner.proc.restart',
  title: 'Restart task',
  description: 'Stops the task (if it runs) and starts it again as a new run, with the saved task as it is now.',
  scope: 'workspace',
  mutating: true,
  input: RunnerTaskRefInputSchema,
  handler: async ({ taskId }, ctx) => restartTask(ws(ctx), ctx.host, taskId),
});

const procOutput = defineCommand({
  id: 'runner.proc.output',
  title: 'Read task output',
  description:
    'Reads the output of the latest run of a task (or the run `runId`; the last five runs are kept), oldest first, from the cursor `after` (0 for the start). Pass the answer\'s `next` as `after` to read on. Each run keeps its last 5000 lines; `dropped` counts lines that fell out before they were read. `stream` is stdout, stderr or system (Quiver\'s own notes: the command, exits, restarts).',
  scope: 'workspace',
  input: RunnerOutputInputSchema,
  handler: async ({ taskId, ...opts }, ctx) => readOutput(ws(ctx), taskId, opts),
});

const procWait = defineCommand({
  id: 'runner.proc.wait',
  title: 'Wait for task',
  description:
    'Waits until the task\'s current run is ready (its ready pattern printed or its port opened; a task with neither counts once started), or, with `pattern`, until a line of the run matches that regular expression (case-insensitive; lines printed before the call count). Answers `matched`, `timedOut`, the matching `line` and the run. Ends early with `matched: false` when the run exits without a restart pending.',
  scope: 'workspace',
  input: RunnerWaitInputSchema,
  handler: async ({ taskId, ...opts }, ctx) => waitFor(ws(ctx), taskId, opts),
});

const procInput = defineCommand({
  id: 'runner.proc.input',
  title: 'Send input to task',
  description: 'Writes text to the stdin of the task\'s running process, as given: end it with "\\n" to send a line.',
  scope: 'workspace',
  mutating: true,
  input: RunnerInputInputSchema,
  handler: async ({ taskId, text }, ctx) => writeInput(ws(ctx), taskId, text),
});

export const procCommands: CommandDefinition[] = [procList, procStart, procStop, procRestart, procOutput, procWait, procInput];
