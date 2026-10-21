import { describe, expect, it } from 'vitest';
import { attachPatches, detectOperation, parseBranches, parseDecorations, parseDiffSummary, parseLog, parseStatusV2, splitPatch } from './git-parse';

// The fixtures are what git 2.43 printed for a small repository, with the hashes shortened.

describe('parseStatusV2', () => {
  it('reads the branch headers and every kind of entry, keeping spaces in paths', () => {
    const out = [
      '# branch.oid 9ea6ea2',
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +2 -1',
      '1 MM N... 100644 100644 100644 422c2b7 0f7bc76 a b.txt',
      '1 .M N... 100644 100644 100644 bdc955b bdc955b bin.dat',
      '2 R. N... 100644 100644 100644 587be6b 587be6b R100 new name.txt',
      'old.txt',
      'u UU N... 100644 100644 100644 100644 h1 h2 h3 conflict.txt',
      '? untracked file.txt',
      '! ignored.log',
      '',
    ].join('\0');
    expect(parseStatusV2(out)).toEqual({
      branch: 'main',
      head: '9ea6ea2',
      upstream: 'origin/main',
      ahead: 2,
      behind: 1,
      files: [
        { path: 'a b.txt', index: 'M', worktree: 'M' },
        { path: 'bin.dat', index: '.', worktree: 'M' },
        { path: 'new name.txt', origPath: 'old.txt', index: 'R', worktree: '.' },
        { path: 'conflict.txt', index: 'U', worktree: 'U' },
        { path: 'untracked file.txt', index: '?', worktree: '?' },
      ],
    });
  });

  it('gives null for a detached HEAD and for a branch with no commits yet', () => {
    expect(parseStatusV2('# branch.oid 9ea6ea2\0# branch.head (detached)\0')).toMatchObject({ branch: null, head: '9ea6ea2', ahead: 0, behind: 0, files: [] });
    expect(parseStatusV2('# branch.oid (initial)\0# branch.head main\0')).toMatchObject({ branch: 'main', head: null });
  });
});

describe('parseLog', () => {
  it('reads each record, with parents, a multi-line body and decorations', () => {
    const rec = (fields: string[]) => '\x1e' + fields.join('\0') + '\n';
    const out =
      rec(['bbbb', 'bb', 'aaaa cccc', 'Ann', 'ann@x.io', '2026-10-20T10:00:00+03:00', 'Merge it', 'line one\n\nline two\n', 'HEAD -> main, origin/main, tag: v1']) +
      rec(['aaaa', 'aa', '', 'Bob', 'bob@x.io', '2026-10-19T10:00:00Z', 'first', '', '']);
    expect(parseLog(out)).toEqual([
      { hash: 'bbbb', shortHash: 'bb', parents: ['aaaa', 'cccc'], author: 'Ann', email: 'ann@x.io', date: '2026-10-20T10:00:00+03:00', subject: 'Merge it', body: 'line one\n\nline two', refs: ['main', 'origin/main', 'v1'] },
      { hash: 'aaaa', shortHash: 'aa', parents: [], author: 'Bob', email: 'bob@x.io', date: '2026-10-19T10:00:00Z', subject: 'first', body: '', refs: [] },
    ]);
    expect(parseLog('')).toEqual([]);
  });

  it('leaves a bare detached HEAD out of the refs', () => {
    expect(parseDecorations('HEAD, feat/x')).toEqual(['feat/x']);
  });
});

describe('parseBranches', () => {
  it('reads local and remote branches with tracking counts and skips origin/HEAD', () => {
    const line = (f: string[]) => f.join('\0');
    const out = [
      line(['refs/heads/main', 'main', '*', 'origin/main', '[ahead 1, behind 2]', 'h1', 'first', '2026-10-20T20:50:50+03:00']),
      line(['refs/heads/feat/x', 'feat/x', ' ', 'origin/feat/x', '[gone]', 'h2', 'wip', '2026-10-20T20:51:00+03:00']),
      line(['refs/remotes/origin/HEAD', 'origin', ' ', '', '', 'h1', 'first', '2026-10-20T20:50:50+03:00']),
      line(['refs/remotes/origin/main', 'origin/main', ' ', '', '', 'h3', 'older', '2026-10-19T20:50:50+03:00']),
      '',
    ].join('\n');
    expect(parseBranches(out)).toEqual([
      { name: 'main', current: true, remote: false, upstream: 'origin/main', ahead: 1, behind: 2, head: 'h1', subject: 'first', date: '2026-10-20T20:50:50+03:00' },
      { name: 'feat/x', current: false, remote: false, upstream: 'origin/feat/x', ahead: 0, behind: 0, head: 'h2', subject: 'wip', date: '2026-10-20T20:51:00+03:00' },
      { name: 'origin/main', current: false, remote: true, ahead: 0, behind: 0, head: 'h3', subject: 'older', date: '2026-10-19T20:50:50+03:00' },
    ]);
  });
});

