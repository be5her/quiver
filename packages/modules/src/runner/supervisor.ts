import type { ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import {
  QuiverError,
  RingBuffer,
  RunnerTaskSchema,
  dotenvToMap,
  hasNestedRepetition,
  newId,
  nowIso,
  parseDotenv,
  type HostApi,
  type RunnerOutputChunk,
  type RunnerOutputLine,
  type RunnerProc,
  type RunnerProcInfo,
  type RunnerProcState,
  type RunnerTask,
  type RunnerWaitResult,
  type WorkspaceApi,
} from '@quiver/core';
import { killTree, spawnTree } from '@quiver/core/node';
import { findProfileFile } from '../env/files';

// The process supervisor: runs saved tasks as whole process trees, keeps their output, tells when they are ready,
// restarts crashed ones when asked to and stops everything when the workspace closes or the app quits.

/** Saved tasks live in `.quiver/runner/<id>.json`; lane R1 owns writing them, the supervisor only reads. */
const TASKS_COLLECTION = 'runner';
/** Lines kept per run. */
export const OUTPUT_LINES = 5000;
/** Runs kept per task, the current one included, so the output of the last few is still readable. */
const RUNS_KEPT = 5;
/** A line longer than this is cut into pieces, so a process that never breaks a line cannot fill memory. */
const MAX_LINE = 64 * 1024;
/** Text without a line break (a prompt) is shown once the process has been quiet this long. */
const PARTIAL_FLUSH_MS = 150;
/** Output events per run, at most 4 a second. */
const OUTPUT_EVENT_MS = 250;
const PORT_POLL_MS = 400;
/** After a stop request, how long to wait for the tree to exit before giving up on it. */
const STOP_TIMEOUT_MS = 5000;
/** Auto restart waits 1 s, 2 s, 4 s ... up to this; a run that stayed up for `HEALTHY_MS` starts again from 1 s. */
const BACKOFF_MAX_MS = 30_000;
const BACKOFF_MIN_MS = 1000;
const HEALTHY_MS = 10_000;

interface Waiter {
  /** Settles the wait when the run did what it waits for, or ended; true when it was resolved. */
  check(run: Run, line?: RunnerOutputLine): boolean;
}

interface Run {
  ws: WorkspaceApi;
  host: HostApi;
  task: RunnerTask;
  proc: RunnerProc;
  out: RingBuffer<RunnerOutputLine>;
  child: ChildProcess | null;
  /** Set once a stop was asked for: the exit is then not a crash and nothing restarts. */
  stopping: boolean;
  /** The current process exited (or never started). */
  ended: boolean;
  /** Resolves when the current process has exited. */
  exited: Promise<void>;
  ready: RegExp | null;
  /** The sequence number of the last line before the current process started; a pattern wait looks only after it. */
  firstSeq: number;
  restartTimer: NodeJS.Timeout | null;
  restartAt?: string;
  portTimer: NodeJS.Timeout | null;
  outputTimer: NodeJS.Timeout | null;
  attempts: number;
  waiters: Set<Waiter>;
}

interface TaskRuns {
  /** Oldest first; the last is the current run. */
  runs: Run[];
}

/** Workspace id -> task id -> its runs. */
const workspaces = new Map<string, Map<string, TaskRuns>>();
/** Starts in flight, so two starts of one task at once give one process. */
const starting = new Map<string, Promise<RunnerProcInfo>>();

function tasksOf(wsId: string): Map<string, TaskRuns> {
  let tasks = workspaces.get(wsId);
  if (!tasks) workspaces.set(wsId, (tasks = new Map()));
  return tasks;
}

function currentRun(wsId: string, taskId: string): Run | undefined {
  return workspaces.get(wsId)?.get(taskId)?.runs.at(-1);
}

function isLive(run: Run): boolean {
  return !run.ended || run.restartTimer !== null;
}

function info(run: Run): RunnerProcInfo {
  const p = run.proc;
  const out: RunnerProcInfo = { ...p, name: run.task.name };
  if (!run.ended) out.uptimeMs = Math.max(0, Date.now() - Date.parse(p.startedAt));
  if (run.restartAt) out.restartAt = run.restartAt;
  return out;
}

// ---------- tasks ----------

export async function readTask(ws: WorkspaceApi, taskId: string): Promise<RunnerTask> {
  const item = await ws.store.get(TASKS_COLLECTION, taskId);
  if (!item) throw new QuiverError('NOT_FOUND', `No saved task ${taskId}`);
  const parsed = RunnerTaskSchema.safeParse(item);
  if (!parsed.success) throw new QuiverError('INVALID_INPUT', `The saved task ${taskId} is not valid: ${parsed.error.message}`);
  if (!parsed.data.command.trim()) throw new QuiverError('INVALID_INPUT', `The task ${parsed.data.name} has no command`);
  return parsed.data;
}

/**
 * Whether a path relative to a folder (`path.relative(folder, p)`) leaves it: `..` or `../x`, or another drive. A
 * folder named `..cache` inside it does not. The runner's one test for this, for saved, started and discovered paths.
 */
export function leavesFolder(back: string): boolean {
  return back === '..' || back.startsWith(`..${path.sep}`) || path.isAbsolute(back);
}

/** A path inside the workspace folder; one that climbs out of it is refused. */
function insideWorkspace(ws: WorkspaceApi, rel: string): string {
  const root = path.resolve(ws.path);
  const abs = path.resolve(root, rel || '.');
  if (leavesFolder(path.relative(root, abs))) throw new QuiverError('INVALID_INPUT', `${rel} is outside the workspace folder`);
  return abs;
}

/**
 * The values of the env file a profile names (`findProfileFile`): `.env.<profile>` or `<profile>.env` in the task's
 * folder or the nearest folder above it, or a project-relative path when the profile has a slash or is an env file name
 * itself. One in another folder is only named in the error, never read: it may be another app's.
 */
async function profileEnv(ws: WorkspaceApi, cwd: string, profile: string): Promise<Record<string, string>> {
  const name = profile.trim();
  const found = await findProfileFile(ws, name, path.relative(path.resolve(ws.path), cwd));
  if (found.abs === null) {
    const elsewhere = found.candidates.length ? `; other folders have ${found.candidates.join(', ')}, so give the one to use as the profile` : '';
    throw new QuiverError('NOT_FOUND', `No env file for the profile ${name} (.env.${name} or ${name}.env) in the task's folder or above it${elsewhere}`);
  }
  try {
    return dotenvToMap(parseDotenv(await fs.readFile(found.abs, 'utf8')));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new QuiverError('NOT_FOUND', `No env file for the profile ${name}: ${found.rel} does not exist`);
    throw err;
  }
}

/** A pattern longer than this is refused before it is even looked at. */
const MAX_PATTERN_LENGTH = 512;

/**
 * Compiles a pattern (a task's ready pattern, or the one an agent waits for), case-insensitive, after refusing what
 * could backtrack for ages on a long line and freeze the main process: a repeated group with a repeat inside
 * (`(a+)+`, `(\w*,?)*`) or a backreference. Checked here because `wait` is open to agents and every line of the run
 * is tested against it.
 */
export function compilePattern(source: string, what: string): RegExp {
  if (source.length > MAX_PATTERN_LENGTH) throw new QuiverError('INVALID_INPUT', `${what} is longer than ${MAX_PATTERN_LENGTH} characters`);
  const why = unsafePattern(source);
  if (why) throw new QuiverError('INVALID_INPUT', `${what} ${why}, which could take forever on a long line; write it without that`);
  try {
    return new RegExp(source, 'i');
  } catch (err) {
    throw new QuiverError('INVALID_INPUT', `${what} is not a valid regular expression: ${(err as Error).message}`);
  }
}

/**
 * Why a pattern is refused, or null: a repeated group with a repeat inside (`hasNestedRepetition`, the same rule the
 * API module's checks use), or a backreference, which backtracks the same way.
 */
function unsafePattern(source: string): string | null {
  for (let i = 0; i < source.length; i++) {
    if (source[i] !== '\\') continue;
    const next = source[i + 1] ?? '';
    if (/[1-9]/.test(next) || (next === 'k' && source[i + 2] === '<')) return 'uses a backreference';
    i++;
  }
  return hasNestedRepetition(source) ? 'repeats a group that repeats inside' : null;
}

function compileReady(task: RunnerTask): RegExp | null {
  return task.readyPattern ? compilePattern(task.readyPattern, 'The ready pattern') : null;
}

// ---------- output ----------

// Colour and cursor codes: kept in the output for the panel, ignored when matching patterns.
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

function emit(run: Run, reason: 'state' | 'output'): void {
  run.host.emit('runner.changed', { workspaceId: run.ws.id, reason, taskId: run.task.id, runId: run.proc.runId });
}

function scheduleOutputEvent(run: Run): void {
  if (run.outputTimer) return;
  run.outputTimer = setTimeout(() => {
    run.outputTimer = null;
    emit(run, 'output');
  }, OUTPUT_EVENT_MS);
}

function record(run: Run, stream: RunnerOutputLine['stream'], text: string): void {
  const line: RunnerOutputLine = { seq: run.out.last + 1, stream, text, at: nowIso() };
  run.out.push(line);
  if (stream !== 'system' && run.ready && !run.ended && run.proc.state === 'starting' && run.ready.test(stripAnsi(text))) markReady(run);
  for (const waiter of [...run.waiters]) waiter.check(run, line);
  scheduleOutputEvent(run);
}

/** Feeds a stream into the run's buffer line by line. */
function follow(run: Run, child: ChildProcess, name: 'stdout' | 'stderr'): void {
  const stream = child[name];
  if (!stream) return;
  const decoder = new StringDecoder('utf8');
  let partial = '';
  let flushTimer: NodeJS.Timeout | null = null;
  const flush = () => {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
    if (partial) record(run, name, partial.replace(/\r$/, ''));
    partial = '';
  };
  const take = (text: string) => {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
    const parts = (partial + text).split('\n');
    partial = parts.pop() ?? '';
    for (const part of parts) {
      const line = part.replace(/\r$/, '');
      for (let i = 0; i < Math.max(1, line.length); i += MAX_LINE) record(run, name, line.slice(i, i + MAX_LINE));
    }
    while (partial.length > MAX_LINE) {
      record(run, name, partial.slice(0, MAX_LINE));
      partial = partial.slice(MAX_LINE);
    }
    if (partial) flushTimer = setTimeout(flush, PARTIAL_FLUSH_MS);
  };
  stream.on('data', (chunk: Buffer) => take(decoder.write(chunk)));
  stream.on('end', () => {
    take(decoder.end());
    flush();
  });
  stream.on('error', () => undefined);
}

// ---------- states ----------

function setState(run: Run, state: RunnerProcState): void {
  if (run.proc.state === state) return;
  run.proc.state = state;
  emit(run, 'state');
  for (const waiter of [...run.waiters]) waiter.check(run);
}

function markReady(run: Run): void {
  stopPortPoll(run);
  run.attempts = 0;
  setState(run, 'ready');
}

function stopPortPoll(run: Run): void {
  if (run.portTimer) clearTimeout(run.portTimer);
  run.portTimer = null;
}

/** Whether something accepts connections on the port, on IPv4 or IPv6 loopback. */
function portOpen(port: number): Promise<boolean> {
  const tryHost = (host: string) =>
    new Promise<boolean>((resolve) => {
      const socket = net.connect({ host, port });
      const done = (ok: boolean) => {
        socket.destroy();
        resolve(ok);
      };
      socket.setTimeout(PORT_POLL_MS, () => done(false));
      socket.once('connect', () => done(true));
      socket.once('error', () => done(false));
    });
  return tryHost('127.0.0.1').then((ok) => ok || tryHost('::1'));
}

function pollPort(run: Run, port: number): void {
  run.portTimer = setTimeout(async () => {
    run.portTimer = null;
    if (run.ended || run.proc.state !== 'starting') return;
    if (await portOpen(port)) {
      if (!run.ended && run.proc.state === 'starting') {
        record(run, 'system', `Port ${port} accepts connections`);
        markReady(run);
      }
      return;
    }
    if (!run.ended && run.proc.state === 'starting') pollPort(run, port);
  }, PORT_POLL_MS);
}

// ---------- processes ----------

async function launch(run: Run): Promise<void> {
  const { ws, task } = run;
  run.ended = false;
  run.stopping = false;
  run.restartTimer = null;
  run.restartAt = undefined;
  run.proc.pid = undefined;
  run.proc.endedAt = undefined;
  run.proc.exitCode = undefined;
  run.proc.startedAt = nowIso();
  run.proc.state = 'starting';
  run.firstSeq = run.out.last;
  let resolveExit!: () => void;
  run.exited = new Promise((resolve) => (resolveExit = resolve));

  let child: ChildProcess;
  // A port that something else already holds cannot tell when this task is ready: the task's own server will not
  // get it, and an open port would mark the task ready at once. The ready pattern, when there is one, still counts.
  let portHeld = false;
  try {
    const cwd = insideWorkspace(ws, task.cwd);
    const env: Record<string, string> = task.envProfile ? await profileEnv(ws, cwd, task.envProfile) : {};
    for (const kv of task.env) if (kv.enabled && kv.key) env[kv.key] = kv.value;
    portHeld = task.port !== undefined && (await portOpen(task.port));
    // A stop that came while the environment was read (an auto restart) wins.
    if (run.stopping) {
      run.ended = true;
      run.proc.endedAt = nowIso();
      setState(run, 'exited');
      resolveExit();
      return;
    }
    record(run, 'system', `$ ${task.command}${task.cwd ? `  (in ${task.cwd})` : ''}`);
    if (portHeld) record(run, 'system', `Port ${task.port} is already in use by another process, so it cannot tell when this task is ready`);
    child = spawnTree(task.command, [], { cwd, env, shell: true, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (err) {
    fail(run, (err as Error).message);
    resolveExit();
    return;
  }
  run.child = child;
  run.proc.pid = child.pid;
  emit(run, 'state');
  child.stdin?.on('error', () => undefined);
  follow(run, child, 'stdout');
  follow(run, child, 'stderr');
  child.once('error', (err) => {
    if (child.pid === undefined) {
      fail(run, err.message);
      resolveExit();
    }
  });
  child.once('spawn', () => {
    const byPort = run.task.port !== undefined && !portHeld;
    if (!run.ready && !byPort) setState(run, 'running');
    else if (byPort) pollPort(run, run.task.port!);
  });
  // `close` comes after the output streams ended, so the last lines are in before the run is marked ended.
  child.once('close', (code, signal) => {
    exitedWith(run, code, signal);
    resolveExit();
  });
}

function fail(run: Run, message: string): void {
  run.ended = true;
  run.child = null;
  run.proc.endedAt = nowIso();
  run.proc.exitCode = null;
  record(run, 'system', `Could not start: ${message}`);
  setState(run, 'crashed');
}

function exitedWith(run: Run, code: number | null, signal: NodeJS.Signals | null): void {
  if (run.ended) return;
  stopPortPoll(run);
  run.ended = true;
  run.child = null;
  run.proc.endedAt = nowIso();
  run.proc.exitCode = code;
  const how = signal ? `was stopped by ${signal}` : `exited with code ${code}`;
  const crashed = !run.stopping && code !== 0;
  record(run, 'system', run.stopping ? 'Stopped' : `The process ${how}`);
  if (crashed && run.task.autoRestart) {
    const upFor = Date.now() - Date.parse(run.proc.startedAt);
    if (upFor >= HEALTHY_MS) run.attempts = 0;
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** run.attempts);
    run.attempts++;
    run.restartAt = new Date(Date.now() + delay).toISOString();
    record(run, 'system', `Restarting in ${delay / 1000} s`);
    run.restartTimer = setTimeout(() => {
      run.restartTimer = null;
      if (run.stopping) return;
      run.proc.restarts++;
      void launch(run);
    }, delay);
  }
  setState(run, crashed ? 'crashed' : 'exited');
}

/** Ask the run to stop and wait until its tree has exited (or the wait gives up). */
async function stopRun(run: Run): Promise<void> {
  run.stopping = true;
  if (run.restartTimer) {
    clearTimeout(run.restartTimer);
    run.restartTimer = null;
    run.restartAt = undefined;
    emit(run, 'state');
  }
  if (run.ended || !run.child) return;
  setState(run, 'stopping');
  const child = run.child;
  killTree(child);
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      // A tree that ignored SIGTERM gets SIGKILL; on Windows taskkill already forced it.
      killTree(child, 'SIGKILL');
      setTimeout(resolve, 1000);
    }, STOP_TIMEOUT_MS);
  });
  await Promise.race([run.exited, late]);
  clearTimeout(timer);
}

