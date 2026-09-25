import { spawn } from 'node:child_process';
import { promises as fs, watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { QuiverError, isEnvFileName, newId, normalizeEnvPath, nowIso, type EnvBackup, type EnvGitStatus, type HostApi, type WorkspaceApi } from '@quiver/core';

/** Folders never entered while looking for env files. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  '.quiver',
  'dist',
  'build',
  'out',
  'coverage',
  'vendor',
  'target',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '.venv',
  'venv',
  '__pycache__',
  '.idea',
  'bower_components',
  '.gradle',
  '.terraform',
  'tmp',
  'temp',
  'logs',
]);
const MAX_DEPTH = 4;
const MAX_FILES = 200;
const BACKUP_DOC = 'env-backups';
const BACKUPS_PER_FILE = 20;
const BACKUP_MAX_BYTES = 256 * 1024;

/** Project-relative paths (forward slashes) of every env file, up to four folders deep. */
export async function scanEnvFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (found.length >= MAX_FILES) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const dirs: string[] = [];
    for (const entry of entries) {
      if (entry.isFile() && isEnvFileName(entry.name)) {
        found.push(normalizeEnvPath(path.relative(root, path.join(dir, entry.name))));
        if (found.length >= MAX_FILES) return;
      } else if (entry.isDirectory() && depth < MAX_DEPTH && !SKIP_DIRS.has(entry.name)) {
        dirs.push(entry.name);
      }
    }
    for (const name of dirs.sort()) await walk(path.join(dir, name), depth + 1);
  };
  await walk(root, 0);
  return found;
}

/** Resolve a project-relative env file path and refuse anything outside the folder or not named like an env file. */
export function resolveEnvPath(w: WorkspaceApi, rel: string): { abs: string; rel: string } {
  const normalized = normalizeEnvPath(rel);
  if (!normalized) throw new QuiverError('INVALID_INPUT', 'A file path is required');
  const abs = path.resolve(w.path, normalized);
  const back = path.relative(w.path, abs);
  if (!back || back.startsWith('..') || path.isAbsolute(back)) throw new QuiverError('INVALID_INPUT', 'The file must be inside the project folder');
  if (!isEnvFileName(path.basename(abs))) throw new QuiverError('INVALID_INPUT', `"${normalized}" is not an env file name (.env, .env.<name> or <name>.env)`);
  return { abs, rel: normalizeEnvPath(back) };
}

// ---------- git ----------

interface GitResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runGit(cwd: string, args: string[], stdin?: string): Promise<GitResult | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('git', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: process.env });
    } catch {
      resolve(null);
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr?.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    if (stdin !== undefined) child.stdin?.end(stdin);
    else child.stdin?.end();
  });
}

let gitMissing = false;

/**
 * Tracked and ignored flags for a list of project-relative files.
 * Null when git is not installed or the folder is not inside a repository.
 */
export async function gitStatus(root: string, files: string[]): Promise<Map<string, EnvGitStatus> | null> {
  if (gitMissing || files.length === 0) return null;
  const inside = await runGit(root, ['rev-parse', '--is-inside-work-tree']);
  if (!inside) {
    gitMissing = true;
    return null;
  }
  if (inside.code !== 0 || !inside.stdout.trim().startsWith('true')) return null;
  const tracked = new Set<string>();
  const ls = await runGit(root, ['ls-files', '-z', '--', ...files]);
  if (ls?.code === 0) for (const p of ls.stdout.split('\0')) if (p) tracked.add(normalizeEnvPath(p));
  const ignored = new Set<string>();
  const ci = await runGit(root, ['check-ignore', '-z', '--stdin', '--no-index'], files.join('\0'));
  if (ci && (ci.code === 0 || ci.code === 1)) for (const p of ci.stdout.split('\0')) if (p) ignored.add(normalizeEnvPath(p));
  const out = new Map<string, EnvGitStatus>();
  for (const f of files) out.set(f, { tracked: tracked.has(f), ignored: ignored.has(f) });
  return out;
}

// ---------- backups ----------

interface BackupRecord extends EnvBackup {
  text: string;
}

type BackupDoc = Record<string, BackupRecord[]>;

