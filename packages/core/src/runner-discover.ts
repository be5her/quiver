import { parse as parseYaml } from 'yaml';
import type { RunnerDiscoveredTask } from './models/runner';

// Task discovery from package.json scripts, Makefiles, justfiles and compose files, pure functions with unit tests.
// The runner module reads the files and walks the workspace packages; these turn a file's text into tasks.

export type PackageManager = 'npm' | 'pnpm' | 'yarn';

/** Where a task was found: the folder relative to the workspace (empty for the root), the file, and a label for names. */
export interface DiscoverPlace {
  /** The folder, relative to the workspace folder with forward slashes; empty is the workspace folder itself. */
  cwd: string;
  /** Put before the task name in a workspace package (`@scope/pkg: build`); empty at the root. */
  label: string;
}

/** Scripts npm runs by itself around install, pack, publish and version, which are not tasks to start. */
const LIFECYCLE = new Set([
  'preinstall',
  'install',
  'postinstall',
  'prepare',
  'prepublish',
  'prepublishOnly',
  'prepack',
  'postpack',
  'publish',
  'postpublish',
  'preversion',
  'version',
  'postversion',
  'dependencies',
]);

/** The lockfiles, in the order they decide the package manager when `packageManager` does not. */
const LOCKFILES: [string, PackageManager][] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['package-lock.json', 'npm'],
  ['npm-shrinkwrap.json', 'npm'],
];

export const MAKEFILES = ['GNUmakefile', 'makefile', 'Makefile'];
export const JUSTFILES = ['justfile', 'Justfile', '.justfile'];
export const COMPOSE_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml'];

function join(dir: string, file: string): string {
  return dir ? `${dir}/${file}` : file;
}

function named(place: DiscoverPlace, name: string): string {
  return place.label ? `${place.label}: ${name}` : name;
}

/**
 * What a POSIX shell or cmd.exe still acts on inside double quotes (`$`, a backquote, `%`, `!`), what neither can put
 * inside them the same way (`"`, `\`), and control characters such as a line break.
 */