function newRun(ws: WorkspaceApi, host: HostApi, task: RunnerTask): Run {
  return {
    ws,
    host,
    task,
    proc: { taskId: task.id, runId: newId(), state: 'starting', startedAt: nowIso(), restarts: 0, ...(task.port !== undefined ? { port: task.port } : {}) },
    out: new RingBuffer<RunnerOutputLine>(OUTPUT_LINES),
    child: null,
    stopping: false,
    ended: true,
    exited: Promise.resolve(),
    ready: compileReady(task),
    firstSeq: 0,
    restartTimer: null,
    portTimer: null,
    outputTimer: null,
    attempts: 0,
    waiters: new Set(),
  };
}

// ---------- the API the commands use ----------

export function listProcs(ws: WorkspaceApi): RunnerProcInfo[] {
  return [...(workspaces.get(ws.id)?.values() ?? [])].flatMap((t) => (t.runs.length ? [info(t.runs.at(-1)!)] : []));
}

export function getProc(ws: WorkspaceApi, taskId: string): RunnerProcInfo | null {
  const run = currentRun(ws.id, taskId);
  return run ? info(run) : null;
}

let exitHooked = false;

/**
 * The last resort when the app exits without waiting for `onStop` (a quit that does not wait, a crash of the main
 * process): start killing every tree still running. Both the signal and the taskkill spawn go out synchronously.
 */
