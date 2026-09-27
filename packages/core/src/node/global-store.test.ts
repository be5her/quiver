import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GlobalStore } from './global-store';

const dirs: string[] = [];
async function tempFile(content?: unknown): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'quiver-global-store-'));
  dirs.push(dir);
  const file = path.join(dir, 'config.json');
  if (content !== undefined) await fs.writeFile(file, JSON.stringify(content), 'utf8');
  return file;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('GlobalStore updates channel', () => {
  it('defaults to stable, including for a config written before the setting existed', async () => {
    expect((await new GlobalStore(await tempFile()).load()).updates).toEqual({ channel: 'stable' });
    expect((await new GlobalStore(await tempFile({ theme: 'dark' })).load()).updates).toEqual({ channel: 'stable' });
  });

  it('keeps beta across a reload and falls back to stable for an unknown channel', async () => {
    const file = await tempFile();
    await new GlobalStore(file).load();
    const store = new GlobalStore(file);
    await store.load();
    await store.update({ updates: { channel: 'beta' } });
    expect((await new GlobalStore(file).load()).updates.channel).toBe('beta');
    await fs.writeFile(file, JSON.stringify({ updates: { channel: 'nightly' } }), 'utf8');
    expect((await new GlobalStore(file).load()).updates.channel).toBe('stable');
  });

  it('leaves the channel alone when another section is patched', async () => {
    const store = new GlobalStore(await tempFile({ updates: { channel: 'beta' } }));
    await store.load();
    const next = await store.update({ theme: 'light' });
    expect(next.updates.channel).toBe('beta');
  });
});
