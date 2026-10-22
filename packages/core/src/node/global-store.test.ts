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

describe('GlobalStore agent permissions', () => {
  it('turns the allowMutating of an older config into the mode', async () => {
    expect((await new GlobalStore(await tempFile({ mcp: { enabled: true, port: 7411, allowMutating: true } })).load()).mcp).toMatchObject({
      allowMutating: true,
      paused: false,
      permissions: { mode: 'allow', rules: [] },
    });
    expect((await new GlobalStore(await tempFile({ mcp: { enabled: true, port: 7411, allowMutating: false } })).load()).mcp.permissions.mode).toBe('read-only');
    expect((await new GlobalStore(await tempFile()).load()).mcp.permissions).toEqual({ mode: 'read-only', rules: [] });
  });

  it('keeps an ask mode and its rules across a reload, and a patch flipping allowMutating switches the mode', async () => {
    const file = await tempFile();
    const store = new GlobalStore(file);
    await store.load();
    await store.update({ mcp: { ...store.get().mcp, permissions: { mode: 'ask', rules: [{ match: 'git.*', action: 'deny' }] } } });
    const reloaded = await new GlobalStore(file).load();
    expect(reloaded.mcp).toMatchObject({ allowMutating: false, permissions: { mode: 'ask', rules: [{ match: 'git.*', action: 'deny' }] } });
    const flipped = await store.update({ mcp: { ...store.get().mcp, allowMutating: true } });
    expect(flipped.mcp.permissions.mode).toBe('allow');
  });

  it('loads mode allow as read-only when an older build switched allowMutating off, and keeps it when the file agrees', async () => {
    const off = { mcp: { enabled: true, port: 7411, allowMutating: false, permissions: { mode: 'allow', rules: [] } } };
    expect((await new GlobalStore(await tempFile(off)).load()).mcp).toMatchObject({ allowMutating: false, permissions: { mode: 'read-only' } });
    const on = { mcp: { enabled: true, port: 7411, allowMutating: true, permissions: { mode: 'allow', rules: [] } } };
    expect((await new GlobalStore(await tempFile(on)).load()).mcp).toMatchObject({ allowMutating: true, permissions: { mode: 'allow' } });
    // An update from the settings, which picks allow while allowMutating is still false, is not a downgrade.
    const store = new GlobalStore(await tempFile());
    await store.load();
    expect((await store.update({ mcp: { ...store.get().mcp, permissions: { mode: 'allow', rules: [] } } })).mcp).toMatchObject({ allowMutating: true, permissions: { mode: 'allow' } });
  });

  it('keeps the workspace rules, by workspace id, and drops what is not a rule', async () => {
    const file = await tempFile({
      mcp: { enabled: true, port: 7411, allowMutating: false, workspaceRules: { abc: [{ match: 'git.*', action: 'deny' }, { match: 'bad match', action: 'allow' }], empty: [], odd: 'x' } },
    });
    expect((await new GlobalStore(file).load()).mcp.workspaceRules).toEqual({ abc: [{ match: 'git.*', action: 'deny' }] });
    expect((await new GlobalStore(await tempFile()).load()).mcp.workspaceRules).toEqual({});
  });
});
