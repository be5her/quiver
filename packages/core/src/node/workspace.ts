import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { WorkspaceApi, WorkspaceInfo } from '../types';
import { FileStore } from './file-store';

export const WORKSPACE_DIR = '.quiver';

export function workspaceIdFor(folder: string): string {
  const normalized = path.resolve(folder).replace(/\\/g, '/').toLowerCase();
  return createHash('sha1').update(normalized).digest('hex').slice(0, 12);
}

interface StateDoc {
  [key: string]: unknown;
}

export class WorkspaceSession implements WorkspaceApi {
  readonly id: string;
  readonly name: string;
  readonly store: FileStore;
  private state: StateDoc | null = null;
  private stateWrite: Promise<void> = Promise.resolve();

  constructor(
    readonly path: string,
    private readonly events: {
      onStoreChange(workspaceId: string, collection: string): void;
      onStateChange(workspaceId: string, key: string): void;
    },
  ) {
    this.id = workspaceIdFor(path);
    this.name = pathBasename(path);
    this.store = new FileStore(pathJoin(path, WORKSPACE_DIR), (collection) => events.onStoreChange(this.id, collection));
  }

  async init(): Promise<void> {
    await this.store.init();
  }

  info(): WorkspaceInfo {
    return { id: this.id, path: this.path, name: this.name };
  }

  private async loadState(): Promise<StateDoc> {
    if (!this.state) this.state = await this.store.readLocal<StateDoc>('state', {});
    return this.state;
  }

  async getState<T>(key: string, fallback: T): Promise<T> {
    const doc = await this.loadState();
    return (doc[key] as T | undefined) ?? fallback;
  }

  async setState<T>(key: string, value: T): Promise<void> {
    const doc = await this.loadState();
    doc[key] = value;
    // Serialize writes so rapid UI updates never interleave.
    this.stateWrite = this.stateWrite.then(() => this.store.writeLocal('state', doc));
    await this.stateWrite;
    this.events.onStateChange(this.id, key);
  }

  async dispose(): Promise<void> {
    await this.stateWrite;
  }
}

export class WorkspaceManager {
  private readonly sessions = new Map<string, WorkspaceSession>();

  constructor(
    private readonly events: {
      onListChange(workspaces: WorkspaceInfo[]): void;
      onStoreChange(workspaceId: string, collection: string): void;
      onStateChange(workspaceId: string, key: string): void;
      onOpen?(ws: WorkspaceSession): Promise<void> | void;
      onClose?(ws: WorkspaceSession): Promise<void> | void;
    },
  ) {}

  list(): WorkspaceInfo[] {
    return [...this.sessions.values()].map((s) => s.info());
  }

  get(id: string): WorkspaceSession | undefined {
    return this.sessions.get(id);
  }

  findByPath(folder: string): WorkspaceSession | undefined {
    return this.sessions.get(workspaceIdFor(folder));
  }

  async open(folder: string): Promise<WorkspaceSession> {
    const resolved = path.resolve(folder);
    const existing = this.findByPath(resolved);
    if (existing) return existing;

    const stat = await fs.stat(resolved).catch(() => null);
    if (!stat?.isDirectory()) throw new Error(`Not a folder: ${resolved}`);

    const session = new WorkspaceSession(resolved, this.events);
    await session.init();
    this.sessions.set(session.id, session);
    await this.events.onOpen?.(session);
    this.events.onListChange(this.list());
    return session;
  }

  async close(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    await this.events.onClose?.(session);
    await session.dispose();
    this.events.onListChange(this.list());
  }

  async closeAll(): Promise<void> {
    for (const id of [...this.sessions.keys()]) await this.close(id);
  }
}

function pathBasename(p: string): string {
  return path.basename(p) || p;
}

function pathJoin(...parts: string[]): string {
  return path.join(...parts);
}
