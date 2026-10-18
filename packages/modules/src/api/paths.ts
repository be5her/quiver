import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * The real path of `abs`: links followed in every part of it that exists, so a file still to be
 * written under a linked folder resolves to where it would really land.
 */
export async function realPathOf(abs: string): Promise<string> {
  try {
    return await fs.realpath(abs);
  } catch {
    const parent = path.dirname(abs);
    if (parent === abs) return abs;
    return path.join(await realPathOf(parent), path.basename(abs));
  }
}

/** Folders of a project an agent never writes into: the repository's own data, and Quiver's secrets and local state. */
const PROTECTED_FOLDERS = ['.git', '.quiver/local'];

/**
 * Where `given` (as typed: relative to the project folder, or absolute) is, for an agent: `abs` for
 * one inside the project, with links followed on both sides, else a reason it is refused. With
 * `writing`, the repository's `.git` and `.quiver/local` are refused as well, whatever is in them.
 */
export async function agentPath(projectDir: string, given: string, options: { writing?: boolean } = {}): Promise<{ abs: string; refused?: undefined } | { abs?: undefined; refused: string }> {
  const trimmed = given.trim();
  const abs = path.isAbsolute(trimmed) ? path.normalize(trimmed) : path.resolve(projectDir, trimmed);
  const [realRoot, realAbs] = await Promise.all([realPathOf(projectDir), realPathOf(abs)]);
  const back = path.relative(realRoot, realAbs);
  if (!back || back.startsWith('..') || path.isAbsolute(back)) return { refused: `${trimmed} is outside the project folder${realAbs !== abs ? ' (a link leads out of it)' : ''}` };
  if (options.writing) {
    const posix = back.split(path.sep).join('/');
    const hit = PROTECTED_FOLDERS.find((folder) => posix === folder || posix.startsWith(`${folder}/`));
    if (hit) return { refused: `${trimmed} is under ${hit}, which agents do not write into` };
  }
  return { abs };
}
