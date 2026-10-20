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
// A cloned project is not trusted: nothing here runs anything, nothing is read from outside the workspace folder
// (symlinks and junctions included), files over 2 MB are skipped and the folders a pattern may walk are capped.

/** Folders a `**` pattern never walks into. */
const SKIP_DIRS = new Set(['node_modules', '.git', '.quiver', 'dist', 'out', 'build']);
/** How deep `**` walks, and how many workspace packages are read at most. */
const MAX_DEPTH = 5;
const MAX_PACKAGES = 200;
/** How many folders the patterns may list in all, so `**` in a huge tree still ends soon. */
const MAX_DIRS = 5000;
/** A file bigger than this is not a script list anyone wrote by hand; it is skipped rather than read into memory. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** One discovery: the workspace folder as given and as it really is on disk, and the folders listed so far. */
interface Scan {
  root: string;
  realRoot: string;
  dirsListed: number;
}

/** Whether a path, once its symlinks and junctions are resolved, is inside the workspace folder; false when it is missing. */
async function inside(scan: Scan, file: string): Promise<boolean> {
  try {
    const back = path.relative(scan.realRoot, await fs.realpath(file));
    return back !== '..' && !back.startsWith(`..${path.sep}`) && !path.isAbsolute(back);
  } catch {
    return false;
  }
}

/** A file inside the workspace folder and no bigger than `MAX_FILE_BYTES`, or null. */
async function readText(scan: Scan, file: string): Promise<string | null> {
  try {
    if (!(await inside(scan, file))) return null;
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
    return await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

async function isFile(scan: Scan, file: string): Promise<boolean> {
  try {
    return (await inside(scan, file)) && (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
}

/** The real folders in a folder (symlinks are not followed), none once `MAX_DIRS` folders have been listed. */
async function subdirs(scan: Scan, rel: string): Promise<string[]> {
  if (scan.dirsListed >= MAX_DIRS) return [];
  scan.dirsListed++;
  const dir = path.join(scan.root, rel);
  if (!(await inside(scan, dir))) return [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name)).map((e) => e.name);
  } catch {
    return [];
  }
}

const under = (rel: string, name: string) => (rel ? `${rel}/${name}` : name);

/**
 * The folders, relative to the root with forward slashes, that a normalized workspace pattern (`packages/*`, `apps/**`)
 * names, each once. `**` walks breadth first from all the folders found so far together, so each folder is listed once.
 */
async function expand(scan: Scan, pattern: string): Promise<string[]> {
  let found = new Set(['']);
  for (const segment of pattern.split('/')) {
    const next = new Set<string>();
    if (segment === '**') {
      let level = [...found];
      for (let depth = 0; level.length; depth++) {
        for (const rel of level) next.add(rel);
        if (depth >= MAX_DEPTH) break;
        const deeper: string[] = [];
        for (const rel of level) for (const name of await subdirs(scan, rel)) if (!next.has(under(rel, name))) deeper.push(under(rel, name));
        level = deeper;
      }
    } else if (/[*?]/.test(segment)) {
      for (const rel of found) for (const name of await subdirs(scan, rel)) if (matchSegment(segment, name)) next.add(under(rel, name));
    } else {
      for (const rel of found) next.add(under(rel, segment));
    }
    found = next;
  }
  return [...found];
}

/** The workspace package folders with a package.json, in pattern order, without those a `!` pattern excludes. */
async function workspacePackages(scan: Scan, patterns: string[]): Promise<string[]> {
  const excluded = new Set<string>();
  for (const p of patterns.filter((p) => p.startsWith('!'))) for (const dir of await expand(scan, p.slice(1))) excluded.add(dir);
  const out = new Set<string>();
  for (const p of patterns.filter((p) => !p.startsWith('!'))) {
    for (const dir of await expand(scan, p)) {
      if (!dir || excluded.has(dir) || out.has(dir)) continue;
      if (await isFile(scan, path.join(scan.root, dir, 'package.json'))) out.add(dir);
      if (out.size >= MAX_PACKAGES) return [...out];
    }
  }
  return [...out];
}

async function discoverIn(scan: Scan, place: DiscoverPlace, pm: PackageManager, packageJson: string | null): Promise<RunnerDiscoveredTask[]> {
  const dir = path.join(scan.root, place.cwd);
  if (!(await inside(scan, dir))) return [];
  const files = new Set(await fs.readdir(dir).catch(() => [] as string[]));
  const out: RunnerDiscoveredTask[] = [];
  if (packageJson) out.push(...discoverPackageScripts(packageJson, pm, place));
  // The first name make or just would pick; on a case-insensitive disk the readdir name is the one that exists.
  const makefile = MAKEFILES.find((f) => files.has(f));
  const makeText = makefile ? await readText(scan, path.join(dir, makefile)) : null;
  if (makefile && makeText !== null) out.push(...discoverMakeTargets(makeText, makefile, place));
  const justfile = JUSTFILES.find((f) => files.has(f));
  const justText = justfile ? await readText(scan, path.join(dir, justfile)) : null;
  if (justfile && justText !== null) out.push(...discoverJustRecipes(justText, justfile, place));
  for (const compose of COMPOSE_FILES.filter((f) => files.has(f))) {
    const text = await readText(scan, path.join(dir, compose));
    if (text !== null) out.push(...discoverComposeServices(text, compose, place));
  }
  return out;
}

/** Every task the project's own files define, the workspace folder first, then each workspace package. */
export async function discoverTasks(ws: WorkspaceApi): Promise<RunnerDiscoveredTask[]> {
  const root = path.resolve(ws.path);
  const scan: Scan = { root, realRoot: await fs.realpath(root).catch(() => root), dirsListed: 0 };
  const rootFiles = await fs.readdir(root).catch(() => [] as string[]);
  const rootPkg = await readText(scan, path.join(root, 'package.json'));
  const pm = pickPackageManager(rootPkg, rootFiles);
  const patterns = workspacePatterns(rootPkg, await readText(scan, path.join(root, 'pnpm-workspace.yaml')));
  const out = await discoverIn(scan, { cwd: '', label: '' }, pm, rootPkg);
  for (const dir of await workspacePackages(scan, patterns)) {
    const pkg = await readText(scan, path.join(root, dir, 'package.json'));
    out.push(...(await discoverIn(scan, { cwd: dir, label: (pkg && packageName(pkg)) || dir }, pm, pkg)));
  }
  return out;
}