const UNQUOTABLE = /["\\$`%!\u0000-\u001f\u007f]/;

/**
 * A word for the shell, the same for sh and cmd.exe since a saved task is committed and may run on either: kept as it
 * is when it is plain, in double quotes when nothing in it means anything there, else null (the name is left out
 * rather than run as something else). One starting with `-` is null too: the program would read it as an option.
 */
export function shellWord(word: string): string | null {
  if (!word || word.startsWith('-')) return null;
  if (/^[\w:.@/+=-]+$/.test(word)) return word;
  return UNQUOTABLE.test(word) ? null : `"${word}"`;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The package manager of the workspace root: the `packageManager` field of its package.json (`pnpm@9.1.0`), then its
 * lockfile (pnpm, yarn, npm), else npm.
 */
export function pickPackageManager(packageJson: string | null, files: Iterable<string>): PackageManager {
  const field = packageJson ? parseJsonObject(packageJson)?.['packageManager'] : undefined;
  if (typeof field === 'string') {
    const name = field.split('@')[0];
    if (name === 'npm' || name === 'pnpm' || name === 'yarn') return name;
  }
  const present = new Set(files);
  return LOCKFILES.find(([file]) => present.has(file))?.[1] ?? 'npm';
}

/** The package name of a package.json, or null. */
export function packageName(packageJson: string): string | null {
  const name = parseJsonObject(packageJson)?.['name'];
  return typeof name === 'string' && name ? name : null;
}

/**
 * A workspace pattern with forward slashes and without empty or `.` segments, a run of `**` as one, or null when it
 * would leave the workspace folder: a `..` segment, a leading slash or a drive letter. The `!` of an exclusion stays.
 */
export function normalizePattern(pattern: string): string | null {
  let p = pattern.trim();
  const negated = p.startsWith('!');
  if (negated) p = p.slice(1).trim();
  p = p.replace(/\\/g, '/');
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return null;
  const segments = p.split('/').filter((s) => s && s !== '.');
  if (!segments.length || segments.includes('..')) return null;
  const collapsed = segments.filter((s, i) => !(s === '**' && segments[i - 1] === '**'));
  return (negated ? '!' : '') + collapsed.join('/');
}

/**
 * The workspace package patterns: `workspaces` in package.json (a list, or `{ packages }` as yarn 1 allows) and
 * `packages` in pnpm-workspace.yaml, normalized (`normalizePattern`), without those that would leave the workspace.
 * Negated patterns (`!packages/old`) come back with their `!`.
 */
export function workspacePatterns(packageJson: string | null, pnpmWorkspaceYaml?: string | null): string[] {
  const out: string[] = [];
  const pkg = packageJson ? parseJsonObject(packageJson) : null;
  const field = pkg?.['workspaces'];
  const list = Array.isArray(field) ? field : field && typeof field === 'object' ? (field as { packages?: unknown }).packages : undefined;
  if (Array.isArray(list)) out.push(...list.filter((p): p is string => typeof p === 'string'));
  if (pnpmWorkspaceYaml) {
    try {
      const doc = parseYaml(pnpmWorkspaceYaml) as { packages?: unknown } | null;
      if (Array.isArray(doc?.packages)) out.push(...doc.packages.filter((p): p is string => typeof p === 'string'));
    } catch {
      // A broken pnpm-workspace.yaml lists no packages.
    }
  }
  return [...new Set(out.map(normalizePattern).filter((p): p is string => p !== null))];
}

/**
 * Whether a folder name matches one segment of a workspace pattern (`*` for any run of characters, `?` for one).
 * Matched by walking both strings, going back only to the last `*`, so no pattern from a cloned project can make it
 * backtrack for ages the way a regular expression of `.*.*.*` would.
 */
export function matchSegment(pattern: string, name: string): boolean {
  let p = 0;
  let n = 0;
  let star = -1;
  let mark = 0;
  while (n < name.length) {
    if (p < pattern.length && (pattern[p] === '?' || pattern[p] === name[n])) {
      p++;
      n++;
    } else if (p < pattern.length && pattern[p] === '*') {
      star = p++;
      mark = n;
    } else if (star !== -1) {
      p = star + 1;
      n = ++mark;
    } else {
      return false;
    }
  }
  while (pattern[p] === '*') p++;
  return p === pattern.length;
}

/** The scripts of a package.json as tasks, run with the workspace's package manager in the package's folder. */
export function discoverPackageScripts(packageJson: string, pm: PackageManager, place: DiscoverPlace): RunnerDiscoveredTask[] {
  const scripts = parseJsonObject(packageJson)?.['scripts'];
  if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) return [];
  const names = Object.keys(scripts).filter((name) => typeof (scripts as Record<string, unknown>)[name] === 'string');
  const has = new Set(names);
  const hookOf = (name: string) => /^(?:pre|post)(.+)$/.exec(name)?.[1];
  return (
    names
      .filter((name) => !LIFECYCLE.has(name))
      // A pre or post hook of another script runs with it, not on its own: `prebuild` when there is a `build`, the way
      // npm itself decides (so `preview` is a hook when there is a `view` script, and a script of its own otherwise).
      .filter((name) => {
        const base = hookOf(name);
        return base === undefined || !has.has(base);
      })
      .flatMap((name) => {
        const word = shellWord(name);
        return word ? [{ source: 'npm' as const, name: named(place, name), command: `${pm} run ${word}`, cwd: place.cwd, file: join(place.cwd, 'package.json') }] : [];
      })
  );
}

/**
 * The targets of a Makefile that a person would run: explicit targets, not special ones (`.PHONY`), pattern rules
 * (`%.o`), targets built from variables, or variable assignments, and nothing inside `define` blocks.
 */
export function discoverMakeTargets(text: string, file: string, place: DiscoverPlace): RunnerDiscoveredTask[] {
  const targets: string[] = [];
  let inDefine = false;
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*define\b/.test(raw)) inDefine = true;
    if (inDefine) {
      if (/^\s*endef\b/.test(raw)) inDefine = false;
      continue;
    }
    // Recipe lines start with a tab; comments and directives have no rule colon.
    if (raw.startsWith('\t') || /^\s*#/.test(raw)) continue;
    // Everything up to the first `:`, `=` or `#`, which must be the rule's colon. One greedy run and no part that
    // could take the same characters as another, so a long line cannot make it backtrack.
    const m = /^([^\s:=#][^:=#]*)::?(?![:=])/.exec(raw);
    if (!m) continue;
    for (const target of m[1].trim().split(/\s+/)) {
      if (!target || target.startsWith('.') || /[%$()]/.test(target) || target.includes('\\')) continue;
      if (!targets.includes(target)) targets.push(target);
    }
  }
  return targets.flatMap((target) => {
    const word = shellWord(target);
    return word ? [{ source: 'make' as const, name: named(place, target), command: `make ${word}`, cwd: place.cwd, file: join(place.cwd, file) }] : [];
  });
}

/** A just attribute line that makes the next recipe private: `[private]`, or `private` in a list (`[no-cd, private]`). */
const PRIVATE_ATTRIBUTE = /^\[(?:[^\]]*,)?\s*private\s*[,\]]/;

/** The public recipes of a justfile: not those starting with `_` or marked `[private]`, nor settings, aliases or variables. */
export function discoverJustRecipes(text: string, file: string, place: DiscoverPlace): RunnerDiscoveredTask[] {
  const recipes: string[] = [];
  let hidden = false;
  for (const raw of text.split(/\r?\n/)) {
    // Recipe bodies are indented; blank lines and comments do not end a run of attributes.
    if (/^\s/.test(raw) || !raw.trim() || raw.startsWith('#')) continue;
    if (raw.startsWith('[')) {
      if (PRIVATE_ATTRIBUTE.test(raw)) hidden = true;
      continue;
    }
    // The name, then parameters after one blank (the rest up to the colon), so no two parts can take the same blanks.
    const m = /^@?([A-Za-z_][\w-]*)(?:\s[^:]*)?:(?![=])/.exec(raw);
    const wasHidden = hidden;
    hidden = false;
    if (!m || wasHidden || m[1].startsWith('_')) continue;
    if (!recipes.includes(m[1])) recipes.push(m[1]);
  }
  return recipes.map((recipe) => ({ source: 'just' as const, name: named(place, recipe), command: `just ${recipe}`, cwd: place.cwd, file: join(place.cwd, file) }));
}

/** A service name as Docker Compose allows it; anything else is left out rather than quoted. */
const COMPOSE_SERVICE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

/** The services of a compose file, each brought up with `docker compose -f <file> up <service>`. */
export function discoverComposeServices(text: string, file: string, place: DiscoverPlace): RunnerDiscoveredTask[] {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch {
    return [];
  }
  const services = doc && typeof doc === 'object' ? (doc as { services?: unknown }).services : undefined;
  if (!services || typeof services !== 'object' || Array.isArray(services)) return [];
  return Object.keys(services).filter((service) => COMPOSE_SERVICE.test(service)).map((service) => ({
    source: 'compose' as const,
    name: named(place, service),
    command: `docker compose -f ${file} up ${service}`,
    cwd: place.cwd,
    file: join(place.cwd, file),
  }));
}
