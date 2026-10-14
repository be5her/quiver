import type { EnvFileContent, EnvFileSummary } from '@quiver/core';
import type { IconNode } from '@quiver/ui';
import { File, FileKey, FileLock2, FileSliders, FileText } from 'lucide';

export const KIND_ICON: Record<EnvFileSummary['kind'], IconNode> = {
  main: FileKey,
  example: FileText,
  local: FileLock2,
  profile: FileSliders,
  other: File,
};

export const WARNING_TITLE: Record<NonNullable<EnvFileSummary['warning']>, string> = {
  tracked: 'Committed to git with its values',
  unignored: 'Not covered by .gitignore: the next `git add .` commits it',
};

/** The raw text with secret values replaced, computed from the parsed entries so the view matches what the Keys table hides. */
export function maskedText(content: EnvFileContent): string {
  const lines = content.text.split(/\r?\n/);
  for (const e of content.entries) {
    if (!e.secret || !e.value) continue;
    const index = e.line - 1;
    if (index < 0 || index >= lines.length) continue;
    const eq = lines[index].indexOf('=');
    if (eq < 0) continue;
    const tail = lines[index].slice(eq + 1);
    const comment = e.comment ? ` # ${e.comment}` : '';
    lines[index] = `${lines[index].slice(0, eq + 1)}${tail.trimStart().startsWith('"') || tail.trimStart().startsWith("'") ? '"••••••••"' : '••••••••'}${comment}`;
    // A quoted value spanning several lines collapses to one masked line.
    const span = e.value.split('\n').length - 1;
    if (span > 0 && e.quote) lines.splice(index + 1, span);
  }
  return lines.join(content.eol);
}

/** The most useful file to compare with: an example in the same folder, else `.env`, else any sibling. */
export function defaultAgainst(content: EnvFileContent, files: EnvFileSummary[]): string {
  const sameDir = files.filter((f) => f.dir === content.dir);
  if (content.kind !== 'example') {
    const example = sameDir.find((f) => f.kind === 'example');
    if (example) return example.path;
  }
  const main = sameDir.find((f) => f.kind === 'main');
  if (main) return main.path;
  return sameDir[0]?.path ?? files[0]?.path ?? '';
}
