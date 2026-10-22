import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  GIT_LOG_FORMAT,
  PR_DRAFT_MAX_COMMITS,
  PR_DRAFT_MAX_PATCH_BYTES,
  PR_TEMPLATE_DIR,
  PR_TEMPLATE_PATHS,
  QuiverError,
  capText,
  draftBody,
  draftTitle,
  labelsForBranch,
  parseGhJson,
  parseLog,
  pickLabels,
  type GitPrDraft,
  type GitPrDraftCommit,
  type GitPrDraftFile,
} from '@quiver/core';
import * as local from './local';
import * as pr from './pr';

// A pull request's title, description and labels made from git alone (`git.pr.draft`): the commits and files of the
// current branch against its base, filled into the repository's pull request template. It reads only, works before
// the branch is pushed and without gh; gh is asked only for the repository's labels, and a gh that fails leaves the
// labels empty rather than failing the draft.

/** A template over this is not read. */
const MAX_TEMPLATE_BYTES = 64 * 1024;
/** gh is only asked for labels; a slow one should not hold the draft up for the usual 30 seconds. */
const LABELS_TIMEOUT_MS = 15_000;

/** A regular file's text when it is not over the cap; null otherwise (missing, a folder, a link, too large). */
async function readSmallFile(file: string): Promise<string | null> {
  const stat = await fs.lstat(file).catch(() => null);
  if (!stat?.isFile() || stat.size > MAX_TEMPLATE_BYTES) return null;
  return (await fs.readFile(file, 'utf8').catch(() => null))?.replace(/^﻿/, '') ?? null;
}

/** The repository's pull request template, from the places GitHub reads it, in `PR_TEMPLATE_PATHS` order, then the first file of `PR_TEMPLATE_DIR`. */
export async function findTemplate(root: string): Promise<{ path: string; text: string } | null> {
  for (const rel of PR_TEMPLATE_PATHS) {
    const text = await readSmallFile(path.join(root, rel));
    if (text !== null) return { path: rel, text };
  }
  const names = await fs.readdir(path.join(root, PR_TEMPLATE_DIR)).catch(() => [] as string[]);
  for (const name of names.filter((n) => /\.(md|markdown|txt)$/i.test(n)).sort()) {
    const rel = `${PR_TEMPLATE_DIR}/${name}`;
    const text = await readSmallFile(path.join(root, rel));
    if (text !== null) return { path: rel, text };
  }
  return null;
}

/** The configured remotes in the order gh picks a base repository: the one `gh repo set-default` marked, upstream, github, origin, then the rest. */
async function orderedRemotes(root: string): Promise<string[]> {
  const names = (await local.git(root, ['remote'])).stdout.split(/\r?\n/).filter(Boolean);
  const marked = (await local.git(root, ['config', '--get-regexp', '^remote\\..+\\.gh-resolved$'], { allowFailure: true })).stdout
    .split(/\r?\n/)
    .map((l) => /^remote\.(.+)\.gh-resolved base$/.exec(l)?.[1])
    .filter((n): n is string => Boolean(n));
  const rank = (n: string) => (marked.includes(n) ? 0 : ['upstream', 'github', 'origin'].indexOf(n) + 1 || 4);
  return [...names].sort((a, b) => rank(a) - rank(b));
}

/** The commit a ref names, or null when it names none here. */
async function commitOf(root: string, ref: string): Promise<string | null> {
  const result = await local.git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { allowFailure: true });
  return result.code === 0 ? result.stdout.trim() : null;
}

interface DraftBase {
  base: string;
  baseRef: string;
  commit: string;
}

/**
 * The base: the ref given, validated as one that names a commit, as a pull request names it (a remote-tracking
 * branch without its remote); else the default branch of the remote gh would pick (its `HEAD`, else its main or
 * master), else a local main or master.
 */