function killAllOnExit(): void {
  if (exitHooked) return;
  exitHooked = true;
  process.once('exit', () => {
    for (const tasks of workspaces.values()) for (const t of tasks.values()) for (const run of t.runs) if (run.child) killTree(run.child);
  });
}

/** Starts the saved task; one that is already running (or waiting to restart) is left as it is. */
export function startTask(ws: WorkspaceApi, host: HostApi, taskId: string): Promise<RunnerProcInfo> {
  killAllOnExit();
  const key = `${ws.id}\u0000${taskId}`;
  const pending = starting.get(key);
  if (pending) return pending;
  const job = (async () => {
    const existing = currentRun(ws.id, taskId);
    if (existing && isLive(existing) && !existing.stopping) return info(existing);
    const task = await readTask(ws, taskId);
    const run = newRun(ws, host, task);
    const entry = tasksOf(ws.id).get(taskId) ?? { runs: [] };
    entry.runs.push(run);
    if (entry.runs.length > RUNS_KEPT) entry.runs.splice(0, entry.runs.length - RUNS_KEPT);
    tasksOf(ws.id).set(taskId, entry);
    await launch(run);
    return info(run);
  })().finally(() => starting.delete(key));
  starting.set(key, job);
  return job;
}

/** Stops the task's process tree and waits for it; null when the task never ran. */
export async function stopTask(ws: WorkspaceApi, taskId: string): Promise<RunnerProcInfo | null> {
  await starting.get(`${ws.id}\u0000${taskId}`)?.catch(() => undefined);
  const run = currentRun(ws.id, taskId);
  if (!run) return null;
  await stopRun(run);
  return info(run);
}

