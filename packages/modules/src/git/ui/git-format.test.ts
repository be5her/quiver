import { describe, expect, it } from 'vitest';
import { applyPatch, checksSummary, cleanupCandidates, groupChanges, isPushRejected, languageForPath, parsePatch, refMatches, remotesOf, splitPath, splitRemoteBranch, splitRows } from './git-format';
import type { GitBranch } from '@quiver/core';
import { blameBefore, blameKey, blameMarkers, blameTitle } from './git-format';
import type { GitBlameCommit } from '@quiver/core';

const PATCH = [
  'diff --git a/a.txt b/a.txt',
  'index 1..2 100644',
  '--- a/a.txt',
  '+++ b/a.txt',
  '@@ -1,4 +1,4 @@ section',
  ' one',
  '-two',
  '-three',
  '+TWO',
  ' four',
  '@@ -10,2 +10,3 @@',
  ' ten',
  '+added',
  ' eleven',
  '\\ No newline at end of file',
  '',
].join('\n');

describe('parsePatch', () => {
  it('numbers the lines of each hunk and leaves the headers out', () => {
    const rows = parsePatch(PATCH);
    expect(rows[0]).toEqual({ kind: 'hunk', text: '@@ -1,4 +1,4 @@ section' });
    expect(rows.slice(1, 6)).toEqual([
      { kind: 'context', old: 1, new: 1, text: 'one' },
      { kind: 'del', old: 2, text: 'two' },
      { kind: 'del', old: 3, text: 'three' },
      { kind: 'add', new: 2, text: 'TWO' },
      { kind: 'context', old: 4, new: 3, text: 'four' },
    ]);
    expect(rows.slice(7)).toEqual([
      { kind: 'context', old: 10, new: 10, text: 'ten' },
      { kind: 'add', new: 11, text: 'added' },
      { kind: 'context', old: 11, new: 12, text: 'eleven' },
      { kind: 'note', text: '\\ No newline at end of file' },
    ]);
  });

  it('reads CRLF patches and stops at the next file header', () => {
    const rows = parsePatch('@@ -1 +1 @@\r\n-a\r\n+b\r\ndiff --git a/x b/x\r\n');
    expect(rows).toEqual([
      { kind: 'hunk', text: '@@ -1 +1 @@' },
      { kind: 'del', old: 1, text: 'a' },
      { kind: 'add', new: 1, text: 'b' },
    ]);
  });
});

describe('splitRows', () => {
  it('pairs deleted lines with the added lines after them, padding the shorter side', () => {
    const split = splitRows(parsePatch(PATCH));
    const pairs = split.filter((r) => r.kind === 'pair');
    expect(pairs[1]).toEqual({ kind: 'pair', left: { no: 2, text: 'two', kind: 'del' }, right: { no: 2, text: 'TWO', kind: 'add' } });
    expect(pairs[2]).toEqual({ kind: 'pair', left: { no: 3, text: 'three', kind: 'del' }, right: { text: '', kind: 'empty' } });
    expect(pairs[5]).toEqual({ kind: 'pair', left: { text: '', kind: 'empty' }, right: { no: 11, text: 'added', kind: 'add' } });
    expect(split.filter((r) => r.kind === 'hunk')).toHaveLength(2);
  });
});

describe('groupChanges', () => {
  it('puts a file in staged and unstaged when both have edits, and conflicts on their own', () => {
    const g = groupChanges([
      { path: 'b.ts', index: 'M', worktree: 'M' },
      { path: 'a.ts', index: 'A', worktree: '.' },
      { path: 'c.ts', index: '.', worktree: 'D' },
      { path: 'new/', index: '?', worktree: '?' },
      { path: 'x.ts', index: 'U', worktree: 'U' },
      { path: 'y.ts', index: 'A', worktree: 'A' },
    ]);
    expect(g.staged.map((f) => f.path)).toEqual(['a.ts', 'b.ts']);
    expect(g.unstaged.map((f) => f.path)).toEqual(['b.ts', 'c.ts']);
    expect(g.untracked.map((f) => f.path)).toEqual(['new/']);
    expect(g.conflicts.map((f) => f.path)).toEqual(['x.ts', 'y.ts']);
  });
});

