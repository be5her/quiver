import { describe, expect, it } from 'vitest';
import { killTree, runToEnd, spawnTree, whichSync } from './process';

const node = process.execPath;

describe('process helpers', () => {
  it('runs a program to the end and collects its output and exit code', async () => {
    const out = await runToEnd(node, ['-e', 'process.stdout.write("hi"); process.stderr.write("err"); process.exit(3)']);
    expect(out).toMatchObject({ code: 3, stdout: 'hi', stderr: 'err' });
  });

  it('feeds input on stdin', async () => {
    const out = await runToEnd(node, ['-e', 'process.stdin.on("data", (d) => process.stdout.write(String(d).toUpperCase()))'], { input: 'abc' });
    expect(out.stdout).toBe('ABC');
  });

  it('reports a program that cannot start without throwing', async () => {
    const out = await runToEnd('quiver-no-such-program-xyz', []);
    expect(out.code).toBeNull();
    expect(out.error).toBeTruthy();
  });

  it('kills a process tree', async () => {
    const child = spawnTree(node, ['-e', 'setInterval(() => {}, 1000)']);
    const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()));
    killTree(child);
    await exited;
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });

  it('finds programs on PATH and not missing ones', () => {
    expect(whichSync(node)).toBe(node);
    expect(whichSync('quiver-no-such-program-xyz')).toBeNull();
  });
});