/** Stops the task and starts it again as a new run, with the saved task as it is now. */
export async function restartTask(ws: WorkspaceApi, host: HostApi, taskId: string): Promise<RunnerProcInfo> {
  await stopTask(ws, taskId);
  return startTask(ws, host, taskId);
}

export function readOutput(ws: WorkspaceApi, taskId: string, opts: { runId?: string; after: number; limit: number }): RunnerOutputChunk {
  const runs = workspaces.get(ws.id)?.get(taskId)?.runs ?? [];
  const run = opts.runId ? runs.find((r) => r.proc.runId === opts.runId) : runs.at(-1);
  if (!run) throw new QuiverError('NOT_FOUND', opts.runId ? `No run ${opts.runId} of the task ${taskId}` : `The task ${taskId} has not run`);
  const read = run.out.read(opts.after, opts.limit);
  return { runId: run.proc.runId, lines: read.items.map((i) => i.value), next: read.next, dropped: read.dropped };
}

/** Writes to the process's stdin as given; add a line break to send a line. */
export function writeInput(ws: WorkspaceApi, taskId: string, text: string): RunnerProcInfo {
  const run = currentRun(ws.id, taskId);
  if (!run || run.ended || !run.child?.stdin || run.child.stdin.destroyed) throw new QuiverError('NOT_FOUND', `The task ${taskId} is not running`);
  run.child.stdin.write(text);
  return info(run);
}