async function resolveBase(root: string, given: string | undefined): Promise<DraftBase> {
  const remotes = await orderedRemotes(root);
  if (given !== undefined) {
    const commit = await commitOf(root, given);
    if (!commit) throw new QuiverError('INVALID_INPUT', `${given} is not a branch, tag or commit in this repository`, { reason: 'bad-base' });
    const full = (await local.git(root, ['rev-parse', '--symbolic-full-name', given], { allowFailure: true })).stdout.split(/\r?\n/)[0]?.trim() ?? '';
    let base = given;
    if (full.startsWith('refs/heads/')) base = full.slice('refs/heads/'.length);
    else {
      const remote = remotes.find((r) => full.startsWith(`refs/remotes/${r}/`));
      if (remote) base = full.slice(`refs/remotes/${remote}/`.length);
    }
    return { base, baseRef: given, commit };
  }
  for (const remote of remotes) {
    const head = await local.git(root, ['symbolic-ref', '--quiet', `refs/remotes/${remote}/HEAD`], { allowFailure: true });
    const ref = head.code === 0 ? head.stdout.trim() : '';
    const commit = ref.startsWith(`refs/remotes/${remote}/`) ? await commitOf(root, ref) : null;
    if (commit) {
      const name = ref.slice(`refs/remotes/${remote}/`.length);
      return { base: name, baseRef: `${remote}/${name}`, commit };
    }
  }
  for (const remote of remotes) {
    for (const name of ['main', 'master']) {
      const commit = await commitOf(root, `refs/remotes/${remote}/${name}`);
      if (commit) return { base: name, baseRef: `${remote}/${name}`, commit };
    }
  }
  for (const name of ['main', 'master']) {
    const commit = await commitOf(root, `refs/heads/${name}`);
    if (commit) return { base: name, baseRef: name, commit };
  }
  throw new QuiverError('INVALID_INPUT', 'No default branch was found (no remote HEAD, main or master); give the base to compare with', { reason: 'no-base' });
}

/** The labels the repository has, from gh; empty when gh is missing, signed out, not on GitHub or failing. */
async function repoLabels(root: string): Promise<string[]> {
  try {
    const repo = await pr.prRepo(root);
    const { stdout } = await pr.gh(repo.root, ['label', 'list', '--repo', repo.arg, '--limit', '1000', '--json', 'name'], { timeoutMs: LABELS_TIMEOUT_MS });
    const list = parseGhJson(stdout);
    return Array.isArray(list) ? list.map((l) => (l as { name?: unknown })?.name).filter((n): n is string => typeof n === 'string') : [];
  } catch {
    return [];
  }
}

export async function draft(cwd: string, input: { base?: string; includePatch: boolean }): Promise<GitPrDraft> {
  const root = await local.repoRoot(cwd);
  const headCommit = await commitOf(root, 'HEAD');
  if (!headCommit) throw new QuiverError('INVALID_INPUT', 'This branch has no commits yet', { reason: 'no-commits' });
  const branchResult = await local.git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFailure: true });
  const branch = branchResult.code === 0 ? branchResult.stdout.trim() : null;
  const head = branch ?? headCommit.slice(0, 7);

  const base = await resolveBase(root, input.base);
  const mergeBaseResult = await local.git(root, ['merge-base', base.commit, headCommit], { allowFailure: true });
  const mergeBase = mergeBaseResult.code === 0 ? mergeBaseResult.stdout.trim() : '';
  if (!mergeBase) throw new QuiverError('INVALID_INPUT', `${head} and ${base.baseRef} have no commit in common`, { reason: 'unrelated' });

  // Merges (of the base into the branch, mostly) say nothing a reviewer needs; they are neither listed nor counted.
  const range = `${mergeBase}..${headCommit}`;
  const total = Number((await local.git(root, ['rev-list', '--count', '--no-merges', range])).stdout.trim() || 0);
  const logged = parseLog((await local.git(root, ['log', '--no-merges', `--format=${GIT_LOG_FORMAT}`, `--max-count=${PR_DRAFT_MAX_COMMITS}`, range, '--'])).stdout);
  const commits: GitPrDraftCommit[] = logged.reverse().map((c) => ({ hash: c.hash, subject: c.subject, body: c.body }));
  const files: GitPrDraftFile[] = (await local.diffFiles(root, [mergeBase, headCommit], undefined, true)).map((f) => ({
    path: f.path,
    ...(f.origPath ? { origPath: f.origPath } : {}),
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    binary: f.binary,
  }));

  const template = await findTemplate(root);
  const suggested = labelsForBranch(branch);
  const labels = suggested.length ? pickLabels(suggested, await repoLabels(root)) : [];

  let patch: GitPrDraft['patch'];
  if (input.includePatch) {
    const result = await local.git(root, ['diff', '--no-ext-diff', '--no-textconv', '-M', mergeBase, headCommit, '--']);
    const capped = capText(result.stdout, PR_DRAFT_MAX_PATCH_BYTES);
    patch = { text: capped.text, truncated: capped.truncated || result.truncated };
  }

  return {
    head,
    base: base.base,
    baseRef: base.baseRef,
    mergeBase,
    title: draftTitle(branch, commits),
    body: draftBody(template?.text ?? null, commits, files, total),
    commits,
    files,
    stats: { commits: total, files: files.length, additions: files.reduce((n, f) => n + f.additions, 0), deletions: files.reduce((n, f) => n + f.deletions, 0) },
    template: template?.text ?? null,
    ...(template ? { templatePath: template.path } : {}),
    labels,
    ...(patch ? { patch } : {}),
  };
}