describe('parseDiffSummary', () => {
  it('pairs the raw records with the numstat counts, including a rename and a binary file', () => {
    const out = [
      ':100644 100644 422c2b7 0f7bc76 M',
      'a b.txt',
      ':100644 100644 587be6b 587be6b R100',
      'old.txt',
      'new.txt',
      ':100644 100644 bdc955b 0000000 M',
      'bin.dat',
      ':000000 100644 0000000 e69de29 A',
      'added.txt',
      '1\t1\ta b.txt',
      '0\t0\t',
      'old.txt',
      'new.txt',
      '-\t-\tbin.dat',
      '3\t0\tadded.txt',
      '',
    ].join('\0');
    expect(parseDiffSummary(out)).toEqual([
      { path: 'a b.txt', status: 'modified', additions: 1, deletions: 1, binary: false },
      { path: 'new.txt', origPath: 'old.txt', status: 'renamed', additions: 0, deletions: 0, binary: false },
      { path: 'bin.dat', status: 'modified', additions: 0, deletions: 0, binary: true },
      { path: 'added.txt', status: 'added', additions: 3, deletions: 0, binary: false },
    ]);
    expect(parseDiffSummary('')).toEqual([]);
  });

  it('reads deletions and type changes', () => {
    const out = [':100644 000000 aaa 000 D', 'gone.txt', ':100644 120000 aaa bbb T', 'link', '0\t2\tgone.txt', '1\t1\tlink', ''].join('\0');
    expect(parseDiffSummary(out).map((f) => [f.path, f.status, f.deletions])).toEqual([
      ['gone.txt', 'deleted', 2],
      ['link', 'type-changed', 1],
    ]);
  });
});

describe('patches', () => {
  const patch = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/bin b/bin\nBinary files a/bin and b/bin differ\ndiff --git a/y b/y\n@@ -1 +1 @@\n-diff --git not a header\n+c\n';
  const files = [
    { path: 'x', status: 'modified' as const, additions: 1, deletions: 1, binary: false },
    { path: 'bin', status: 'modified' as const, additions: 0, deletions: 0, binary: true },
    { path: 'y', status: 'modified' as const, additions: 1, deletions: 1, binary: false },
  ];

  it('splits a patch per file at the diff --git lines only', () => {
    const chunks = splitPatch(patch);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toBe('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n');
    expect(chunks[2]).toContain('-diff --git not a header');
    expect(splitPatch('')).toEqual([]);
  });

  it('splits a conflicted file\'s combined diff as a chunk of its own', () => {
    const merged = 'diff --cc f.txt\nindex 28ce6a8,2c7dc80..0000000\n--- a/f.txt\n+++ b/f.txt\n@@@ -1,1 -1,1 +1,5 @@@\n++<<<<<<< HEAD\n +m\n++=======\n+ x\n++>>>>>>> x\ndiff --git a/g.txt b/g.txt\n--- a/g.txt\n+++ b/g.txt\n@@ -1 +1 @@\n-g\n+g2\n';
    const chunks = splitPatch(merged);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].startsWith('diff --cc f.txt\n')).toBe(true);
    expect(chunks[1].startsWith('diff --git a/g.txt')).toBe(true);
  });

  it('attaches each patch to its file, leaving binaries and oversized patches out', () => {
    const chunks = splitPatch(patch);
    const out = attachPatches(files, chunks, 1000);
    expect(out[0].patch).toBe(chunks[0]);
    expect(out[1].patch).toBeUndefined();
    expect(out[2].patch).toBe(chunks[2]);
    expect(attachPatches(files, chunks, 10).map((f) => f.truncated)).toEqual([true, undefined, true]);
  });

  it('marks files truncated rather than pairing them wrongly', () => {
    const chunks = splitPatch(patch);
    expect(attachPatches(files, chunks.slice(0, 2), 1000).every((f) => !f.patch)).toBe(true);
    const cut = attachPatches(files, chunks.slice(0, 2), 1000, true);
    expect([cut[0].patch, cut[0].truncated, cut[2].truncated]).toEqual([chunks[0], undefined, true]);
  });
});

describe('detectOperation', () => {
  it('names the operation from git marker files, a rebase first', () => {
    expect(detectOperation(() => false)).toBeUndefined();
    expect(detectOperation((n) => n === 'MERGE_HEAD')).toBe('merge');
    expect(detectOperation((n) => n === 'rebase-merge' || n === 'MERGE_HEAD')).toBe('rebase');
    expect(detectOperation((n) => n === 'CHERRY_PICK_HEAD')).toBe('cherry-pick');
    expect(detectOperation((n) => n === 'REVERT_HEAD')).toBe('revert');
  });
});