/**
 * Waits until the task is ready, or until a line of the current run matches `pattern` (lines it printed before the
 * call count too). Gives up when the run ends first or the time is up.
 */
export function waitFor(ws: WorkspaceApi, taskId: string, opts: { pattern?: string; timeoutMs: number }): Promise<RunnerWaitResult> {
  const run = currentRun(ws.id, taskId);
  if (!run) throw new QuiverError('NOT_FOUND', `The task ${taskId} has not run`);
  const pattern = opts.pattern ? compilePattern(opts.pattern, 'The pattern') : null;
  const matches = (line: RunnerOutputLine) => line.stream !== 'system' && pattern!.test(stripAnsi(line.text));
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    const finish = (result: Omit<RunnerWaitResult, 'proc'>) => {
      clearTimeout(timer);
      run.waiters.delete(waiter);
      resolve({ ...result, proc: info(run) });
      return true;
    };
    const waiter: Waiter = {
      check(r, line) {
        // A line can only match the pattern; the state is looked at once it has changed (and when the wait begins).
        if (line) return pattern !== null && matches(line) && finish({ matched: true, timedOut: false, line });
        if (!pattern && (r.proc.state === 'ready' || r.proc.state === 'running')) return finish({ matched: true, timedOut: false });
        // A crash with a restart pending is not the end: the next start may still get there.
        if (r.ended && r.restartTimer === null && r.proc.state !== 'starting') return finish({ matched: false, timedOut: false });
        return false;
      },
    };
    // Lines printed before the call count, but only the current process's: after an automatic restart the run's buffer
    // still holds what the crashed process printed, and a "ready" line of that one must not answer for the new one.
    if (pattern) {
      for (const { value: line } of run.out.read(run.firstSeq).items) if (matches(line)) return void finish({ matched: true, timedOut: false, line });
    }
    if (waiter.check(run)) return;
    run.waiters.add(waiter);
    timer = setTimeout(() => finish({ matched: false, timedOut: true }), opts.timeoutMs);
  });
}

// ---------- lifecycle, wired into the module in main.ts ----------

async function stopAll(runs: Run[]): Promise<void> {
  await Promise.all(runs.map((run) => stopRun(run).catch(() => undefined)));
}

/** Kills every process tree of the workspace; for the module's `onWorkspaceClose`. */
export async function onWorkspaceClose(ws: WorkspaceApi): Promise<void> {
  const tasks = workspaces.get(ws.id);
  if (!tasks) return;
  await stopAll([...tasks.values()].flatMap((t) => t.runs));
  for (const run of [...tasks.values()].flatMap((t) => t.runs)) if (run.outputTimer) clearTimeout(run.outputTimer);
  workspaces.delete(ws.id);
}

/** Kills every process tree Quiver started; for the module's `onStop` when the app quits. */
export async function onStop(): Promise<void> {
  await stopAll([...workspaces.values()].flatMap((tasks) => [...tasks.values()].flatMap((t) => t.runs)));
  workspaces.clear();
}

/** The supervisor's lifecycle, spread into the runner module next to any other lane's. */
export const procLifecycle = { onWorkspaceClose, onStop };
