import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  GitConflictGetInputSchema,
  GitConflictResolveInputSchema,
  QuiverError,
  conflictKind,
  conflictLabels,
  conflictMarkerLines,
  conflictRegions,
  defineCommand,
  mergeMessageName,
  parseMarkerSize,
  parseUnmergedEntries,
  type CommandDefinition,
  type ConflictLabelInfo,
  type GitConflict,
  type GitConflictKind,
  type GitStatus,
} from '@quiver/core';
import { changed, workspace } from './commands-local';
import * as local from './local';

// Resolving merge conflicts one file at a time: the three index stages and the file with its markers to read, and a
// resolution to write and stage, either the whole file as edited or one whole side. Reading is open to agents;
// resolving writes the file and the index, so it is mutating.

/** A side or the file on disk over this comes back without contents, as `git.file.show` does. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

interface Contents {
  text: string | null;
  binary: boolean;
  tooLarge: boolean;
}

/** A path as git.status gives it: relative to the root, with forward slashes (a backslash is a separator on Windows). */
function normalize(p: string): string {
  if (/[\0\r\n]/.test(p)) throw new QuiverError('INVALID_INPUT', 'A path must not contain a line break or a NUL');
  return process.platform === 'win32' ? p.replace(/\\/g, '/') : p;
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/** The file's place on disk, refused when it resolves outside the repository's root. */
function onDisk(root: string, rel: string): string {
  const abs = path.resolve(root, rel);
  if (!isInside(root, abs)) throw new QuiverError('INVALID_INPUT', `${rel} is outside the repository`, { reason: 'outside-repository' });
  return abs;
}

/**
 * Before writing content: the nearest folder that exists must really be inside the repository (no symbolic link
 * leading out of it), and the file must not be a symbolic link itself, which the write would follow.
 */
async function requireWritable(root: string, rel: string, abs: string): Promise<void> {
  const realRoot = await realpath(root);
  let dir = path.dirname(abs);
  while (!existsSync(dir) && isInside(root, dir)) dir = path.dirname(dir);
  const realDir = await realpath(dir);
  if (realDir !== realRoot && !isInside(realRoot, realDir)) throw new QuiverError('INVALID_INPUT', `${rel} is outside the repository`, { reason: 'outside-repository' });
  const stat = await lstat(abs).catch(() => null);
  if (stat?.isSymbolicLink()) throw new QuiverError('INVALID_INPUT', `${rel} is a symbolic link; resolve it by taking a side`, { reason: 'symlink' });
  if (stat?.isDirectory()) throw new QuiverError('INVALID_INPUT', `${rel} is a folder on disk; resolve it by taking a side`);
}

/** The status, and what kind of conflict the path has; refused when it has none. */
async function conflicted(root: string, rel: string): Promise<{ status: GitStatus; kind: GitConflictKind }> {
  const status = await local.status(root);
  const file = status.files.find((f) => f.path === rel);
  const kind = file ? conflictKind(file) : null;
  if (!kind) throw new QuiverError('INVALID_INPUT', `${rel} has no conflict to resolve`, { reason: 'not-unmerged' });
  return { status, kind };
}

/** The index stages of a conflicted path: 1 the common ancestor, 2 ours, 3 theirs. */
async function stages(root: string, rel: string) {
  const out = await local.git(root, ['ls-files', '--unmerged', '-z', '--', rel], { env: local.LITERAL_PATHS_ENV });
  return parseUnmergedEntries(out.stdout).filter((e) => e.path === rel);
}

/** The path's `conflict-marker-size` attribute, which sets how long git writes its markers (7 by default). */
async function markerSize(root: string, rel: string): Promise<number> {
  const out = await local.git(root, ['check-attr', '-z', 'conflict-marker-size', '--', rel], { allowFailure: true });
  return parseMarkerSize(out.code === 0 ? out.stdout : '');
}

/** A blob's text, or why there is none. A submodule's entry (mode 160000) names a commit, not a blob: no contents. */
async function blob(root: string, object: string, mode: string): Promise<Contents> {
  if (mode === '160000') return { text: null, binary: true, tooLarge: false };
  const size = Number((await local.git(root, ['cat-file', '-s', object])).stdout.trim());
  if (size > MAX_FILE_BYTES) return { text: null, binary: false, tooLarge: true };
  const { stdout } = await local.git(root, ['cat-file', 'blob', object]);
  if (stdout.slice(0, 8000).includes('\0')) return { text: null, binary: true, tooLarge: false };
  return { text: stdout, binary: false, tooLarge: false };
}

/** The file on disk, or null when it is not there. */
async function working(abs: string): Promise<Contents> {
  const stat = await lstat(abs).catch(() => null);
  if (!stat || !stat.isFile()) return { text: null, binary: false, tooLarge: false };
  if (stat.size > MAX_FILE_BYTES) return { text: null, binary: false, tooLarge: true };
  const bytes = await readFile(abs);
  if (bytes.subarray(0, 8000).includes(0)) return { text: null, binary: true, tooLarge: false };
  return { text: bytes.toString('utf8'), binary: false, tooLarge: false };
}

/** What the operation in progress says about ours and theirs, read from git's own files. */
async function labels(root: string, status: GitStatus): Promise<GitConflict['labels']> {
  const { gitDir } = await local.repoDirs(root);
  const read = (name: string) => readFile(path.join(gitDir, name), 'utf8').then((s) => s.trim(), () => undefined);
  const commit = async (ref: string) => {
    const r = await local.git(root, ['log', '-1', '--format=%h %s', ref, '--'], { allowFailure: true });
    return r.code === 0 ? r.stdout.trim() || undefined : undefined;
  };
  const info: ConflictLabelInfo = { operation: status.operation, current: status.branch ?? (status.head ? status.head.slice(0, 7) : 'HEAD') };
  switch (status.operation) {
    case 'merge':
      info.merging = mergeMessageName((await read('MERGE_MSG')) ?? '') ?? (await read('MERGE_HEAD'))?.slice(0, 7);
      break;
    case 'rebase': {
      const dir = existsSync(path.join(gitDir, 'rebase-merge')) ? 'rebase-merge' : 'rebase-apply';
      const headName = await read(`${dir}/head-name`);
      if (headName?.startsWith('refs/heads/')) info.rebasing = headName.slice('refs/heads/'.length);
      const onto = await read(`${dir}/onto`);
      if (onto && /^[0-9a-f]{4,64}$/i.test(onto)) {
        // The branch or tag it was rebased onto, when one still points there; else its short hash.
        const names = (await local.git(root, ['for-each-ref', `--points-at=${onto}`, '--format=%(refname:short)', 'refs/heads', 'refs/remotes', 'refs/tags'], { allowFailure: true })).stdout.split(/\r?\n/).filter(Boolean);
        info.onto = names[0] ?? onto.slice(0, 7);
      }
      info.commit = await commit('REBASE_HEAD');
      break;
    }
    case 'cherry-pick':
      info.commit = await commit('CHERRY_PICK_HEAD');
      break;
    case 'revert':
      info.commit = await commit('REVERT_HEAD');
      break;
  }
  return conflictLabels(info);
}

/** The operation's commit that brings the incoming side; a revert's and a stash apply's side has none of its own. */
const INCOMING_HEAD: Partial<Record<NonNullable<GitStatus['operation']>, string>> = { merge: 'MERGE_HEAD', 'cherry-pick': 'CHERRY_PICK_HEAD', rebase: 'REBASE_HEAD' };

/** The commits ours and theirs come from (HEAD and the operation's incoming commit), for blaming a side. */
async function sideCommits(root: string, status: GitStatus): Promise<GitConflict['commits']> {
  const hash = async (ref: string) => {
    const r = await local.git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { allowFailure: true });
    return r.code === 0 ? r.stdout.trim() || undefined : undefined;
  };
  const incoming = status.operation ? INCOMING_HEAD[status.operation] : undefined;
  const [ours, theirs] = await Promise.all([hash('HEAD'), incoming ? hash(incoming) : undefined]);
  return { ...(ours ? { ours } : {}), ...(theirs ? { theirs } : {}) };
}

