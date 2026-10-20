import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process';
import { statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

export interface SpawnTreeOptions {
  cwd?: string;
  /** Added to the inherited environment. */
  env?: Record<string, string>;
  /** Default: stdin closed so nothing blocks on a prompt, stdout and stderr piped. */
  stdio?: StdioOptions;
  /** Run through the platform shell, for user-written command lines such as `npm run dev`. */
  shell?: boolean;
}

/**
 * Spawn a process that can later be stopped as a whole with `killTree`: on macOS and Linux it leads
 * its own process group, on Windows taskkill walks the tree by parent process id.
 */
export function spawnTree(program: string, args: readonly string[], options: SpawnTreeOptions = {}): ChildProcess {
  return spawn(program, [...args], {
    cwd: options.cwd,
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    shell: options.shell ?? false,
    detached: process.platform !== 'win32',
    env: options.env ? { ...process.env, ...options.env } : process.env,
  });
}

/** Stop a process spawned with `spawnTree` and everything it started. Nothing happens once it has exited, so a pid reused by another process is never signalled. */
export function killTree(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    const taskkill = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
    try {
      const killer = spawn(taskkill, ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      killer.on('error', () => child.kill());
      killer.on('exit', (code) => {
        if (code !== 0) child.kill();
      });
    } catch {
      child.kill();
    }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    child.kill(signal);
  }
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * The full path of a program found on PATH, or null. On Windows the PATHEXT extensions are tried first, then the
 * name as given (`git.exe`). On macOS and Linux the usual install spots a GUI app launched from the Dock does not
 * have on its PATH (`/usr/local/bin`, Homebrew, `~/.local/bin`) are searched too. Directories never match.
 */
export function whichSync(program: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (path.isAbsolute(program)) return isFile(program) ? program : null;
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  if (process.platform !== 'win32') {
    for (const extra of ['/usr/local/bin', '/opt/homebrew/bin', path.join(os.homedir(), '.local', 'bin')]) if (!dirs.includes(extra)) dirs.push(extra);
  }
  const exts = process.platform === 'win32' ? [...(env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean), ''] : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, program + ext);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

export interface RunToEndOptions extends SpawnTreeOptions {
  /** Written to stdin, which is then closed. Without it stdin is closed from the start. */
  input?: string;
  /** Stop the process tree when it runs longer than this; the result then has `timedOut`. */
  timeoutMs?: number;
  /** Stop the process tree once stdout and stderr together exceed this many bytes; the result then has `truncated` and holds what arrived before. */
  maxBytes?: number;
}

export interface RunToEndResult {
  /** The exit code; null when the process was killed or could not start. */
  code: number | null;
  /** The signal that ended it, when one did. */
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** Killed by `timeoutMs`. */
  timedOut: boolean;
  /** Killed by `maxBytes`; the output is what arrived before the limit. */
  truncated: boolean;
  /** Why it could not start, when it could not. */
  error?: string;
}

/**
 * Run a program to completion and collect its output. Never throws and never rejects: a non-zero exit is reported in
 * `code`, a program that could not start in `error`. The input, when any, is written without waiting for the program
 * to read it; a program that exits first just leaves it unread.
 */
export function runToEnd(program: string, args: readonly string[], options: RunToEndOptions = {}): Promise<RunToEndResult> {
  return new Promise((resolve) => {
    const { input, timeoutMs, maxBytes, ...spawnOptions } = options;
    let child: ChildProcess;
    try {
      child = spawnTree(program, args, { ...spawnOptions, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: null, signal: null, stdout: '', stderr: '', timedOut: false, truncated: false, error: (err as Error).message });
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let bytes = 0;
    let timedOut = false;
    let truncated = false;
    let failed: string | undefined;
    const collect = (into: Buffer[]) => (chunk: Buffer) => {
      if (truncated) return;
      bytes += chunk.length;
      if (maxBytes !== undefined && bytes > maxBytes) {
        truncated = true;
        into.push(chunk.subarray(0, Math.max(0, chunk.length - (bytes - maxBytes))));
        killTree(child);
        return;
      }
      into.push(chunk);
    };
    child.stdout?.on('data', collect(out));
    child.stderr?.on('data', collect(err));
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          killTree(child);
        }, timeoutMs)
      : undefined;
    // A child that could not start has no pid. An `error` after it started (a `kill` that failed, say) is not a start
    // failure: the exit code and `timedOut` tell what happened.
    child.on('error', (e) => {
      if (child.pid === undefined) failed = e.message;
    });
    // The byte cap can fall inside a multi-byte character; the decoder holds such a tail back instead of printing U+FFFD.
    const text = (chunks: Buffer[]) => (truncated ? new StringDecoder('utf8').write(Buffer.concat(chunks)) : Buffer.concat(chunks).toString('utf8'));
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ code: failed ? null : code, signal, stdout: text(out), stderr: text(err), timedOut, truncated, error: failed });
    });
    if (input !== undefined && child.stdin) {
      // A program that exits before reading its input makes the write fail (EPIPE, or EOF on Windows). That is not an
      // error of ours: the exit code says what happened, and an unhandled stream error would take the whole process down.
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }
  });
}
