import type { RunnerDiscoveredTask, RunnerProc } from '@quiver/core';

/** A row of `runner.proc.list` (the host's `RunnerProcInfo`). */
export interface RunnerProcInfo extends RunnerProc {
  name: string;
  /** Milliseconds since the current process started, while it runs. */
  uptimeMs?: number;
  /** When a crashed run starts again by itself, while it waits for that. */
  restartAt?: string;
}

/** A row of `runner.task.discover`, with the saved task it was saved as. */
export interface RunnerDiscoveredRow extends RunnerDiscoveredTask {
  taskId?: string;
}

/** What the panel shows for a task: its run's state, or stopped when it has not run or has exited. */
export type TaskState = 'stopped' | 'starting' | 'ready' | 'running' | 'stopping' | 'crashed' | 'restarting';

export function taskState(proc: RunnerProcInfo | undefined): TaskState {
  if (!proc) return 'stopped';
  if (proc.restartAt) return 'restarting';
  return proc.state === 'exited' ? 'stopped' : proc.state;
}

/** Whether the task has a process (or a restart pending), so Stop applies rather than Start. */
export function isLive(state: TaskState): boolean {
  return state !== 'stopped' && state !== 'crashed';
}

export const STATE_LABEL: Record<TaskState, string> = {
  stopped: 'Stopped',
  starting: 'Starting',
  ready: 'Ready',
  running: 'Running',
  stopping: 'Stopping',
  crashed: 'Crashed',
  restarting: 'Restarting',
};

/** The dot's colour; starting and restarting pulse. */
export function stateDot(state: TaskState): string {
  switch (state) {
    case 'ready':
    case 'running':
      return 'bg-success';
    case 'starting':
    case 'restarting':
      return 'bg-warning animate-pulse';
    case 'stopping':
      return 'bg-warning';
    case 'crashed':
      return 'bg-danger';
    default:
      return 'bg-muted/50';
  }
}

export const SOURCE_BADGE: Record<RunnerDiscoveredTask['source'], string> = { npm: 'NPM', make: 'MAKE', just: 'JUST', compose: 'DC' };

/** `1h 02m`, `3m 05s`, `12s`. */
export function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  if (h) return `${h}h ${pad(m)}m`;
  if (m) return `${m}m ${pad(s % 60)}s`;
  return `${s}s`;
}

/** The link a task's port opens. */
export function portUrl(port: number): string {
  return `http://localhost:${port}`;
}
