import type { GitPrDraftCommit, GitPrDraftFile } from './models/git';

// A pull request's title, description and labels made from git data alone (`git.pr.draft`): there is no language
// model in Quiver, so this is the plain version an agent can write prose on top of. Pure functions with unit tests.

/** Where the repository's pull request template is looked for, in this order, relative to the repository root. */
export const PR_TEMPLATE_PATHS = [
  '.github/pull_request_template.md',
  '.github/PULL_REQUEST_TEMPLATE.md',
  'docs/pull_request_template.md',
  'docs/PULL_REQUEST_TEMPLATE.md',
  'pull_request_template.md',
  'PULL_REQUEST_TEMPLATE.md',
];
/** A folder of templates; the first file in it (by name) is used when none of `PR_TEMPLATE_PATHS` exists. */
export const PR_TEMPLATE_DIR = '.github/PULL_REQUEST_TEMPLATE';

/** At most this many commits are listed in a draft; the rest are counted. */
export const PR_DRAFT_MAX_COMMITS = 250;
/** At most this many files are listed in a draft's description; the rest are counted. */
export const PR_DRAFT_MAX_FILES = 300;
/** `includePatch` gives the diff up to this many bytes. */
export const PR_DRAFT_MAX_PATCH_BYTES = 200 * 1024;

/** `feat/git-blame` → "Git blame": the last part of the branch name, separators as spaces, first letter capitalised. */
export function titleFromBranch(branch: string): string {
  const last = branch.split('/').filter(Boolean).pop() ?? '';
  const words = last.replace(/[-_.]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!words) return branch.trim();
  return words[0].toUpperCase() + words.slice(1);
}

/** A single commit's subject; otherwise the branch name made readable (or the first commit's subject on a detached HEAD). */
export function draftTitle(branch: string | null, commits: Pick<GitPrDraftCommit, 'subject'>[]): string {
  if (commits.length === 1) return commits[0].subject.trim();
  if (branch) return titleFromBranch(branch);
  return commits[0]?.subject.trim() ?? '';
}

const BRANCH_LABELS: Record<string, string> = {
  feat: 'enhancement',
  feature: 'enhancement',
  fix: 'bug',
  bugfix: 'bug',
  hotfix: 'bug',
  docs: 'documentation',
  doc: 'documentation',
};

/** The label a branch prefix suggests (`feat/…` → enhancement, `fix/…` → bug, `docs/…` → documentation), also under a namespace (`me/fix/…`). */
export function labelsForBranch(branch: string | null): string[] {
  if (!branch) return [];
  const parts = branch.split('/');
  for (const part of parts.slice(0, -1)) {
    const label = BRANCH_LABELS[part.toLowerCase()];
    if (label) return [label];
  }
  return [];
}

/** The suggested labels the repository has, in its own spelling; matched without regard to case. */
export function pickLabels(suggested: string[], available: string[]): string[] {
  const byLower = new Map(available.map((name) => [name.toLowerCase(), name]));
  const picked: string[] = [];
  for (const s of suggested) {
    const name = byLower.get(s.toLowerCase());
    if (name && !picked.includes(name)) picked.push(name);
  }
  return picked;
}

export interface PrFileGroup {
  /** The top folder with a trailing slash (`packages/`), or '' for files at the top level. */
  folder: string;
  files: GitPrDraftFile[];
  additions: number;
  deletions: number;
}

/** Files grouped by their top folder, folders by name and the top-level files last; files keep their order. */
export function groupFilesByFolder(files: GitPrDraftFile[]): PrFileGroup[] {
  const groups = new Map<string, PrFileGroup>();
  for (const file of files) {
    const slash = file.path.indexOf('/');
    const folder = slash > 0 ? file.path.slice(0, slash + 1) : '';
    const group = groups.get(folder) ?? { folder, files: [], additions: 0, deletions: 0 };
    group.files.push(file);
    group.additions += file.additions;
    group.deletions += file.deletions;
    groups.set(folder, group);
  }
  return [...groups.values()].sort((a, b) => (a.folder === '' ? 1 : b.folder === '' ? -1 : a.folder.localeCompare(b.folder)));
}

/** Trailers git and tools add to a message, which say nothing about the change. */
const TRAILER = /^(co-authored-by|signed-off-by|reviewed-by|acked-by|tested-by|change-id):/i;

/** The commits as a Markdown list: each subject, its body indented under it (without trailers). */
export function commitsMarkdown(commits: GitPrDraftCommit[], total = commits.length): string {
  const lines: string[] = [];
  for (const c of commits) {
    lines.push(`- ${c.subject.trim()}`);
    const body = c.body
      .split(/\r?\n/)
      .filter((l) => !TRAILER.test(l.trim()))
      .join('\n')
      .trim();
    if (body) for (const l of body.split('\n')) lines.push(l.trim() ? `  ${l.trimEnd()}` : '');
  }
  if (total > commits.length) lines.push(`- … and ${total - commits.length} more commit${total - commits.length === 1 ? '' : 's'}`);
  return lines.join('\n');
}

function counts(f: { additions: number; deletions: number }): string {
  return `+${f.additions} −${f.deletions}`;
}

function fileLine(f: GitPrDraftFile): string {
  const note = f.status === 'added' ? ' (new)' : f.status === 'deleted' ? ' (deleted)' : f.status === 'renamed' && f.origPath ? ` (renamed from \`${f.origPath}\`)` : f.status === 'copied' && f.origPath ? ` (copied from \`${f.origPath}\`)` : '';
  return `- \`${f.path}\`${note} ${f.binary ? 'binary' : counts(f)}`;
}

