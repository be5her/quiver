import { promises as fs } from 'node:fs';
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
