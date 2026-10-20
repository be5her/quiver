import { z } from 'zod';
import { KeyValueSchema } from './api';

// Process runner contract. Saved tasks are committed under `.quiver/runner/<id>.json`; running processes
// and their output live only in memory on this machine.

/** A command line saved with the project, run in the workspace folder (or `cwd` relative to it) through the shell. */
export const RunnerTaskSchema = z.object({
  id: z.string(),
  name: z.string().default('Task'),
  command: z.string().default(''),
  /** Relative to the workspace folder; empty is the folder itself. */
  cwd: z.string().default(''),
  env: z.array(KeyValueSchema).default([]),
  /** An env file profile whose values are added to the environment. */
  envProfile: z.string().optional(),
  autoRestart: z.boolean().default(false),
  /** A regular expression on the output that marks the process as ready. */
  readyPattern: z.string().optional(),
  /** A port that marks the process as ready once it accepts connections, and is shown as a link. */
  port: z.number().int().min(1).max(65535).optional(),
  /** Where it came from when it was saved from a discovered script. */
  source: z.enum(['saved', 'npm', 'make', 'just', 'compose']).default('saved'),
});
export type RunnerTask = z.infer<typeof RunnerTaskSchema>;

/** A script found in the project's own files, ready to run or to save as a task. */
export interface RunnerDiscoveredTask {
  source: 'npm' | 'make' | 'just' | 'compose';
  name: string;
  command: string;
  /** Relative to the workspace folder. */
  cwd: string;
  /** The file it was found in, relative to the workspace folder. */
  file: string;
}

export type RunnerProcState = 'starting' | 'ready' | 'running' | 'stopping' | 'exited' | 'crashed';

export interface RunnerProc {
  taskId: string;
  runId: string;
  state: RunnerProcState;
  pid?: number;
  startedAt: string;
  endedAt?: string;
  exitCode?: number | null;
  restarts: number;
  port?: number;
}

export interface RunnerOutputLine {
  /** Increasing per run; the cursor for the next read. */
  seq: number;
  stream: 'stdout' | 'stderr' | 'system';
  text: string;
  at: string;
}

export interface RunnerOutputChunk {
  runId: string;
  lines: RunnerOutputLine[];
  /** Pass as `after` to read on. */
  next: number;
  /** Lines that fell out of the buffer before they were read. */
  dropped: number;
}

export const RunnerTaskRefInputSchema = z.object({ taskId: z.string() });
export const RunnerOutputInputSchema = z.object({
  taskId: z.string(),
  /** A past run; default the latest. */
  runId: z.string().optional(),
  after: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(5000).default(500),
});
export const RunnerWaitInputSchema = z.object({
  taskId: z.string(),
  /** Wait for this regular expression on the output; default until the task is ready. */
  pattern: z.string().optional(),
  timeoutMs: z.number().int().min(100).max(600_000).default(30_000),
});
export const RunnerInputInputSchema = z.object({ taskId: z.string(), text: z.string() });