/** The files as Markdown, grouped by top folder with each group's +/−, at most `max` files listed. */
export function filesMarkdown(files: GitPrDraftFile[], max = PR_DRAFT_MAX_FILES): string {
  const shown = files.slice(0, max);
  const blocks = groupFilesByFolder(shown).map((g) => {
    const n = g.files.length;
    const head = `**${g.folder || 'Top level'}** (${n} file${n === 1 ? '' : 's'}, ${counts(g)})`;
    return [head, ...g.files.map(fileLine)].join('\n');
  });
  if (files.length > shown.length) blocks.push(`… and ${files.length - shown.length} more files`);
  return blocks.join('\n\n');
}

type SectionKind = 'summary' | 'files';

const SUMMARY_HEADINGS = new Set([
  'what changed',
  "what's changed",
  'whats changed',
  'what changes',
  'changes',
  'changes made',
  'summary',
  'description',
  'overview',
  'what',
  'what does this pr do',
  'what does this pull request do',
  'what this pr does',
]);
const FILES_HEADINGS = new Set(['files', 'files changed', 'changed files']);

/** What a template heading asks for, from its text without case, emoji or punctuation. */
export function sectionKind(heading: string): SectionKind | null {
  const name = heading
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (SUMMARY_HEADINGS.has(name)) return 'summary';
  if (FILES_HEADINGS.has(name)) return 'files';
  return null;
}

const HEADING = /^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** The line numbers of the template's ATX headings, outside code fences and HTML comments. */
function headingLines(lines: string[]): { index: number; text: string }[] {
  const found: { index: number; text: string }[] = [];
  let fence: string | null = null;
  let comment = false;
  lines.forEach((line, index) => {
    const f = FENCE.exec(line);
    if (f && !comment) {
      const marker = f[1];
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      return;
    }
    if (fence) return;
    if (comment) {
      if (line.includes('-->')) comment = line.lastIndexOf('<!--') > line.lastIndexOf('-->');
      return;
    }
    const h = HEADING.exec(line);
    if (h) found.push({ index, text: h[1] });
    else if (line.lastIndexOf('<!--') > line.lastIndexOf('-->')) comment = true;
  });
  return found;
}

/**
 * The template with the sections it names filled: under the first heading for what changed (what changed, summary,
 * changes, description) the commits, under the first one for files the files grouped by folder. What the template has
 * under such a heading (a hint in a comment, a line of text) stays, with the list after it. Every other section, and
 * the line endings, are kept as they are. A section with nothing to put in it is left alone.
 */
export function fillTemplate(template: string, parts: { commits: string; files: string }): string {
  const eol = template.includes('\r\n') ? '\r\n' : '\n';
  const lines = template.split(/\r?\n/);
  const headings = headingLines(lines);
  const used = new Set<SectionKind>();
  const fills = new Map<number, string>();
  for (const h of headings) {
    const kind = sectionKind(h.text);
    if (!kind || used.has(kind)) continue;
    const text = kind === 'summary' ? parts.commits : parts.files;
    if (!text.trim()) continue;
    used.add(kind);
    fills.set(h.index, text);
  }
  if (!fills.size) return template;
  // Everything before the first heading, then each heading with its section.
  const out = lines.slice(0, headings[0].index);
  headings.forEach((h, i) => {
    const section = lines.slice(h.index + 1, headings[i + 1]?.index ?? lines.length);
    const fill = fills.get(h.index);
    if (fill === undefined) {
      out.push(lines[h.index], ...section);
      return;
    }
    // The section's own text without the blank lines around it, then the list, then the blank lines it ended with
    // (at least one before another heading).
    let a = 0;
    let b = section.length;
    while (b > 0 && !section[b - 1].trim()) b--;
    while (a < b && !section[a].trim()) a++;
    const own = section.slice(a, b);
    const trailing = i < headings.length - 1 ? Math.max(1, section.length - b) : section.length - b;
    out.push(lines[h.index], '', ...(own.length ? [...own, ''] : []), ...fill.split('\n'), ...Array<string>(trailing).fill(''));
  });
  return out.join(eol);
}

/** The description without a template: Summary with the commits, Changes with the files grouped by folder. */
export function defaultDraftBody(parts: { commits: string; files: string }): string {
  const sections: string[] = [];
  if (parts.commits.trim()) sections.push(`## Summary\n\n${parts.commits}`);
  if (parts.files.trim()) sections.push(`## Changes\n\n${parts.files}`);
  return sections.length ? `${sections.join('\n\n')}\n` : '';
}

/** The description of a draft: the template filled, or the default body when the repository has none. */
export function draftBody(template: string | null, commits: GitPrDraftCommit[], files: GitPrDraftFile[], totalCommits = commits.length): string {
  const parts = { commits: commitsMarkdown(commits, totalCommits), files: filesMarkdown(files) };
  return template === null ? defaultDraftBody(parts) : fillTemplate(template, parts);
}

/** Text cut to at most `maxBytes` of UTF-8 at the end of a line, and whether it was cut. */
export function capText(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return { text, truncated: false };
  const head = new TextDecoder().decode(bytes.subarray(0, maxBytes));
  const cut = head.lastIndexOf('\n');
  // A character split by the byte limit decodes as U+FFFD at the end; cutting at a line end drops it.
  return { text: cut >= 0 ? head.slice(0, cut + 1) : head.replace(/�+$/, ''), truncated: true };
}
