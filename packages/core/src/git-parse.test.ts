import { describe, expect, it } from 'vitest';
import {
  attachPatches,
  conflictKind,
  conflictLabels,
  conflictMarkerLines,
  conflictRegions,
  conflictedPaths,
  defaultWorktreePath,
  detectOperation,
  dropAddedFinalNewline,
  isSameOrInside,
  mergeMessageName,
  operationArgs,
  parseBlamePorcelain,
  parseBranches,
  parseConflictMarkers,
  parseDecorations,
  parseDiffSummary,
  parseLog,
  parseMarkerSize,
  parseStashes,
  parseStatusV2,
  parseTags,
  parseUnmergedEntries,
  parseWorktreeList,
  planDiscard,
  renderResolution,
  resolveConflict,
  sameWorktreePath,
  splitPatch,
  unquoteGitPath,
  worktreeFolderName,
  worktreeRefusal,
} from './git-parse';

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
      { name: 'main', current: true, remote: false, upstream: 'origin/main', ahead: 1, behind: 2, head: 'h1', subject: 'first', date: '2026-10-20T20:50:50+03:00', merged: false, gone: false },
      { name: 'feat/x', current: false, remote: false, upstream: 'origin/feat/x', ahead: 0, behind: 0, head: 'h2', subject: 'wip', date: '2026-10-20T20:51:00+03:00', merged: false, gone: true },
      { name: 'origin/main', current: false, remote: true, ahead: 0, behind: 0, head: 'h3', subject: 'older', date: '2026-10-19T20:50:50+03:00', merged: false, gone: false },
    ]);
  });

  it('marks merged branches, never the default branch, its remote copies or the current one', () => {
    const line = (f: string[]) => f.join('\0');
    const out = [
      line(['refs/heads/feat/a', 'feat/a', '*', '', '', 'h1', 'a', '']),
      line(['refs/heads/main', 'main', ' ', 'origin/main', '', 'h2', 'm', '']),
      line(['refs/heads/done', 'done', ' ', '', '', 'h3', 'd', '']),
      line(['refs/heads/open', 'open', ' ', '', '', 'h4', 'o', '']),
      line(['refs/remotes/origin/main', 'origin/main', ' ', '', '', 'h2', 'm', '']),
      line(['refs/remotes/upstream/main', 'upstream/main', ' ', '', '', 'h2', 'm', '']),
      line(['refs/remotes/origin/done', 'origin/done', ' ', '', '', 'h3', 'd', '']),
    ].join('\n');
    const merged = new Set(['refs/heads/feat/a', 'refs/heads/main', 'refs/heads/done', 'refs/remotes/origin/main', 'refs/remotes/upstream/main', 'refs/remotes/origin/done']);
    expect(parseBranches(out, { merged, defaultBranch: 'main' }).filter((b) => b.merged).map((b) => b.name)).toEqual(['done', 'origin/done']);
    // With no default branch, merged means merged into the current one, which is still left out.
    expect(parseBranches(out, { merged }).filter((b) => b.merged).map((b) => b.name)).toEqual(['main', 'done', 'origin/main', 'upstream/main', 'origin/done']);
  });
});

describe('parseTags', () => {
  it('reads lightweight and annotated tags, an annotated one pointing at its commit', () => {
    const out = ['v1.0.0\0commit\0c1\0\0First commit\x002026-10-20T10:00:00+03:00', 'v1.1.0\0tag\0t2\0c2\0Release 1.1\x002026-10-21T10:00:00+03:00', ''].join('\n');
    expect(parseTags(out)).toEqual([
      { name: 'v1.0.0', commit: 'c1', annotated: false, subject: 'First commit', date: '2026-10-20T10:00:00+03:00' },
      { name: 'v1.1.0', commit: 'c2', annotated: true, subject: 'Release 1.1', date: '2026-10-21T10:00:00+03:00' },
    ]);
    expect(parseTags('')).toEqual([]);
  });
});

