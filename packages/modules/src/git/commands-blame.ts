import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { GitBlameInputSchema, QuiverError, defineCommand, parseBlamePorcelain, type CommandDefinition, type GitBlame } from '@quiver/core';
import { workspace } from './commands-local';
import * as local from './local';

// Lane A of docs/plans/git-blame-conflicts-pr-worktrees.md: who last changed each line of a file. A read, open to
// agents. One git process at the repository root, the path after `--`, the file checked first as git.file.show
// checks it, so a huge or binary file is refused rather than blamed.

/** Blame walks the file's history, which in a long-lived repository takes far longer than a status. */
const BLAME_TIMEOUT_MS = 120_000;
/** The file GitHub and most tools read for commits blame should look through (mass reformatting and the like). */
const IGNORE_REVS_FILE = '.git-blame-ignore-revs';

function tooLarge(file: string, size: number): QuiverError {
  return new QuiverError('INVALID_INPUT', `${file} is ${(size / 1024 / 1024).toFixed(1)} MB; blame shows files up to 2 MB`, { reason: 'too-large', size });
}

function binary(file: string): QuiverError {
  return new QuiverError('INVALID_INPUT', `${file} is a binary file; blame shows text files only`, { reason: 'binary' });
}

/** A path that stays inside the repository, checked for a blame at a ref as much as in the working tree (git's own refusal names the repository's folder). */
function checkInside(root: string, file: string): string {
  const abs = path.resolve(root, file);
  const inside = path.relative(root, abs);
  if (!inside || inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) throw new QuiverError('INVALID_INPUT', `${file} is not a file inside the repository`);
  return abs;
}

/**
 * The working tree's copy of a file: a file, at most 2 MB and not binary (a NUL in its first 8000 bytes, git's own
 * test). A symbolic link is not followed: git blames the link itself, its target path.
 */
async function checkWorkingFile(abs: string, file: string): Promise<void> {
  const stat = await fs.lstat(abs).catch(() => null);
  if (!stat) throw new QuiverError('NOT_FOUND', `${file} is not in the working tree; give a ref (HEAD) to blame it as committed`);
  if (stat.isDirectory()) throw new QuiverError('INVALID_INPUT', `${file} is a folder`);
  if (stat.isSymbolicLink()) return;
  if (stat.size > local.MAX_FILE_BYTES) throw tooLarge(file, stat.size);
  const handle = await fs.open(abs, 'r');
  try {
    const head = Buffer.alloc(Math.min(8000, stat.size));
    await handle.read(head, 0, head.length, 0);
    if (head.includes(0)) throw binary(file);
  } finally {
    await handle.close();
  }
}

/**
 * `git blame --porcelain [-w] [--ignore-revs-file=…] [<ref>] -- <path>`, parsed. Without a ref the working tree's
 * file is blamed, its uncommitted lines with `commit: null`. The repository's `.git-blame-ignore-revs` is passed when
 * it exists; when git cannot use it (a commit it names is not in this clone), the blame runs again without it.
 */
export async function blame(cwd: string, input: { path: string; ref?: string; ignoreWhitespace: boolean }): Promise<GitBlame> {
  if (/[\r\n]/.test(input.path)) throw new QuiverError('INVALID_INPUT', 'A path must not contain a line break');
  // Git takes forward slashes; a Windows file name cannot hold a backslash, so there one is a separator.
  const file = process.platform === 'win32' ? input.path.replace(/\\/g, '/') : input.path;
  const root = await local.repoRoot(cwd);
  const abs = checkInside(root, file);
  if (input.ref) {
    const content = await local.fileAt(root, { ref: input.ref, index: false, path: file });
    if (content.tooLarge) throw tooLarge(file, content.size);
    if (content.binary) throw binary(file);
  } else await checkWorkingFile(abs, file);
  const base = ['blame', '--porcelain', ...(input.ignoreWhitespace ? ['-w'] : [])];
  const tail = [...(input.ref ? [input.ref] : []), '--', file];
  const ignoreRevs = existsSync(path.join(root, IGNORE_REVS_FILE));
  const runBlame = (withIgnore: boolean) => local.git(root, [...base, ...(withIgnore ? [`--ignore-revs-file=${IGNORE_REVS_FILE}`] : []), ...tail], { timeoutMs: BLAME_TIMEOUT_MS, allowFailure: true });
  let result = await runBlame(ignoreRevs);
  // Without the file, whatever git says is the answer: when both runs fail, its error is the real one.
  if (result.code !== 0 && ignoreRevs) result = await runBlame(false);
  if (result.code !== 0) {
    // A file on disk git has never been told about (untracked, not in the index) has no history.
    if (!input.ref && /no such path .* in HEAD/.test(result.stderr)) throw new QuiverError('NOT_FOUND', `${file} is not tracked by git yet, so it has no history to blame`, { reason: 'untracked' });
    throw local.gitFailure(base, result);
  }
  if (result.truncated) throw new QuiverError('REQUEST_FAILED', `The blame of ${file} is larger than git's output limit`);
  return parseBlamePorcelain(result.stdout, { path: file, ...(input.ref ? { ref: input.ref } : {}) });
}

const blameCommand = defineCommand({
  id: 'git.blame',
  title: 'Git blame',
  description:
    "Who last changed each line of a file. lines: each line's number, text, the hash of the commit that last changed it (null for a line not committed yet) and its line number in that commit. commits, keyed by hash and listed once: author, email, author time, summary, the file's path in that commit, previous (the commit before it and the path there: blame that to look further back) and boundary. At ref (a commit, branch or tag), else the working tree. ignoreWhitespace leaves whitespace-only changes out (git blame -w). The repository's .git-blame-ignore-revs is honoured. Files over 2 MB and binary files are refused. path is relative to the repository root.",
  scope: 'workspace',
  input: GitBlameInputSchema,
  handler: async (input, ctx): Promise<GitBlame> => blame(workspace(ctx).path, input),
});

export const blameCommands: CommandDefinition[] = [blameCommand];