const get = defineCommand({
  id: 'git.conflict.get',
  title: 'Get git conflict',
  description:
    'One conflicted file: kind (both-modified, both-added, both-deleted, deleted-by-us, deleted-by-them, added-by-us, added-by-them, from git.status), the three index stages as ours (stage 2), theirs (stage 3) and base (stage 1, the common ancestor), each null when that side has no file, the working file with its conflict markers, and labels naming what ours and theirs are. In a merge, cherry-pick or revert ours is the current branch; in a rebase they swap: ours is the branch being rebased onto, theirs the commit being replayed. commits gives the full hashes the sides come from, to blame a side at (git.blame with ref): ours is HEAD, theirs the incoming commit (MERGE_HEAD, CHERRY_PICK_HEAD or REBASE_HEAD; absent in a revert or after a stash apply). A binary file or one over 2 MB comes back without contents (binary, tooLarge). markerSize is the length of its conflict markers (the conflict-marker-size attribute, 7 by default). Refused for a path with no conflict (details.reason "not-unmerged").',
  scope: 'workspace',
  input: GitConflictGetInputSchema,
  handler: async ({ path: input }, ctx): Promise<GitConflict> => {
    const ws = workspace(ctx);
    const root = await local.repoRoot(ws.path);
    const rel = normalize(input);
    const abs = onDisk(root, rel);
    const { status, kind } = await conflicted(root, rel);
    const entries = await stages(root, rel);
    const at = async (stage: 1 | 2 | 3): Promise<Contents | null> => {
      const entry = entries.find((e) => e.stage === stage);
      return entry ? blob(root, entry.object, entry.mode) : null;
    };
    const [base, ours, theirs, file, size] = await Promise.all([at(1), at(2), at(3), working(abs), markerSize(root, rel)]);
    const all = [base, ours, theirs, file].filter((c): c is Contents => c !== null);
    const binary = all.some((c) => c.binary);
    const tooLarge = all.some((c) => c.tooLarge);
    const text = (c: Contents | null) => (binary || tooLarge ? null : (c?.text ?? null));
    return {
      path: rel,
      kind,
      ...(status.operation ? { operation: status.operation } : {}),
      ours: text(ours),
      theirs: text(theirs),
      base: text(base),
      working: text(file),
      labels: await labels(root, status),
      commits: await sideCommits(root, status),
      binary,
      tooLarge,
      markerSize: size,
    };
  },
});

