import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  COMPOSE_FILES,
  JUSTFILES,
  MAKEFILES,
  discoverComposeServices,
  discoverJustRecipes,
  discoverMakeTargets,
  discoverPackageScripts,
  matchSegment,
  packageName,
  pickPackageManager,
  workspacePatterns,
  type DiscoverPlace,
  type PackageManager,
  type RunnerDiscoveredTask,
  type WorkspaceApi,
} from '@quiver/core';

// Finds the scripts a project already has: package.json scripts (the root's and its workspace packages'), Makefile
// targets, justfile recipes and compose services, in the workspace folder and in every workspace package folder.

/** Folders a `**` pattern never walks into. */
const SKIP_DIRS = new Set(['node_modules', '.git', '.quiver', 'dist', 'out', 'build']);
/** How deep `**` walks, and how many workspace packages are read at most. */
const MAX_DEPTH = 5;
const MAX_PACKAGES = 200;

async function readText(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

async function subdirs(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name)).map((e) => e.name);
  } catch {
    return [];
  }
}

/** The folders, relative to the root with forward slashes, that a workspace pattern (`packages/*`, `apps/**`) names. */
async function expand(root: string, pattern: string): Promise<string[]> {
  let found = [''];
  for (const segment of pattern.split('/')) {
    const next: string[] = [];
    for (const rel of found) {
      if (segment === '**') {
        const walk = async (dir: string, depth: number): Promise<void> => {
          next.push(dir);
          if (depth >= MAX_DEPTH) return;
          for (const name of await subdirs(path.join(root, dir))) await walk(dir ? `${dir}/${name}` : name, depth + 1);
        };
        await walk(rel, 0);
      } else if (/[*?]/.test(segment)) {
        for (const name of await subdirs(path.join(root, rel))) if (matchSegment(segment, name)) next.push(rel ? `${rel}/${name}` : name);
      } else if (segment !== '.' && segment !== '..') {
        next.push(rel ? `${rel}/${segment}` : segment);
      }
    }
    found = next;
  }
  return found;
}

/** The workspace package folders with a package.json, in pattern order, without those a `!` pattern excludes. */
async function workspacePackages(root: string, patterns: string[]): Promise<string[]> {
  const excluded = new Set<string>();
  for (const p of patterns.filter((p) => p.startsWith('!'))) for (const dir of await expand(root, p.slice(1))) excluded.add(dir);
  const out: string[] = [];
  for (const p of patterns.filter((p) => !p.startsWith('!'))) {
    for (const dir of await expand(root, p)) {
      if (!dir || excluded.has(dir) || out.includes(dir)) continue;
      if ((await readText(path.join(root, dir, 'package.json'))) !== null) out.push(dir);
      if (out.length >= MAX_PACKAGES) return out;
    }
  }
  return out;
}

async function discoverIn(root: string, place: DiscoverPlace, pm: PackageManager, packageJson: string | null): Promise<RunnerDiscoveredTask[]> {
  const dir = path.join(root, place.cwd);
  const files = new Set(await fs.readdir(dir).catch(() => [] as string[]));
  const out: RunnerDiscoveredTask[] = [];
  if (packageJson) out.push(...discoverPackageScripts(packageJson, pm, place));
  // The first name make or just would pick; on a case-insensitive disk the readdir name is the one that exists.
  const makefile = MAKEFILES.find((f) => files.has(f));
  const makeText = makefile ? await readText(path.join(dir, makefile)) : null;
  if (makefile && makeText !== null) out.push(...discoverMakeTargets(makeText, makefile, place));
  const justfile = JUSTFILES.find((f) => files.has(f));
  const justText = justfile ? await readText(path.join(dir, justfile)) : null;
  if (justfile && justText !== null) out.push(...discoverJustRecipes(justText, justfile, place));
  for (const compose of COMPOSE_FILES.filter((f) => files.has(f))) {
    const text = await readText(path.join(dir, compose));
    if (text !== null) out.push(...discoverComposeServices(text, compose, place));
  }
  return out;
}

/** Every task the project's own files define, the workspace folder first, then each workspace package. */
export async function discoverTasks(ws: WorkspaceApi): Promise<RunnerDiscoveredTask[]> {
  const root = path.resolve(ws.path);
  const rootFiles = await fs.readdir(root).catch(() => [] as string[]);
  const rootPkg = await readText(path.join(root, 'package.json'));
  const pm = pickPackageManager(rootPkg, rootFiles);
  const patterns = workspacePatterns(rootPkg, await readText(path.join(root, 'pnpm-workspace.yaml')));
  const out = await discoverIn(root, { cwd: '', label: '' }, pm, rootPkg);
  for (const dir of await workspacePackages(root, patterns)) {
    const pkg = await readText(path.join(root, dir, 'package.json'));
    out.push(...(await discoverIn(root, { cwd: dir, label: (pkg && packageName(pkg)) || dir }, pm, pkg)));
  }
  return out;
}