/** Keep the previous content of a file before Quiver changes it. Identical content is not stored twice. */
export async function backupFile(w: WorkspaceApi, rel: string, text: string, reason: string): Promise<EnvBackup | null> {
  if (Buffer.byteLength(text, 'utf8') > BACKUP_MAX_BYTES) return null;
  const doc = await w.store.readLocal<BackupDoc>(BACKUP_DOC, {});
  const list = doc[rel] ?? [];
  if (list[0]?.text === text) return stripText(list[0]);
  const record: BackupRecord = { id: newId(), at: nowIso(), size: Buffer.byteLength(text, 'utf8'), reason, text };
  doc[rel] = [record, ...list].slice(0, BACKUPS_PER_FILE);
  await w.store.writeLocal(BACKUP_DOC, doc);
  return stripText(record);
}

function stripText(record: BackupRecord): EnvBackup {
  const { text: _text, ...rest } = record;
  return rest;
}

export async function listBackups(w: WorkspaceApi, rel: string): Promise<EnvBackup[]> {
  const doc = await w.store.readLocal<BackupDoc>(BACKUP_DOC, {});
  return (doc[rel] ?? []).map(stripText);
}

export async function readBackup(w: WorkspaceApi, rel: string, id: string): Promise<string> {
  const doc = await w.store.readLocal<BackupDoc>(BACKUP_DOC, {});
  const record = (doc[rel] ?? []).find((b) => b.id === id);
  if (!record) throw new QuiverError('NOT_FOUND', `Backup ${id} of ${rel} not found`);
  return record.text;
}

export async function dropBackups(w: WorkspaceApi, rel: string): Promise<void> {
  const doc = await w.store.readLocal<BackupDoc>(BACKUP_DOC, {});
  if (!(rel in doc)) return;
  delete doc[rel];
  await w.store.writeLocal(BACKUP_DOC, doc);
}

// ---------- watching ----------

/**
 * Watches the project root and every folder that holds an env file (not recursively, so a
 * node_modules churn never reaches us) and reports changes to env files and `.gitignore`.
 */
export class EnvWatcher {
  private readonly watchers = new Map<string, Map<string, FSWatcher>>();
  private readonly timers = new Map<string, NodeJS.Timeout>();

  /** Make the watched folder set match `dirs` (project-relative, '' for the root). */
  sync(w: WorkspaceApi, host: HostApi, dirs: string[], options: { prune?: boolean } = {}): void {
    const wanted = new Set(['', ...dirs]);
    let current = this.watchers.get(w.id);
    if (!current) {
      current = new Map();
      this.watchers.set(w.id, current);
    }
    if (options.prune !== false) {
      for (const [dir, watcher] of current) {
        if (!wanted.has(dir)) {
          watcher.close();
          current.delete(dir);
        }
      }
    }
    for (const dir of wanted) {
      if (current.has(dir)) continue;
      try {
        const watcher = watch(path.join(w.path, dir), { persistent: false }, (_event, filename) => {
          const name = filename ? path.basename(String(filename)) : null;
          if (name && !isEnvFileName(name) && name !== '.gitignore') return;
          this.schedule(w, host);
        });
        watcher.on('error', () => {
          watcher.close();
          current?.delete(dir);
        });
        current.set(dir, watcher);
      } catch {
        // A folder that cannot be watched (permissions, gone) is simply not watched.
      }
    }
  }

  private schedule(w: WorkspaceApi, host: HostApi): void {
    const pending = this.timers.get(w.id);
    if (pending) clearTimeout(pending);
    this.timers.set(
      w.id,
      setTimeout(() => {
        this.timers.delete(w.id);
        host.emit('env.changed', { workspaceId: w.id, reason: 'files' });
      }, 400),
    );
  }

  stop(w: Pick<WorkspaceApi, 'id'>): void {
    for (const watcher of this.watchers.get(w.id)?.values() ?? []) watcher.close();
    this.watchers.delete(w.id);
    const pending = this.timers.get(w.id);
    if (pending) clearTimeout(pending);
    this.timers.delete(w.id);
  }

  stopAll(): void {
    for (const id of [...this.watchers.keys()]) this.stop({ id });
  }
}
