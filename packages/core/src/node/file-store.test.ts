import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { FileStore, collectionOf } from './file-store';

const dirs: string[] = [];
const stores: FileStore[] = [];
async function tempStore(): Promise<{ store: FileStore; root: string; changes: string[] }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'quiver-file-store-'));
  dirs.push(root);
  const changes: string[] = [];
  const store = new FileStore(root, (collection) => changes.push(collection));
  await store.init();
  stores.push(store);
  return { store, root, changes };
}

const until = async (test: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!test() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
};

afterEach(async () => {
  stores.splice(0).forEach((s) => s.unwatch());
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('collectionOf', () => {
  it('maps item files and collection folders to their collection, and ignores the rest', () => {
    expect(collectionOf('requests/abc.json')).toBe('requests');
    expect(collectionOf('requests\\abc.json')).toBe('requests');
    expect(collectionOf('requests')).toBe('requests');
    expect(collectionOf('requests/abc.json.123.tmp')).toBeNull();
    expect(collectionOf('local/state.json')).toBeNull();
    expect(collectionOf('.gitignore')).toBeNull();
    expect(collectionOf('requests/nested/x.json')).toBeNull();
  });
});

describe('FileStore external changes', () => {
  it('reload picks up a file written outside the store and reports it once', async () => {
    const { store, root, changes } = await tempStore();
    await store.put('requests', { id: 'a', name: 'one' });
    changes.length = 0;
    await fs.writeFile(path.join(root, 'requests', 'b.json'), JSON.stringify({ id: 'b', name: 'two' }));
    expect(await store.reload('requests')).toBe(true);
    expect((await store.list('requests')).map((r) => r.id).sort()).toEqual(['a', 'b']);
    expect(await store.reload('requests')).toBe(false);
    expect(changes).toEqual(['requests']);
  });

  it('two reloads of a collection at once report nothing when the files did not change', async () => {
    const { store, changes } = await tempStore();
    await store.put('requests', { id: 'a', name: 'one' });
    changes.length = 0;
    // The second used to start while the first had dropped the cache, find nothing cached and report a change.
    expect(await Promise.all([store.reload('requests'), store.reload('requests')])).toEqual([false, false]);
    expect(changes).toEqual([]);
    expect((await store.list('requests')).map((r) => r.id)).toEqual(['a']);
  });

  it('a save made while a reload reads the folder stays cached', async () => {
    const { store } = await tempStore();
    for (let i = 0; i < 40; i++) await store.put('environments', { id: `e${i}`, name: String(i) });
    // The reload dropped the cache and read the folder before the save's file was there, then cached what it read
    // over the save's map: the new item was on disk but get() did not find it until the next reload.
    const [, saved] = await Promise.all([store.reload('environments'), store.put('environments', { id: 'new', name: 'new' })]);
    expect(saved.id).toBe('new');
    expect(await store.get('environments', 'new')).toEqual({ id: 'new', name: 'new' });
    expect((await store.list('environments')).length).toBe(41);
  });

  it('the watcher does not report a first save into a new collection twice, however fast it fires', async () => {
    const { store, changes } = await tempStore();
    // A 1 ms debounce makes the watcher's reload run while the save is still landing (what a slow
    // macOS runner did with 50 ms): before the item is cached, so it used to look like an outside edit.
    store.watch(1);
    const names = Array.from({ length: 20 }, (_, i) => `things${i}`);
    for (const name of names) await store.put(name, { id: 'a', name });
    await new Promise((r) => setTimeout(r, 300));
    expect(changes).toEqual(names);
  });

  it('the watcher reloads on external edits and deletions but stays quiet for its own writes', async () => {
    const { store, root, changes } = await tempStore();
    store.watch(50);
    await store.put('requests', { id: 'a', name: 'one' });
    expect(await store.list('requests')).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 300));
    expect(changes).toEqual(['requests']);

    await fs.writeFile(path.join(root, 'requests', 'b.json'), JSON.stringify({ id: 'b', name: 'agent' }));
    await until(() => changes.length === 2);
    expect(changes).toEqual(['requests', 'requests']);
    expect((await store.get<{ id: string; name: string }>('requests', 'b'))?.name).toBe('agent');

    await fs.rm(path.join(root, 'requests', 'a.json'));
    await until(() => changes.length === 3);
    expect((await store.list('requests')).map((r) => r.id)).toEqual(['b']);

    // A file this store saved (replaced by a rename) is still watched for edits made in place.
    await store.put('requests', { id: 'b', name: 'saved here' });
    await new Promise((r) => setTimeout(r, 300));
    const seen = changes.length;
    await fs.writeFile(path.join(root, 'requests', 'b.json'), JSON.stringify({ id: 'b', name: 'edited in place' }));
    await until(() => changes.length > seen);
    expect((await store.get<{ id: string; name: string }>('requests', 'b'))?.name).toBe('edited in place');

    // A collection folder deleted and created again is watched again.
    await fs.rm(path.join(root, 'requests'), { recursive: true });
    await until(() => changes.length > seen + 1);
    await new Promise((r) => setTimeout(r, 200));
    await fs.mkdir(path.join(root, 'requests'));
    await new Promise((r) => setTimeout(r, 200));
    await fs.writeFile(path.join(root, 'requests', 'c.json'), JSON.stringify({ id: 'c', name: 'back' }));
    const end = Date.now() + 3000;
    while (Date.now() < end && !(await store.list('requests')).some((r) => r.id === 'c')) await new Promise((r) => setTimeout(r, 25));
    expect((await store.list('requests')).map((r) => r.id)).toEqual(['c']);

    await fs.mkdir(path.join(root, 'collections'));
    await fs.writeFile(path.join(root, 'collections', 'c.json'), JSON.stringify({ id: 'c', name: 'new folder' }));
    await until(() => changes.includes('collections'));
    expect((await store.list('collections')).map((r) => r.id)).toEqual(['c']);
  });
});