describe('helpers', () => {
  it('splits paths into name and folder', () => {
    expect(splitPath('src/app/main.ts')).toEqual({ name: 'main.ts', dir: 'src/app' });
    expect(splitPath('readme.md')).toEqual({ name: 'readme.md', dir: '' });
    expect(splitPath('src/new/')).toEqual({ name: 'new/', dir: 'src' });
  });

  it('sums up checks', () => {
    expect(checksSummary({ state: 'failure', passed: 3, failed: 1, pending: 0 })).toBe('✗ 1/4');
    expect(checksSummary({ state: 'success', passed: 2, failed: 0, pending: 0 })).toBe('✓ 2');
    expect(checksSummary({ state: 'pending', passed: 1, failed: 0, pending: 1 })).toBe('● 1/2');
    expect(checksSummary({ state: 'none', passed: 0, failed: 0, pending: 0 })).toBe('');
  });
});

describe('isPushRejected', () => {
  it('offers a force push only when the remote branch moved on', () => {
    expect(isPushRejected(' ! [rejected]        main -> main (non-fast-forward)\nerror: failed to push some refs')).toBe(true);
    expect(isPushRejected(' ! [rejected]        main -> main (fetch first)')).toBe(true);
    expect(isPushRejected("Authentication failed for 'https://github.com/o/r.git/'")).toBe(false);
    expect(isPushRejected("Could not resolve host: github.com")).toBe(false);
    expect(isPushRejected(' ! [remote rejected] main -> main (pre-receive hook declined)')).toBe(false);
  });
});

describe('applyPatch', () => {
  const old = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', ''].join('\n');

  it('gives the new side of a file from its old side and its patch', () => {
    expect(applyPatch(old, PATCH)).toBe(['one', 'TWO', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'added', 'eleven'].join('\n'));
  });

  it('builds an added file from nothing and a deleted one down to nothing', () => {
    expect(applyPatch('', 'diff --git a/n b/n\nnew file mode 100644\n--- /dev/null\n+++ b/n\n@@ -0,0 +1,2 @@\n+a\n+b\n')).toBe('a\nb\n');
    expect(applyPatch('a\nb\n', 'diff --git a/n b/n\ndeleted file mode 100644\n--- a/n\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-a\n-b\n')).toBe('');
  });

  it('inserts after a line for a hunk that removes none, and keeps CRLF line endings', () => {
    expect(applyPatch('a\nb\n', '@@ -1,0 +2 @@\n+inserted\n')).toBe('a\ninserted\nb\n');
    expect(applyPatch('a\r\nb\r\n', '@@ -1,2 +1,2 @@\n a\r\n-b\r\n+c\r\n')).toBe('a\r\nc\r\n');
  });

  it('follows the end-of-file newline markers', () => {
    expect(applyPatch('a\nb', '@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+b\n')).toBe('a\nb\n');
    expect(applyPatch('a\nb\n', '@@ -1,2 +1,2 @@\n a\n-b\n+b\n\\ No newline at end of file\n')).toBe('a\nb');
  });

  it('gives null rather than a wrong file when the patch does not fit, or for a combined diff', () => {
    expect(applyPatch('one\nother\n', PATCH)).toBeNull();
    expect(applyPatch('a\n', '@@ -5,1 +5,1 @@\n-x\n+y\n')).toBeNull();
    expect(applyPatch('a\n', 'diff --cc a\n@@@ -1,1 -1,1 +1,1 @@@\n')).toBeNull();
  });
});

