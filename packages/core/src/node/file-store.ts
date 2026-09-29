import { promises as fs, watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import type { Entity, StoreApi } from '../types';

const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

function assertSafe(name: string, what: string): void {
  if (!SAFE_NAME.test(name)) throw new Error(`Unsafe ${what} name: ${name}`);
}

async function writeAtomic(file: string, content: string): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, file);
}

async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

/**
 * JSON-per-item storage rooted at a workspace's `.quiver` folder.
 *
 *   .quiver/<collection>/<id>.json   committed, diffable
 *   .quiver/local/<name>.json        per machine, gitignored
 *   .quiver/local/<name>.jsonl       append-only logs, gitignored
 */
export class FileStore implements StoreApi {
  private readonly cache = new Map<string, Map<string, Entity>>();
  private readonly watchers = new Map<string, FSWatcher>();
  private watching = false;
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    readonly root: string,
    private readonly onChange: (collection: string) => void = () => {},
  ) {}

  get localDir(): string {
    return path.join(this.root, 'local');
  }

  async init(): Promise<void> {
    await fs.mkdir(this.localDir, { recursive: true });
    const gitignore = path.join(this.root, '.gitignore');
    if ((await readJsonSafe(gitignore)) === undefined) {
      await fs.writeFile(gitignore, '# Per-machine state: history, secrets, UI layout.\nlocal/\n', 'utf8');
    }
  }

  private collectionDir(collection: string): string {
    assertSafe(collection, 'collection');
    return path.join(this.root, collection);
  }

  private async load(collection: string): Promise<Map<string, Entity>> {
    const cached = this.cache.get(collection);
    if (cached) return cached;
    const map = new Map<string, Entity>();
    const dir = this.collectionDir(collection);
    let files: string[] = [];
    try {
      files = await fs.readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const item = await readJson<Entity>(path.join(dir, file));
      if (item && typeof item.id === 'string') map.set(item.id, item);
    }
    this.cache.set(collection, map);
    return map;
  }

  /**
   * Watch the folder for changes made outside Quiver (an agent editing the JSON files,
   * a git pull or checkout) and reload the collections they touch. A change is reported
   * through onChange only when the content differs from the cache, so Quiver's own writes
   * do not report twice.
   */
  watch(debounceMs = 150): void {
    if (this.watching) return;
    this.watching = true;
    // Linux has no native recursive watch; Node's emulation watches each file's inode and loses a
    // file once it is replaced by a rename (how every save here lands), so watch the folders instead.
    if (process.platform === 'linux') {
      this.watchDir('', debounceMs);
      void fs
        .readdir(this.root, { withFileTypes: true })
        .then((entries) => entries.forEach((e) => e.isDirectory() && collectionOf(e.name) && this.watchDir(e.name, debounceMs)))
        .catch(() => {});
    } else {
      this.watchDir('', debounceMs, true);
    }
  }

  /** Watch one folder: the root (`''`) or a collection. The root also picks up new collection folders. */
  private watchDir(name: string, debounceMs: number, recursive = false): void {
    if (!this.watching || this.watchers.has(name)) return;
    try {
      const watcher = watch(path.join(this.root, name), { recursive, persistent: false }, (_event, filename) => {
        const collection = filename ? collectionOf(name ? `${name}/${String(filename)}` : String(filename)) : null;
        if (!collection) return;
        // The collection folder itself was created, deleted or replaced: watch the one there now.
        if (!recursive && !name) {
          this.unwatchDir(collection);
          this.watchDir(collection, debounceMs);
        }
        this.scheduleReload(collection, debounceMs);
      });
      // A deleted collection folder ends its watcher; the root sees it come back.
      watcher.on('error', () => (name ? this.unwatchDir(name) : this.unwatch()));
      this.watchers.set(name, watcher);
    } catch {
      // A folder that cannot be watched keeps working; it just misses external edits.
    }
  }

  private unwatchDir(name: string): void {
    this.watchers.get(name)?.close();
    this.watchers.delete(name);
  }

  unwatch(): void {
    this.watching = false;
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
  }

  private scheduleReload(collection: string, debounceMs: number): void {
    clearTimeout(this.pending.get(collection));
    this.pending.set(
      collection,
      setTimeout(() => {
        this.pending.delete(collection);
        void this.reload(collection).catch(() => {});
      }, debounceMs),
    );
  }

  /** Re-read a collection from disk; reports a change when it differs from what was cached. */
  async reload(collection: string): Promise<boolean> {
    const before = this.cache.get(collection);
    this.cache.delete(collection);
    const after = await this.load(collection);
    if (before && sameEntities(before, after)) return false;
    this.onChange(collection);
    return true;
  }

  /** Drop caches so the next read hits disk. Used after external edits. */
  invalidate(collection?: string): void {
    if (collection) this.cache.delete(collection);
    else this.cache.clear();
  }

  async list<T extends Entity>(collection: string): Promise<T[]> {
    return [...(await this.load(collection)).values()] as T[];
  }

  async get<T extends Entity>(collection: string, id: string): Promise<T | undefined> {
    return (await this.load(collection)).get(id) as T | undefined;
  }

  async put<T extends Entity>(collection: string, item: T): Promise<T> {
    assertSafe(item.id, 'id');
    const dir = this.collectionDir(collection);
    await fs.mkdir(dir, { recursive: true });
    await writeAtomic(path.join(dir, `${item.id}.json`), JSON.stringify(item, null, 2) + '\n');
    (await this.load(collection)).set(item.id, item);
    this.onChange(collection);
    return item;
  }

  async remove(collection: string, id: string): Promise<boolean> {
    assertSafe(id, 'id');
    const map = await this.load(collection);
    if (!map.has(id)) return false;
    map.delete(id);
    await fs.rm(path.join(this.collectionDir(collection), `${id}.json`), { force: true });
    this.onChange(collection);
    return true;
  }

  async readLocal<T>(name: string, fallback: T): Promise<T> {
    assertSafe(name, 'local document');
    return (await readJson<T>(path.join(this.localDir, `${name}.json`))) ?? fallback;
  }

  async writeLocal<T>(name: string, value: T): Promise<void> {
    assertSafe(name, 'local document');
    await fs.mkdir(this.localDir, { recursive: true });
    await writeAtomic(path.join(this.localDir, `${name}.json`), JSON.stringify(value, null, 2) + '\n');
  }

  async appendLog(name: string, entry: unknown): Promise<void> {
    assertSafe(name, 'log');
    await fs.mkdir(this.localDir, { recursive: true });
    await fs.appendFile(path.join(this.localDir, `${name}.jsonl`), JSON.stringify(entry) + '\n', 'utf8');
  }

  async readLog<T>(name: string, limit: number): Promise<T[]> {
    assertSafe(name, 'log');
    let text: string;
    try {
      text = await fs.readFile(path.join(this.localDir, `${name}.jsonl`), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const lines = text.split('\n').filter(Boolean);
    const out: T[] = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      try {
        out.push(JSON.parse(lines[i]) as T);
      } catch {
        // skip corrupt line
      }
    }
    return out;
  }

  async clearLog(name: string): Promise<void> {
    assertSafe(name, 'log');
    await fs.rm(path.join(this.localDir, `${name}.jsonl`), { force: true });
  }
}

async function readJsonSafe(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}

/** The collection a watched path belongs to: `requests/abc.json` -> `requests`. Local state and temp files are ignored. */
export function collectionOf(filename: string): string | null {
  const parts = filename.split(/[\\/]/).filter(Boolean);
  const [collection, file] = parts;
  if (!collection || parts.length > 2 || collection === 'local' || !SAFE_NAME.test(collection)) return null;
  if (file === undefined) return collection.includes('.') ? null : collection;
  return file.endsWith('.json') ? collection : null;
}

function sameEntities(a: Map<string, Entity>, b: Map<string, Entity>): boolean {
  if (a.size !== b.size) return false;
  for (const [id, item] of a) {
    const other = b.get(id);
    if (!other || JSON.stringify(item) !== JSON.stringify(other)) return false;
  }
  return true;
}
