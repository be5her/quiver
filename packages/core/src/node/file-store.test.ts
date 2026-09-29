import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