const resolve = defineCommand({
  id: 'git.conflict.resolve',
  title: 'Resolve git conflict',
  description:
    'Resolves one conflicted file and stages it, with exactly one of: content, the whole resolved file, written as given (refused while it still holds a conflict or a leftover start, base or end marker line, details.reason "markers" with conflicts and lines, unless allowMarkers); or take, one whole side: ours (index stage 2), theirs (stage 3), base (stage 1; refused when there is none) or delete. Taking a side that has no file (ours of a file deleted by us) deletes it. The path must be conflicted (details.reason "not-unmerged") and inside the repository. Gives back the new status; continue the operation with git.operation.continue once nothing is left in conflict.',
  scope: 'workspace',
  mutating: true,
  input: GitConflictResolveInputSchema,
  handler: async ({ path: input, content, take, allowMarkers }, ctx): Promise<GitStatus> => {
    const ws = workspace(ctx);
    if ((content === undefined) === (take === undefined)) throw new QuiverError('INVALID_INPUT', 'Give either content or take, not both');
    const root = await local.repoRoot(ws.path);
    const rel = normalize(input);
    const abs = onDisk(root, rel);
    await conflicted(root, rel);
    const literal = { env: local.LITERAL_PATHS_ENV };
    if (content !== undefined) {
      if (!allowMarkers) {
        const size = await markerSize(root, rel);
        const left = conflictRegions(content, size).length;
        const lines = conflictMarkerLines(content, size);
        if (left) {
          throw new QuiverError('INVALID_INPUT', `${rel} still has ${left} conflict${left === 1 ? '' : 's'} marked in it; resolve ${left === 1 ? 'it' : 'them'} first, or pass allowMarkers to write it as it is`, { reason: 'markers', conflicts: left, lines });
        }
        if (lines.length) {
          throw new QuiverError('INVALID_INPUT', `${rel} still has a conflict marker on line ${lines.join(', ')}; remove it, or pass allowMarkers to write it as it is`, { reason: 'markers', conflicts: 0, lines });
        }
      }
      await requireWritable(root, rel, abs);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, content, 'utf8');
      await local.git(root, ['add', '--', rel], literal);
    } else {
      const stage = take === 'ours' ? 2 : take === 'theirs' ? 3 : take === 'base' ? 1 : null;
      const present = stage !== null && (await stages(root, rel)).some((e) => e.stage === stage);
      if (take === 'base' && !present) throw new QuiverError('INVALID_INPUT', `${rel} has no common ancestor to take: both sides added it`, { reason: 'no-base' });
      if (stage !== null && present) {
        // Writes that stage's blob to the working tree as git would check it out (filters, mode, symbolic links).
        await local.git(root, ['checkout-index', '--force', `--stage=${stage}`, '--', rel]);
        await local.git(root, ['add', '--', rel], literal);
      } else {
        // Delete, or a side that deleted the file.
        await local.git(root, ['rm', '--quiet', '--force', '--', rel], literal);
      }
    }
    changed(ctx, ws, 'status');
    return local.status(root);
  },
});

export const conflictCommands: CommandDefinition[] = [get, resolve];
