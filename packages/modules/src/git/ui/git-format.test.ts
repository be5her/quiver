import { describe, expect, it } from 'vitest';
import { checksSummary, groupChanges, parsePatch, splitPath, splitRows } from './git-format';

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