describe('FileStore item files', () => {
  it('leaves out an item whose id does not name its file, so edits and deletes of that id stick', async () => {
    const { store, root } = await tempStore();
    await store.put('runner', { id: 'b', command: 'echo safe' });
    // A committed file claiming to be `b`, and one with an id no file could be saved as.
    await fs.writeFile(path.join(root, 'runner', 'z.json'), JSON.stringify({ id: 'b', command: 'echo hostile' }));
    await fs.writeFile(path.join(root, 'runner', 'y.json'), JSON.stringify({ id: '../y', command: 'echo hostile' }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await store.reload('runner');
      expect(await store.list('runner')).toEqual([{ id: 'b', command: 'echo safe' }]);
      await store.put('runner', { id: 'b', command: 'echo edited' });
      store.invalidate('runner');
      expect(await store.get('runner', 'b')).toEqual({ id: 'b', command: 'echo edited' });
      expect(await store.remove('runner', 'b')).toBe(true);
      store.invalidate('runner');
      expect(await store.list('runner')).toEqual([]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('z.json'));
    } finally {
      warn.mockRestore();
    }
  });

  it('a save keeps the fields of the file that the collection schema does not know, and only for that collection', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'quiver-file-store-'));
    dirs.push(root);
    const schema = z.object({ id: z.string(), name: z.string(), tags: z.array(z.string()).optional() });
    const store = new FileStore(root, () => {}, (collection) => (collection === 'known' ? schema : undefined));
    await store.init();
    for (const collection of ['known', 'other']) {
      await fs.mkdir(path.join(root, collection));
      // Written by a newer Quiver: `colour` is a field this version has never heard of.
      await fs.writeFile(path.join(root, collection, 'a.json'), JSON.stringify({ id: 'a', name: 'old', tags: ['x'], colour: 'red' }));
    }
    // What a save hands over once its input went through the schema: unknown fields gone, `tags` cleared on purpose.
    expect(await store.put('known', { id: 'a', name: 'new' })).toEqual({ id: 'a', name: 'new' });
    await store.put('other', { id: 'a', name: 'new' });
    const onDisk = async (collection: string) => JSON.parse(await fs.readFile(path.join(root, collection, 'a.json'), 'utf8'));
    expect(await onDisk('known')).toEqual({ id: 'a', name: 'new', colour: 'red' });
    expect(await onDisk('other')).toEqual({ id: 'a', name: 'new' });
    expect(await store.get('known', 'a')).toEqual({ id: 'a', name: 'new', colour: 'red' });
  });
});

describe('FileStore logs', () => {
  it('writeLog replaces the log in one step, oldest first, and leaves no temp file behind', async () => {
    const { store, root } = await tempStore();
    for (const id of [1, 2, 3]) await store.appendLog('history', { id });
    await store.writeLog('history', [{ id: 2 }, { id: 3 }, { id: 4 }]);
    expect(await store.readLog<{ id: number }>('history', 10)).toEqual([{ id: 4 }, { id: 3 }, { id: 2 }]);
    expect(await fs.readFile(path.join(root, 'local', 'history.jsonl'), 'utf8')).toBe('{"id":2}\n{"id":3}\n{"id":4}\n');
    expect((await fs.readdir(path.join(root, 'local'))).filter((f) => f.endsWith('.tmp'))).toEqual([]);

    await store.writeLog('history', []);
    expect(await store.readLog('history', 10)).toEqual([]);
    await store.appendLog('history', { id: 5 });
    expect(await store.readLog<{ id: number }>('history', 10)).toEqual([{ id: 5 }]);

    // A log that never existed is written too.
    await store.writeLog('fresh', [{ id: 'a' }]);
    expect(await store.readLog<{ id: string }>('fresh', 10)).toEqual([{ id: 'a' }]);
    await expect(store.writeLog('../x', [])).rejects.toThrow(/Unsafe log name/);
  });
});
