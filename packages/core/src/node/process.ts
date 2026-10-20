import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

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

/** Stop a process spawned with `spawnTree` and everything it started. */
export function killTree(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null) return;
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

/** The full path of a program found on PATH (with PATHEXT on Windows), or null. */
export function whichSync(program: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? ['', ...(env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)] : [''];
  if (path.isAbsolute(program)) return existsSync(program) ? program : null;
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, program + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** Run a program to completion and collect its output. Never throws for a non-zero exit; `code` is null when it could not start. */
export function runToEnd(program: string, args: readonly string[], options: SpawnTreeOptions & { input?: string; timeoutMs?: number } = {}): Promise<{ code: number | null; stdout: string; stderr: string; error?: string }> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnTree(program, args, { ...options, stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: null, stdout: '', stderr: '', error: (err as Error).message });
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on('data', (c: Buffer) => out.push(c));
    child.stderr?.on('data', (c: Buffer) => err.push(c));
    const timer = options.timeoutMs ? setTimeout(() => killTree(child), options.timeoutMs) : undefined;
    let failed: string | undefined;
    child.on('error', (e) => (failed = e.message));
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: failed ? null : code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), error: failed });
    });
    if (options.input !== undefined) child.stdin?.end(options.input);
  });
}