describe('parseStashes', () => {
  it('reads the index, the branch and the message, or git\'s WIP line', () => {
    const rec = (fields: string[]) => '\x1e' + fields.join('\0') + '\n';
    const out =
      rec(['stash@{0}', 'aaaa', 'On feat/x: half done: the parser', '2026-10-21T10:00:00+03:00']) +
      rec(['stash@{1}', 'bbbb', 'WIP on main: 9ea6ea2 First commit', '2026-10-20T10:00:00+03:00']) +
      rec(['stash@{2}', 'cccc', 'WIP on (no branch): 9ea6ea2 First commit', '2026-10-19T10:00:00+03:00']);
    expect(parseStashes(out)).toEqual([
      { index: 0, hash: 'aaaa', message: 'half done: the parser', branch: 'feat/x', date: '2026-10-21T10:00:00+03:00' },
      { index: 1, hash: 'bbbb', message: 'WIP 9ea6ea2 First commit', branch: 'main', date: '2026-10-20T10:00:00+03:00' },
      { index: 2, hash: 'cccc', message: 'WIP 9ea6ea2 First commit', date: '2026-10-19T10:00:00+03:00' },
    ]);
    expect(parseStashes('')).toEqual([]);
  });
});

describe('planDiscard', () => {
  const files = [
    { path: 'changed.txt', index: '.', worktree: 'M' },
    { path: 'new.txt', index: '?', worktree: '?' },
    { path: 'newdir/', index: '?', worktree: '?' },
  ];

  it('deletes only what the status lists as untracked, and restores everything else', () => {
    expect(planDiscard(files, ['changed.txt', 'new.txt'])).toEqual({ restore: ['changed.txt'], clean: ['new.txt'], cleanDirs: false });
    expect(planDiscard(files, ['newdir/'])).toEqual({ restore: [], clean: ['newdir/'], cleanDirs: true });
    // A file inside an untracked folder, or one the status does not list, is never handed to git clean.
    expect(planDiscard(files, ['newdir/a.txt', 'src'])).toEqual({ restore: ['newdir/a.txt', 'src'], clean: [], cleanDirs: false });
  });

  it('restores the old path of a staged rename when going back to HEAD', () => {
    const renamed = [...files, { path: 'new name.txt', origPath: 'old.txt', index: 'R', worktree: '.' }];
    expect(planDiscard(renamed, ['new name.txt'], true)).toEqual({ restore: ['new name.txt', 'old.txt'], clean: [], cleanDirs: false });
    expect(planDiscard(renamed, ['new name.txt', 'old.txt'], true).restore).toEqual(['new name.txt', 'old.txt']);
    // Back to the index, the rename stays staged and only the working file is touched.
    expect(planDiscard(renamed, ['new name.txt']).restore).toEqual(['new name.txt']);
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

  it('keeps a cherry-pick or revert of several commits in progress while sequencer/ is there', () => {
    const sequencer = (todo: string) => detectOperation((n) => n === 'sequencer', () => todo);
    expect(sequencer('pick 1a2b3c4 Add a\npick 5d6e7f8 Add b\n')).toBe('cherry-pick');
    expect(sequencer('revert 1a2b3c4 Add a\n')).toBe('revert');
    expect(detectOperation((n) => n === 'sequencer')).toBe('cherry-pick');
    // Removed between the two looks: nothing is in progress.
    expect(
      detectOperation(
        (n) => n === 'sequencer',
        () => {
          throw new Error('ENOENT');
        },
      ),
    ).toBeUndefined();
    // CHERRY_PICK_HEAD still decides when it is there.
    expect(detectOperation((n) => n === 'sequencer' || n === 'REVERT_HEAD', () => 'pick 1a2b3c4 x\n')).toBe('revert');
  });

  it('lists the conflicted paths of a status', () => {
    const files = [
      { path: 'both.txt', index: 'U', worktree: 'U' },
      { path: 'added-both.txt', index: 'A', worktree: 'A' },
      { path: 'deleted-them.txt', index: 'U', worktree: 'D' },
      { path: 'staged.txt', index: 'A', worktree: '.' },
      { path: 'new.txt', index: '?', worktree: '?' },
    ];
    expect(conflictedPaths(files)).toEqual(['both.txt', 'added-both.txt', 'deleted-them.txt']);
  });

  it('continues, aborts and skips each operation, with no skip for a merge', () => {
    expect(operationArgs('merge', 'continue')).toEqual(['merge', '--continue']);
    expect(operationArgs('merge', 'abort')).toEqual(['merge', '--abort']);
    expect(operationArgs('merge', 'skip')).toBeNull();
    expect(operationArgs('rebase', 'skip')).toEqual(['rebase', '--skip']);
    expect(operationArgs('cherry-pick', 'continue')).toEqual(['cherry-pick', '--continue']);
    expect(operationArgs('revert', 'abort')).toEqual(['revert', '--abort']);
  });
});

describe('parseBlamePorcelain', () => {
  const first = 'fbf88dfc3acc7145a37307233ad04db364795d4d';
  const second = 'c4672daa5c3e57b4483fbcdc13ac741ddab055e1';
  const details = (author: string, time: number, summary: string) => [
    `author ${author}`,
    `author-mail <${author.toLowerCase()}@x.test>`,
    `author-time ${time}`,
    'author-tz +0000',
    `committer ${author}`,
    `committer-mail <${author.toLowerCase()}@x.test>`,
    `committer-time ${time}`,
    'committer-tz +0000',
    `summary ${summary}`,
  ];
  // What git 2.47 printed for a file renamed from "my file.txt", with a line added in the working tree.
  const out = [
    `${first} 1 1 1`,
    ...details('Ann', 1767225600, 'First'),
    'boundary',
    'filename my file.txt',
    '\tone',
    `${second} 2 2 3`,
    ...details('Bob', 1769904000, 'Second'),
    `previous ${first} my file.txt`,
    'filename my file.txt',
    '\tTWO',
    `${second} 3 3`,
    '\tthree\r',
    `${second} 4 4`,
    '\tfour',
    `0000000000000000000000000000000000000000 5 5 1`,
    ...details('Not Committed Yet', 1792676215, 'Version of renamed file.txt from renamed file.txt'),
    `previous ${second} renamed file.txt`,
    'filename renamed file.txt',
    '\tfive',
    // The first commit again, further down: only its header, no details.
    `${first} 2 6 1`,
    '\ttwo again',
    '',
  ].join('\n');

  it('lists each commit once, however many lines it has, and every line by hash', () => {
    const blame = parseBlamePorcelain(out, { path: 'renamed file.txt', ref: 'HEAD' });
    expect(blame.path).toBe('renamed file.txt');
    expect(blame.ref).toBe('HEAD');
    expect(Object.keys(blame.commits).sort()).toEqual([second, first].sort());
    expect(blame.lines.map((l) => [l.line, l.commit, l.originalLine])).toEqual([
      [1, first, 1],
      [2, second, 2],
      [3, second, 3],
      [4, second, 4],
      [5, null, 5],
      [6, first, 2],
    ]);
    expect(blame.commits[second]).toEqual({
      hash: second,
      author: 'Bob',
      authorEmail: 'bob@x.test',
      authorTime: '2026-02-01T00:00:00.000Z',
      summary: 'Second',
      path: 'my file.txt',
      previous: { commit: first, path: 'my file.txt' },
      boundary: false,
    });
  });

  it('marks the boundary, gives uncommitted lines no commit, and keeps spaces in file names', () => {
    const blame = parseBlamePorcelain(out, { path: 'renamed file.txt' });
    expect(blame.ref).toBeUndefined();
    expect(blame.commits[first].boundary).toBe(true);
    expect(blame.commits[first].previous).toBeUndefined();
    expect(blame.commits[first].path).toBe('my file.txt');
    expect(blame.lines[4]).toEqual({ line: 5, commit: null, originalLine: 5, text: 'five' });
    expect(Object.values(blame.commits).some((c) => c.author === 'Not Committed Yet')).toBe(false);
  });

  it('drops the CR of a CRLF line and keeps tabs and leading spaces in the text', () => {
    const crlf = [`${first} 1 1 2`, ...details('Ann', 1767225600, 'First'), 'filename a.txt', '\t\tindented\r', `${first} 2 2`, '\t  spaced  \r', ''].join('\n');
    expect(parseBlamePorcelain(crlf, { path: 'a.txt' }).lines.map((l) => l.text)).toEqual(['\tindented', '  spaced  ']);
  });

  it('keeps a lone CR inside a line, and reads a last line without a newline (git adds one)', () => {
    // What git 2.47 printed for "one\rtwo\nthree", the file ending without a newline.
    const out = [`${first} 1 1 2`, ...details('Ann', 1767225600, 'First'), 'filename cr.txt', '\tone\rtwo', `${first} 2 2`, '\tthree', ''].join('\n');
    expect(parseBlamePorcelain(out, { path: 'cr.txt' }).lines.map((l) => [l.line, l.text])).toEqual([
      [1, 'one\rtwo'],
      [2, 'three'],
    ]);
  });

  it('unquotes C-quoted file names in filename and previous', () => {
    const quoted = [`${second} 1 1 1`, ...details('Bob', 1769904000, 'Second'), `previous ${first} "old\\tname \\"q\\".txt"`, 'filename "caf\\303\\251 \\\\ x.txt"', '\tx', ''].join('\n');
    const c = parseBlamePorcelain(quoted, { path: 'café \\ x.txt' }).commits[second];
    expect(c.path).toBe('café \\ x.txt');
    expect(c.previous).toEqual({ commit: first, path: 'old\tname "q".txt' });
    expect(unquoteGitPath('plain name.txt')).toBe('plain name.txt');
  });

  it('reads SHA-256 hashes, and an empty file as no lines', () => {
    const long = 'a'.repeat(64);
    const blame = parseBlamePorcelain([`${long} 1 1 1`, ...details('Ann', 0, 'x'), 'filename f', '\tline', ''].join('\n'), { path: 'f' });
    expect(blame.lines).toEqual([{ line: 1, commit: long, originalLine: 1, text: 'line' }]);
    expect(blame.commits[long].authorTime).toBe('1970-01-01T00:00:00.000Z');
    expect(parseBlamePorcelain('', { path: 'empty' })).toEqual({ path: 'empty', lines: [], commits: {} });
  });
});

describe('conflictKind', () => {
  it('names each pair of unmerged codes, and nothing else', () => {
    const kinds = ['UU', 'AA', 'DD', 'AU', 'UA', 'DU', 'UD', 'M.', '??'].map((xy) => conflictKind({ index: xy[0], worktree: xy[1] }));
    expect(kinds).toEqual(['both-modified', 'both-added', 'both-deleted', 'added-by-us', 'added-by-them', 'deleted-by-us', 'deleted-by-them', null, null]);
  });
});

describe('parseUnmergedEntries', () => {
  it('reads the stages of ls-files -u -z, keeping spaces and tabs in paths', () => {
    const out = ['100644 aaa111 1\ta b.txt', '100644 bbb222 2\ta b.txt', '100755 ccc333 3\ta b.txt', '100644 ddd444 2\tgone\there.txt', ''].join('\0');
    expect(parseUnmergedEntries(out)).toEqual([
      { mode: '100644', object: 'aaa111', stage: 1, path: 'a b.txt' },
      { mode: '100644', object: 'bbb222', stage: 2, path: 'a b.txt' },
      { mode: '100755', object: 'ccc333', stage: 3, path: 'a b.txt' },
      { mode: '100644', object: 'ddd444', stage: 2, path: 'gone\there.txt' },
    ]);
  });
});

describe('mergeMessageName', () => {
  it('takes the branch, remote branch, tag or commit a merge message names', () => {
    expect(mergeMessageName("Merge branch 'side'\n\n# Conflicts:\n#\ta.txt\n")).toBe('side');
    expect(mergeMessageName("Merge branch 'feat/x' into main")).toBe('feat/x');
    expect(mergeMessageName("Merge remote-tracking branch 'origin/main'")).toBe('origin/main');
    expect(mergeMessageName("Merge tag 'v1.2'")).toBe('v1.2');
    expect(mergeMessageName("Merge commit 'abc1234'")).toBe('abc1234');
    expect(mergeMessageName('Something else')).toBeNull();
  });

  it('names the remote of a pull, whose branch often has the current branch\'s name', () => {
    expect(mergeMessageName("Merge branch 'main' of github.com:owner/repo\n")).toBe('main of github.com:owner/repo');
  });
});

describe('parseMarkerSize', () => {
  it('reads check-attr -z, falling back to 7 when the attribute is unset or not a positive number', () => {
    const out = (value: string) => ['a.txt', 'conflict-marker-size', value, ''].join('\0');
    expect(parseMarkerSize(out('32'))).toBe(32);
    expect(parseMarkerSize(out('unspecified'))).toBe(7);
    expect(parseMarkerSize(out('0'))).toBe(7);
    expect(parseMarkerSize('')).toBe(7);
  });
});

describe('conflictLabels', () => {
  it('makes ours the current branch in a merge, cherry-pick and revert', () => {
    expect(conflictLabels({ operation: 'merge', current: 'main', merging: 'side' })).toEqual({ ours: 'main', theirs: 'side' });
    expect(conflictLabels({ operation: 'cherry-pick', current: 'main', commit: 'abc1234 Add c' })).toEqual({ ours: 'main', theirs: 'abc1234 Add c' });
    expect(conflictLabels({ operation: 'revert', current: 'main', commit: 'abc1234 Add c' })).toEqual({ ours: 'main', theirs: 'revert of abc1234 Add c' });
  });

  it('swaps them in a rebase: ours is what the branch goes onto, theirs the commit being replayed', () => {
    expect(conflictLabels({ operation: 'rebase', current: 'def5678', rebasing: 'topic', onto: 'main', commit: 'abc1234 Topic edit' })).toEqual({ ours: 'main', theirs: 'abc1234 Topic edit (from topic)' });
  });

  it('says what it can without an operation (a stash apply) or when a name is missing', () => {
    expect(conflictLabels({ current: 'main' })).toEqual({ ours: 'main', theirs: 'the incoming changes' });
    expect(conflictLabels({ operation: 'merge', current: 'main' })).toEqual({ ours: 'main', theirs: 'MERGE_HEAD' });
  });
});

describe('parseConflictMarkers', () => {
  const merge = ['a', '<<<<<<< HEAD', 'B2', '=======', 'B1', '>>>>>>> side', 'c', '<<<<<<< HEAD', 'D2', '=======', 'D1', '>>>>>>> side', 'e', ''].join('\n');

  it('splits the merge style into text and conflicts that join back to the text', () => {
    const chunks = parseConflictMarkers(merge);
    expect(chunks.map((c) => c.kind)).toEqual(['text', 'conflict', 'text', 'conflict', 'text']);
    expect(chunks.map((c) => (c.kind === 'text' ? c.text : c.raw)).join('')).toBe(merge);
    const [first, second] = conflictRegions(merge);
    expect(first).toMatchObject({ index: 0, ours: 'B2\n', base: null, theirs: 'B1\n', oursLabel: 'HEAD', baseLabel: null, theirsLabel: 'side', eol: '\n' });
    expect(second).toMatchObject({ index: 1, ours: 'D2\n', theirs: 'D1\n' });
    expect(merge.slice(first.from, first.to)).toBe('<<<<<<< HEAD\nB2\n=======\nB1\n>>>>>>> side\n');
    expect(merge.slice(first.oursFrom, first.oursTo)).toBe('B2\n');
    expect(merge.slice(first.theirsFrom, first.theirsTo)).toBe('B1\n');
  });

  it('reads the base section of the diff3 style', () => {
    const diff3 = ['a', '<<<<<<< HEAD', 'B2', '||||||| merged common ancestors', 'b', '=======', 'B1', '>>>>>>> side', 'c', ''].join('\n');
    const [region] = conflictRegions(diff3);
    expect(region).toMatchObject({ ours: 'B2\n', base: 'b\n', theirs: 'B1\n', baseLabel: 'merged common ancestors' });
    expect(diff3.slice(region.baseFrom!, region.baseTo!)).toBe('b\n');
  });

  it('reads the zdiff3 style, whose common lines sit outside the conflict, and empty sides', () => {
    const zdiff3 = ['same', '<<<<<<< HEAD', 'ours only', '||||||| 1a2b3c4', '=======', '>>>>>>> feature/x', 'tail', ''].join('\n');
    const chunks = parseConflictMarkers(zdiff3);
    expect(chunks[0]).toEqual({ kind: 'text', text: 'same\n' });
    expect(conflictRegions(zdiff3)[0]).toMatchObject({ ours: 'ours only\n', base: '', theirs: '', baseLabel: '1a2b3c4', theirsLabel: 'feature/x' });
  });

  it('keeps CRLF lines as they are and remembers the line break', () => {
    const crlf = 'a\r\n<<<<<<< HEAD\r\nB2\r\n=======\r\nB1\r\n>>>>>>> side\r\nc\r\n';
    const [region] = conflictRegions(crlf);
    expect(region).toMatchObject({ ours: 'B2\r\n', theirs: 'B1\r\n', theirsLabel: 'side', eol: '\r\n' });
    expect(renderResolution(parseConflictMarkers(crlf), { 0: 'ours-theirs' })).toBe('a\r\nB2\r\nB1\r\nc\r\n');
  });

  it('leaves lines that only look like markers as text', () => {
    const lookalikes = ['<<<<<<<< eight', '=======', 'Heading', '======= with text', '>>>>>>> stray', '<<<<<<<tight', ''].join('\n');
    expect(parseConflictMarkers(lookalikes)).toEqual([{ kind: 'text', text: lookalikes }]);
    // Inside a conflict, a line of eight `=` or an end marker before the separator is part of the side.
    const inside = ['<<<<<<< HEAD', '========', '>>>>>>> early', '=======', 'theirs', '>>>>>>> side', ''].join('\n');
    expect(conflictRegions(inside)[0]).toMatchObject({ ours: '========\n>>>>>>> early\n', theirs: 'theirs\n' });
  });

  it('leaves a conflict that never closes as text, and starts afresh at a second start marker', () => {
    const unclosed = ['<<<<<<< HEAD', 'x', '=======', 'y', ''].join('\n');
    expect(parseConflictMarkers(unclosed)).toEqual([{ kind: 'text', text: unclosed }]);
    const restarted = ['<<<<<<< HEAD', 'lost', '<<<<<<< HEAD', 'x', '=======', 'y', '>>>>>>> side', ''].join('\n');
    const chunks = parseConflictMarkers(restarted);
    expect(chunks.map((c) => c.kind)).toEqual(['text', 'conflict']);
    expect(chunks[0]).toEqual({ kind: 'text', text: '<<<<<<< HEAD\nlost\n' });
  });

  it('reads markers of the size the conflict-marker-size attribute sets, and only those', () => {
    const sized = ['a', '<<<<<<<<<< HEAD', '<<<<<<< not a marker', 'x', '==========', 'y', '>>>>>>>>>> side', ''].join('\n');
    expect(conflictRegions(sized)).toEqual([]);
    expect(conflictRegions(sized, 10)[0]).toMatchObject({ ours: '<<<<<<< not a marker\nx\n', theirs: 'y\n', oursLabel: 'HEAD', theirsLabel: 'side' });
  });

  it('keeps the longer markers git writes for conflicts nested in a recursive merge\'s base as part of the base', () => {
    const nested = ['<<<<<<< HEAD', 'ours', '||||||| merged common ancestors', '<<<<<<<<< Temporary merge branch 1', 'b1', '=========', 'b2', '>>>>>>>>> Temporary merge branch 2', '=======', 'theirs', '>>>>>>> side', ''].join('\n');
    const [region] = conflictRegions(nested);
    expect(region.base).toBe('<<<<<<<<< Temporary merge branch 1\nb1\n=========\nb2\n>>>>>>>>> Temporary merge branch 2\n');
    expect(region.theirs).toBe('theirs\n');
  });

  it('reads the diff3 style with CRLF lines', () => {
    const crlf = 'a\r\n<<<<<<< ours\r\nB2\r\n||||||| base\r\nb\r\n=======\r\nB1\r\n>>>>>>> theirs\r\n';
    expect(conflictRegions(crlf)[0]).toMatchObject({ ours: 'B2\r\n', base: 'b\r\n', theirs: 'B1\r\n', baseLabel: 'base', eol: '\r\n' });
    expect(renderResolution(parseConflictMarkers(crlf), { 0: 'base' })).toBe('a\r\nb\r\n');
  });

  it('finds no conflict in plain or empty text', () => {
    expect(parseConflictMarkers('')).toEqual([]);
    expect(conflictRegions('just text\nno markers')).toEqual([]);
  });
});

describe('conflictMarkerLines', () => {
  it('finds start, base and end marker lines left over, whole conflicts or not, but not a lone separator', () => {
    expect(conflictMarkerLines(['a', 'B2', '=======', 'B1', '>>>>>>> side', 'c'].join('\n'))).toEqual([5]);
    expect(conflictMarkerLines(['<<<<<<< HEAD\r', 'x\r', '||||||| base\r', ''].join('\n'))).toEqual([1, 3]);
    expect(conflictMarkerLines(['Title', '=======', '<<<<<<<< eight', '>>>>>>>tight'].join('\n'))).toEqual([]);
    expect(conflictMarkerLines('<<<<<<< HEAD\n', 10)).toEqual([]);
  });
});

describe('dropAddedFinalNewline', () => {
  // git ends the last marker line with a line break even when neither side has a final one.
  const working = 'a\n<<<<<<< HEAD\nmain\n=======\nside\n>>>>>>> side\n';

  it('drops the final line break git added when the last conflict ends the file and no side has one', () => {
    expect(dropAddedFinalNewline('a\nside\n', { working, ours: 'a\nmain', theirs: 'a\nside' })).toBe('a\nside');
  });

  it('keeps it when a side has one, the file goes on after the conflict, or a side is missing', () => {
    expect(dropAddedFinalNewline('a\nside\n', { working, ours: 'a\nmain\n', theirs: 'a\nside' })).toBe('a\nside\n');
    expect(dropAddedFinalNewline('a\nside\nz', { working: `${working}z`, ours: 'a\nmain\nz', theirs: 'a\nside\nz' })).toBe('a\nside\nz');
    expect(dropAddedFinalNewline('a\nside\n', { working, ours: null, theirs: 'a\nside' })).toBe('a\nside\n');
  });
});

describe('renderResolution', () => {
  const text = ['a', '<<<<<<< HEAD', 'B2', '||||||| base', 'b', '=======', 'B1', '>>>>>>> side', 'c', '<<<<<<< HEAD', 'D2', '=======', 'D1', '>>>>>>> side', ''].join('\n');
  const chunks = parseConflictMarkers(text);

  it('takes a side, the base, both in either order, none or text of its own per conflict', () => {
    expect(renderResolution(chunks, { 0: 'ours', 1: 'theirs' })).toBe('a\nB2\nc\nD1\n');
    expect(renderResolution(chunks, { 0: 'base', 1: 'ours-theirs' })).toBe('a\nb\nc\nD2\nD1\n');
    expect(renderResolution(chunks, { 0: 'theirs-ours', 1: 'none' })).toBe('a\nB1\nB2\nc\n');
    expect(renderResolution(chunks, { 0: { text: 'mine\n' }, 1: 'ours' })).toBe('a\nmine\nc\nD2\n');
  });

  it('keeps the markers of a conflict with no choice', () => {
    const out = renderResolution(chunks, { 1: 'ours' });
    expect(out).toBe(text.replace('<<<<<<< HEAD\nD2\n=======\nD1\n>>>>>>> side\n', 'D2\n'));
    expect(conflictRegions(out)).toHaveLength(1);
  });

  it('puts a line break between two sides when the first lacks one, and none after a conflict that ends the file without one', () => {
    const atEnd = 'x\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> side';
    const [region] = conflictRegions(atEnd);
    expect(resolveConflict(region, 'ours')).toBe('ours');
    expect(resolveConflict(region, 'ours-theirs')).toBe('ours\ntheirs');
    expect(resolveConflict({ ...region, ours: 'no break', raw: `${region.raw}\n` }, 'ours-theirs')).toBe('no break\ntheirs\n');
  });
});

describe('worktrees', () => {
  // git 2.43 on Windows, which prints forward slashes; the folders were made with git worktree add, lock, and one deleted.
  const W = 'C:/Users/me/AppData/Local/Temp/wtl';
  const listed = [
    `worktree ${W}/repo`,
    'HEAD b3fcf89',
    'branch refs/heads/main',
    '',
    `worktree ${W}/det`,
    'HEAD b3fcf89',
    'detached',
    '',
    `worktree ${W}/gone`,
    'HEAD b3fcf89',
    'branch refs/heads/gone',
    'prunable gitdir file points to non-existent location',
    '',
    `worktree ${W}/lk`,
    'HEAD b3fcf89',
    'branch refs/heads/locked',
    'locked on a usb disk',
    '',
    `worktree ${W}/lk2`,
    'HEAD b3fcf89',
    'branch refs/heads/lk2',
    'locked',
    '',
    `worktree ${W}/with space`,
    'HEAD b3fcf89',
    'branch refs/heads/feat/x',
    '',
    '',
  ].join('\0');

  it('reads the main, linked, detached, locked and prunable worktrees, keeping spaces in paths', () => {
    const base = { head: 'b3fcf89', detached: false, bare: false, locked: false, prunable: false, main: false, current: false };
    expect(parseWorktreeList(listed, 'C:\\Users\\me\\AppData\\Local\\Temp\\wtl\\with space\\')).toEqual([
      { ...base, path: `${W}/repo`, branch: 'main', main: true },
      { ...base, path: `${W}/det`, branch: null, detached: true },
      { ...base, path: `${W}/gone`, branch: 'gone', prunable: true, prunableReason: 'gitdir file points to non-existent location' },
      { ...base, path: `${W}/lk`, branch: 'locked', locked: true, lockReason: 'on a usb disk' },
      { ...base, path: `${W}/lk2`, branch: 'lk2', locked: true },
      { ...base, path: `${W}/with space`, branch: 'feat/x', current: true },
    ]);
  });

  it('reads a bare main repository and a repository with no commits yet', () => {
    const bare = [`worktree ${W}/bare.git`, 'bare', '', `worktree ${W}/fromBare`, 'HEAD b3fcf89', 'branch refs/heads/main', '', ''].join('\0');
    expect(parseWorktreeList(bare, `${W}/fromBare`).map((w) => [w.path, w.bare, w.head, w.branch, w.main, w.current])).toEqual([
      [`${W}/bare.git`, true, null, null, true, false],
      [`${W}/fromBare`, false, 'b3fcf89', 'main', false, true],
    ]);
    const fresh = `worktree /home/me/repo\0HEAD 0000000000000000000000000000000000000000\0branch refs/heads/main\0\0`;
    expect(parseWorktreeList(fresh, '/home/me/repo')).toEqual([{ path: '/home/me/repo', head: null, branch: 'main', detached: false, bare: false, locked: false, prunable: false, main: true, current: true }]);
    expect(parseWorktreeList('')).toEqual([]);
  });

  it('reads the output of a git without -z (before 2.36), one attribute per line', () => {
    const lines = listed.split('\0').join('\n').replace(/\n/g, '\r\n');
    expect(parseWorktreeList(lines, `${W}/lk`)).toEqual(parseWorktreeList(listed, `${W}/lk`));
    expect(parseWorktreeList(lines).map((w) => w.path)).toEqual([`${W}/repo`, `${W}/det`, `${W}/gone`, `${W}/lk`, `${W}/lk2`, `${W}/with space`]);
  });

  it('compares folders across slashes, trailing separators and, on Windows, case', () => {
    expect(sameWorktreePath('C:/Repo/', 'c:\\repo')).toBe(true);
    expect(sameWorktreePath('/home/me/Repo', '/home/me/repo')).toBe(false);
    expect(isSameOrInside('C:\\repo\\sub\\x', 'c:/Repo')).toBe(true);
    expect(isSameOrInside('/home/me/repo', '/home/me/repo/')).toBe(true);
    expect(isSameOrInside('/home/me/repo-other', '/home/me/repo')).toBe(false);
    expect(isSameOrInside('/anything', '/')).toBe(true);
  });

  it('puts a new worktree beside the repository, in <name>.worktrees, one folder per branch', () => {
    expect(defaultWorktreePath('C:\\code\\quiver', 'feat/git-blame')).toBe('C:\\code\\quiver.worktrees\\feat-git-blame');
    expect(defaultWorktreePath('/home/me/quiver/', 'fix/a|b')).toBe('/home/me/quiver.worktrees/fix-a-b');
    expect(defaultWorktreePath('/quiver', 'main')).toBe('/quiver.worktrees/main');
    expect(worktreeFolderName('//')).toBe('worktree');
  });

  it("reads the branch and folder from git's refusals about a branch checked out elsewhere", () => {
    expect(worktreeRefusal("'main' is already used by worktree at 'C:/tmp/repo'")).toEqual({ branch: 'main', path: 'C:/tmp/repo' });
    expect(worktreeRefusal("fatal: 'feat/x' is already checked out at '/home/me/x y'")).toEqual({ branch: 'feat/x', path: '/home/me/x y' });
    expect(worktreeRefusal("cannot delete branch 'main' used by worktree at 'C:/tmp/repo'")).toEqual({ branch: 'main', path: 'C:/tmp/repo' });
    expect(worktreeRefusal("error: Cannot delete branch 'b' checked out at '/r'")).toEqual({ branch: 'b', path: '/r' });
    expect(worktreeRefusal("'x' is already used by worktree at 'C:/code/bob's tree'\r\nhint: something")).toEqual({ branch: 'x', path: "C:/code/bob's tree" });
    expect(worktreeRefusal('pathspec did not match')).toBeNull();
  });

  it('names the worktree of a branch checked out in another one, but not the current branch', () => {
    const line = (f: string[]) => f.join('\0');
    const out = [
      line(['refs/heads/feat/x', 'feat/x', '*', '', '', 'h1', 'a', '', `${W}/with space`]),
      line(['refs/heads/main', 'main', ' ', '', '', 'h2', 'm', '', `${W}/repo`]),
      line(['refs/heads/free', 'free', ' ', '', '', 'h3', 'f', '', '']),
    ].join('\n');
    expect(parseBranches(out).map((b) => [b.name, b.worktreePath])).toEqual([
      ['feat/x', undefined],
      ['main', `${W}/repo`],
      ['free', undefined],
    ]);
  });
});