describe('branches', () => {
  const branch = (name: string, over: Partial<GitBranch> = {}): GitBranch => ({ name, current: false, remote: false, ahead: 0, behind: 0, head: 'h', subject: '', date: '', merged: false, gone: false, ...over });

  it('filters by name or subject, and offers merged or gone local branches for clean-up', () => {
    expect(refMatches(branch('feat/Parser', { subject: 'wip' }), 'parser')).toBe(true);
    expect(refMatches(branch('x', { subject: 'Fix the Parser' }), ' parser ')).toBe(true);
    expect(refMatches(branch('x'), 'y')).toBe(false);
    const list = [branch('main', { current: true, merged: true }), branch('done', { merged: true }), branch('pruned', { gone: true }), branch('open'), branch('origin/done', { remote: true, merged: true })];
    expect(cleanupCandidates(list).map((b) => b.name)).toEqual(['done', 'pruned']);
  });

  it('splits a remote branch into its remote and name, and lists the remotes', () => {
    expect(splitRemoteBranch('origin/feat/x')).toEqual({ remote: 'origin', branch: 'feat/x' });
    expect(remotesOf([branch('upstream/main', { remote: true }), branch('origin/a', { remote: true }), branch('origin/b', { remote: true }), branch('local')])).toEqual(['origin', 'upstream']);
  });

  it('picks the editor language from the extension', () => {
    expect(languageForPath('src/app/main.ts')).toBe('javascript');
    expect(languageForPath('package.json')).toBe('json');
    expect(languageForPath('Makefile')).toBe('text');
    expect(languageForPath('.gitignore')).toBe('text');
  });
});

describe('blame', () => {
  const old = 'a'.repeat(40);
  const recent = 'b'.repeat(40);
  const commit = (hash: string, authorTime: string, over: Partial<GitBlameCommit> = {}): GitBlameCommit => ({ hash, author: 'Ann', authorEmail: 'ann@x.test', authorTime, summary: `Commit ${hash[0]}`, path: 'f.ts', boundary: false, ...over });
  const blame = {
    lines: [
      { line: 1, commit: old, originalLine: 1, text: 'a' },
      { line: 2, commit: old, originalLine: 2, text: 'b' },
      { line: 3, commit: recent, originalLine: 1, text: 'c' },
      { line: 4, commit: null, originalLine: 4, text: 'd' },
      { line: 5, commit: old, originalLine: 3, text: 'e' },
    ],
    commits: { [old]: commit(old, '2026-01-01T00:00:00.000Z', { boundary: true }), [recent]: commit(recent, '2026-10-01T00:00:00.000Z', { previous: { commit: old, path: 'old name.ts' } }) },
  };

  it('labels each run of lines once, coloured from faint (oldest) to strong (newest)', () => {
    const markers = blameMarkers(blame, Date.parse('2026-10-22T00:00:00Z'), (iso) => `on ${iso}`);
    expect(markers.map((m) => [m.text, m.start, m.id])).toEqual([
      ['aaaaaaa Ann · 9mo ago', true, old],
      ['', false, old],
      ['bbbbbbb Ann · 21d ago', true, recent],
      ['Not committed yet', true, undefined],
      ['aaaaaaa Ann · 9mo ago', true, old],
    ]);
    expect(markers[0].color).toContain('20%');
    expect(markers[2].color).toContain('90%');
    expect(markers[3].color).toBe('var(--warning)');
    expect(markers[2].title).toContain('bbbbbbb Commit b\nAnn <ann@x.test>\non 2026-10-01T00:00:00.000Z');
    expect(markers[0].title).toContain('The history stops here');
  });

  it('blames before a commit at its previous commit and path, and names tabs by file and ref', () => {
    expect(blameBefore(blame.commits[recent])).toEqual({ path: 'old name.ts', ref: old });
    expect(blameBefore(blame.commits[old])).toBeNull();
    expect(blameTitle({ path: 'src/f.ts' })).toBe('f.ts (blame)');
    expect(blameTitle({ path: 'src/f.ts', ref: old })).toBe('f.ts (blame @ aaaaaaa)');
    expect(blameKey({ path: 'src/f.ts', ref: 'main' })).toBe('src/f.ts@main');
  });
});
