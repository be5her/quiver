import { spawn, type ChildProcess } from 'node:child_process';
import { statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { QuiverError, tokenizeShell, tshSettingToArgv } from '@quiver/core';

export interface TshCommand {
  /** Program plus fixed leading arguments, e.g. `['C:\\...\\tsh.exe']` or `['node', 'fake-tsh.cjs']`. */
  argv: string[];
  source: 'settings' | 'path' | 'connect';
}

export interface TshRun {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  timeoutMs?: number;
  /** Called per line as output arrives; used to show login progress. */
  onLine?(line: string, stream: 'stdout' | 'stderr'): void;
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Where Teleport Connect installs its private copy of tsh. */
export function teleportConnectCandidates(): string[] {
  switch (process.platform) {
    case 'win32':
      return [
        path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'Teleport Connect', 'resources', 'bin', 'tsh.exe'),
        path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Teleport Connect', 'resources', 'bin', 'tsh.exe'),
      ];
    case 'darwin':
      return [
        '/Applications/Teleport Connect.app/Contents/MacOS/tsh.app/Contents/MacOS/tsh',
        path.join(os.homedir(), 'Applications', 'Teleport Connect.app', 'Contents', 'MacOS', 'tsh.app', 'Contents', 'MacOS', 'tsh'),
      ];
    default:
      return ['/opt/Teleport Connect/resources/bin/tsh', '/usr/local/lib/teleport-connect/resources/bin/tsh'];
  }
}

/** Search PATH (plus the usual spots a GUI app launched from the dock does not see). */
export function findOnPath(name: string): string | null {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  if (process.platform !== 'win32') {
    for (const extra of ['/usr/local/bin', '/opt/homebrew/bin', path.join(os.homedir(), '.local', 'bin')]) if (!dirs.includes(extra)) dirs.push(extra);
  }
  const exts = process.platform === 'win32' ? ['.exe', ...(process.env.PATHEXT ?? '').split(';').map((e) => e.toLowerCase()).filter((e) => e && e !== '.exe')] : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Resolve tsh: an explicit setting wins (a path, or a wrapper command line), then PATH,
 * then the copy bundled with Teleport Connect.
 */
export function resolveTsh(setting: string): TshCommand | null {
  const fromSetting = tshSettingToArgv(setting, isFile, tokenizeShell);
  if (fromSetting) return { argv: fromSetting, source: 'settings' };
  const onPath = findOnPath('tsh');
  if (onPath) return { argv: [onPath], source: 'path' };
  const bundled = teleportConnectCandidates().find(isFile);
  if (bundled) return { argv: [bundled], source: 'connect' };
  return null;
}

export function tshNotFound(): QuiverError {
  return new QuiverError('NOT_FOUND', 'tsh was not found. Install Teleport Connect, add tsh to PATH, or set its path in Settings > Teleport.');
}

/** Spawn tsh with tokenized arguments and no shell. stdin is closed so nothing can block on a prompt. */
export function spawnTsh(tsh: TshCommand, args: string[]): ChildProcess {
  const [program, ...fixed] = tsh.argv;
  return spawn(program, [...fixed, ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: process.env });
}

/** Pipe a stream's chunks into whole lines. */
export function lineSplitter(onLine: (line: string) => void): (chunk: Buffer | string) => void {
  let rest = '';
  return (chunk) => {
    rest += chunk.toString();
    const lines = rest.split(/\r?\n/);
    rest = lines.pop() ?? '';
    for (const line of lines) onLine(line);
  };
}

/** Run tsh to completion and collect its output. */
export function runTsh(tsh: TshCommand, args: string[], options: RunOptions = {}): Promise<TshRun> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawnTsh(tsh, args);
    } catch (err) {
      reject(new QuiverError('REQUEST_FAILED', `Could not start tsh: ${(err as Error).message}`));
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new QuiverError('REQUEST_FAILED', `tsh ${args.slice(0, 2).join(' ')} did not finish within ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    const outLines = lineSplitter((line) => options.onLine?.(line, 'stdout'));
    const errLines = lineSplitter((line) => options.onLine?.(line, 'stderr'));
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      outLines(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      errLines(chunk);
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new QuiverError('REQUEST_FAILED', `Could not start tsh (${tsh.argv[0]}): ${err.message}`));
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

/** The interesting part of tsh's stderr: the last non-empty line without the `ERROR:` prefix. */
export function tshErrorMessage(run: Pick<TshRun, 'stderr' | 'stdout' | 'code'>): string {
  const lines = `${run.stderr}\n${run.stdout}`
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const last = lines.findLast((l) => /error/i.test(l)) ?? lines[lines.length - 1];
  return (last ?? `tsh exited with code ${run.code ?? 'null'}`).replace(/^ERROR:\s*/i, '');
}
