import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { killTree, runToEnd, spawnTree, whichSync } from './process';

const node = process.execPath;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function until(predicate: () => boolean, ms: number): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) if (predicate()) return true;
  return predicate();
}

describe('process helpers', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'quiver-process-'));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it('runs a program to the end and collects its output and exit code', async () => {
    const out = await runToEnd(node, ['-e', 'process.stdout.write("hi"); process.stderr.write("err"); process.exit(3)']);
    expect(out).toMatchObject({ code: 3, signal: null, stdout: 'hi', stderr: 'err', timedOut: false, truncated: false });
    expect(out.error).toBeUndefined();
  });

  it('feeds input on stdin', async () => {
    const out = await runToEnd(node, ['-e', 'process.stdin.on("data", (d) => process.stdout.write(String(d).toUpperCase()))'], { input: 'abc' });
    expect(out.stdout).toBe('ABC');
  });

  it('survives a program that exits before reading its input', async () => {
    // The failed stdin write must not surface as an unhandled stream error; the exit code tells the story.
    const out = await runToEnd(node, ['-e', 'process.exit(2)'], { input: 'x'.repeat(4 * 1024 * 1024) });
    expect(out.code).toBe(2);
    expect(out.error).toBeUndefined();
  });

  it('reports a program that cannot start without throwing', async () => {
    const out = await runToEnd('quiver-no-such-program-xyz', []);
    expect(out.code).toBeNull();
    expect(out.error).toBeTruthy();
  });

  it('stops a program that runs too long and says so', async () => {
    const out = await runToEnd(node, ['-e', 'process.stdout.write("started"); setInterval(() => {}, 1000)'], { timeoutMs: 300 });
    expect(out.timedOut).toBe(true);
    expect(out.stdout).toBe('started');
    // Killed, so no ordinary exit code: a signal on macOS and Linux, taskkill's exit code on Windows.
    expect(out.code === null || process.platform === 'win32').toBe(true);
  });

  it('stops a program whose output exceeds the limit and keeps what fits', async () => {
    const out = await runToEnd(node, ['-e', 'const line = "y".repeat(1024); setInterval(() => process.stdout.write(line), 1)'], { maxBytes: 10_000, timeoutMs: 10_000 });
    expect(out.truncated).toBe(true);
    expect(out.timedOut).toBe(false);
    expect(out.stdout.length).toBe(10_000);
  });

  it('kills a process tree, grandchildren included', async () => {
    // The child starts a grandchild and prints its pid; killing the tree must end both.
    const child = spawnTree(node, ['-e', 'const { spawn } = require("child_process"); const g = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); process.stdout.write(String(g.pid) + "\\n"); setInterval(() => {}, 1000)']);
    let printed = '';
    child.stdout?.on('data', (c: Buffer) => (printed += c.toString()));
    await until(() => printed.includes('\n'), 10_000);
    const grandchild = Number(printed.trim());
    expect(grandchild).toBeGreaterThan(0);
    expect(alive(grandchild)).toBe(true);
    const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()));
    killTree(child);
    await exited;
    expect(await until(() => !alive(grandchild), 5000)).toBe(true);
    // A second call on an exited child is a no-op: the pid may belong to someone else by now.
    killTree(child);
  });

  it('finds programs on PATH by name, skips directories, accepts absolute paths', () => {
    const dir = path.join(tmp, 'bin');
    mkdirSync(dir);
    mkdirSync(path.join(dir, 'quiver-which-folder'));
    const windows = process.platform === 'win32';
    const file = path.join(dir, windows ? 'quiver-which-prog.CMD' : 'quiver-which-prog');
    writeFileSync(file, windows ? '@echo off\r\n' : '#!/bin/sh\n', { mode: 0o755 });
    const env = { PATH: dir, PATHEXT: '.COM;.EXE;.CMD' };
    expect(whichSync('quiver-which-prog', env)).toBe(file);
    expect(whichSync(windows ? 'quiver-which-prog.CMD' : 'quiver-which-prog', env)).toBe(file);
    expect(whichSync('quiver-which-folder', env)).toBeNull();
    expect(whichSync('quiver-which-missing', env)).toBeNull();
    expect(whichSync(node)).toBe(node);
    expect(whichSync(path.join(tmp, 'no-such-file'))).toBeNull();
  });
});
