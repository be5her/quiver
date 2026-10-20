import { describe, expect, it } from 'vitest';
import {
  failedLogExcerpt,
  jobIdFromCheckUrl,
  parseAuthStatus,
  parseChecks,
  parsePatchFiles,
  parsePullRequestDetail,
  parsePullRequestList,
  parseRemoteRepo,
  pickRemote,
  repoArg,
  repoName,
  rollupChecks,
} from './gh-parse';

// The fixtures are what gh 2.100 printed, trimmed to the fields that are read.

describe('parseAuthStatus', () => {
  it('picks the active account from the JSON, which has no token', () => {
    const out = JSON.stringify({
      hosts: {
        'github.com': [
          { state: 'success', active: false, host: 'github.com', login: 'second', tokenSource: 'keyring' },
          { state: 'success', active: true, host: 'github.com', login: 'first', tokenSource: 'keyring' },
        ],
      },
    });
    expect(parseAuthStatus(out, 'github.com')).toEqual({ authenticated: true, user: 'first' });
    expect(parseAuthStatus(out, 'ghe.example.com')).toEqual({ authenticated: false });
  });

  it('is signed out when no host or only failed accounts are listed', () => {
    expect(parseAuthStatus('{"hosts":{}}', 'github.com')).toEqual({ authenticated: false });
    expect(parseAuthStatus(JSON.stringify({ hosts: { 'github.com': [{ state: 'error', active: true, login: 'x' }] } }), 'github.com')).toEqual({ authenticated: false });
  });

  it('reads the text of older versions, both wordings, active account first', () => {
    const text = [
      'github.com',
      '  ✓ Logged in to github.com account second (keyring)',
      '  - Active account: false',
      '  - Token: gho_************************************',
      '',
      '  ✓ Logged in to github.com account first (keyring)',
      '  - Active account: true',
    ].join('\r\n');
    expect(parseAuthStatus(text, 'github.com')).toEqual({ authenticated: true, user: 'first' });
    expect(parseAuthStatus('github.com\n  ✓ Logged in to github.com as old (oauth_token)\n', 'github.com')).toEqual({ authenticated: true, user: 'old' });
    expect(parseAuthStatus('You are not logged into any GitHub hosts. To log in, run: gh auth login', 'github.com')).toEqual({ authenticated: false });
  });
});

describe('remotes', () => {
  it('reads https, scp-like and ssh URLs, with or without .git', () => {
    expect(parseRemoteRepo('https://github.com/be5her/quiver.git')).toEqual({ host: 'github.com', owner: 'be5her', name: 'quiver' });
    expect(parseRemoteRepo('git@github.com:Owner/Repo.git')).toEqual({ host: 'github.com', owner: 'Owner', name: 'Repo' });
    expect(parseRemoteRepo('ssh://git@ssh.github.com:443/o/r.git')).toEqual({ host: 'github.com', owner: 'o', name: 'r' });
    expect(parseRemoteRepo('https://user@GHE.example.com/o/r/')).toEqual({ host: 'ghe.example.com', owner: 'o', name: 'r' });
  });

  it('gives null for folders and URLs that are not owner/name', () => {
    for (const url of ['../other', 'C:\\repos\\x', 'C:/repos/x', '/srv/git/x.git', 'file:///srv/x', 'https://github.com/only-owner', 'https://github.com/o/r/tree/main']) expect(parseRemoteRepo(url)).toBeNull();
  });

  it('picks the remote gh would: set-default, then upstream, github, origin, then the first, on known hosts only', () => {
    const remotes = [
      { name: 'mine', url: 'https://github.com/me/r.git' },
      { name: 'origin', url: 'https://github.com/me/r.git' },
      { name: 'upstream', url: 'git@github.com:them/r.git' },
      { name: 'lab', url: 'https://gitlab.com/x/r.git' },
    ];
    expect(pickRemote(remotes, ['github.com'])?.remote).toBe('upstream');
    expect(pickRemote([...remotes, { name: 'mine', url: remotes[0].url, resolved: true }].slice(1), ['github.com'])?.remote).toBe('mine');
    expect(pickRemote(remotes.slice(0, 1), ['github.com'])?.repo).toEqual({ host: 'github.com', owner: 'me', name: 'r' });
    expect(pickRemote([remotes[3]], ['github.com'])).toBeNull();
    expect(pickRemote([remotes[3]], ['github.com', 'gitlab.com'])?.remote).toBe('lab');
  });

  it('names the host in --repo also for github.com, so GH_HOST cannot send the call to Enterprise', () => {
    expect(repoArg({ host: 'github.com', owner: 'o', name: 'r' })).toBe('github.com/o/r');
    expect(repoArg({ host: 'ghe.example.com', owner: 'o', name: 'r' })).toBe('ghe.example.com/o/r');
  });

  it('shows a github.com repository without its host', () => {
    expect(repoName({ host: 'github.com', owner: 'o', name: 'r' })).toBe('o/r');
    expect(repoName({ host: 'ghe.example.com', owner: 'o', name: 'r' })).toBe('ghe.example.com/o/r');
  });
});

const PR = {
  author: { id: 'X', is_bot: false, login: 'be5her', name: '' },
  baseRefName: 'main',
  createdAt: '2026-10-20T19:00:00Z',
  headRefName: 'feat/x',
  isDraft: false,
  labels: [{ id: 'L', name: 'enhancement', color: 'a2eeef' }],
  number: 33,
  reviewDecision: '',
  state: 'OPEN',
  statusCheckRollup: [
    { __typename: 'CheckRun', completedAt: '2026-10-20T19:37:07Z', conclusion: 'SUCCESS', detailsUrl: 'https://github.com/o/r/actions/runs/1/job/2', name: 'build', startedAt: '2026-10-20T19:36:08Z', status: 'COMPLETED', workflowName: 'CI' },
    { __typename: 'CheckRun', completedAt: '0001-01-01T00:00:00Z', conclusion: '', name: 'smoke', status: 'IN_PROGRESS', workflowName: 'CI' },
    { __typename: 'StatusContext', context: 'deploy', state: 'ERROR', targetUrl: 'https://ci.example.com' },
  ],
  title: 'A change',
  updatedAt: '2026-10-20T19:40:00Z',
  url: 'https://github.com/o/r/pull/33',
};

describe('pull requests', () => {
  it('reads a list, with the check roll-up from runs and commit statuses', () => {
    expect(parsePullRequestList(JSON.stringify([PR]))).toEqual([
      {
        number: 33,
        title: 'A change',
        state: 'open',
        draft: false,
        author: 'be5her',
        headRefName: 'feat/x',
        baseRefName: 'main',
        url: 'https://github.com/o/r/pull/33',
        createdAt: '2026-10-20T19:00:00Z',
        updatedAt: '2026-10-20T19:40:00Z',
        labels: ['enhancement'],
        checks: { state: 'failure', passed: 1, failed: 1, pending: 1 },
      },
    ]);
  });

  it('maps states, review decisions, drafts, a deleted author and no checks', () => {
    const [merged] = parsePullRequestList(JSON.stringify([{ ...PR, state: 'MERGED', isDraft: true, reviewDecision: 'CHANGES_REQUESTED', author: null, statusCheckRollup: [] }]));
    expect(merged).toMatchObject({ state: 'merged', draft: true, reviewDecision: 'changes_requested', author: 'ghost', checks: { state: 'none', passed: 0, failed: 0, pending: 0 } });
  });

  it('reads the detail: body, files, reviews and comments', () => {
    const detail = parsePullRequestDetail(
      JSON.stringify({
        ...PR,
        body: 'Why',
        additions: 3,
        deletions: 1,
        files: [{ path: 'a b.ts', additions: 3, deletions: 1 }],
        reviews: [{ author: { login: 'rev' }, state: 'APPROVED', submittedAt: '2026-10-20T20:00:00Z', body: 'ok' }],
        comments: [{ author: { login: 'c' }, createdAt: '2026-10-20T20:01:00Z', body: 'hi' }],
      }),
    );
    expect(detail).toMatchObject({ body: 'Why', additions: 3, deletions: 1, files: [{ path: 'a b.ts', additions: 3, deletions: 1 }] });
    expect(detail.reviews).toEqual([{ author: 'rev', state: 'APPROVED', submittedAt: '2026-10-20T20:00:00Z', body: 'ok' }]);
    expect(detail.comments).toEqual([{ author: 'c', createdAt: '2026-10-20T20:01:00Z', body: 'hi' }]);
  });

  it('says what gh printed when it is not JSON', () => {
    expect(() => parsePullRequestList('no pull requests match your search')).toThrow(/other than JSON: no pull requests/);
  });

  it('rolls up: failure wins, then pending, then success; all skipped stays skipped', () => {
    expect(rollupChecks(['success', 'pending'])).toEqual({ state: 'pending', passed: 1, failed: 0, pending: 1 });
    expect(rollupChecks(['success', 'skipped'])).toEqual({ state: 'success', passed: 1, failed: 0, pending: 0 });
    expect(rollupChecks(['skipped', 'skipped']).state).toBe('skipped');
  });
});

describe('checks', () => {
  it("reads gh pr checks' buckets, dropping zero times", () => {
    const out = JSON.stringify([
      { bucket: 'pass', completedAt: '2026-10-20T19:37:07Z', link: 'https://github.com/o/r/actions/runs/1/job/2', name: 'build', startedAt: '2026-10-20T19:36:08Z', state: 'SUCCESS', workflow: 'CI' },
      { bucket: 'fail', completedAt: '2026-10-20T19:37:07Z', link: 'https://github.com/o/r/actions/runs/1/job/3', name: 'test', startedAt: '2026-10-20T19:36:08Z', state: 'FAILURE', workflow: 'CI' },
      { bucket: 'pending', completedAt: '0001-01-01T00:00:00Z', link: '', name: 'smoke', startedAt: '0001-01-01T00:00:00Z', state: 'QUEUED', workflow: '' },
      { bucket: 'skipping', name: 'deploy', state: 'SKIPPED' },
      { bucket: 'cancel', name: 'lint', state: 'CANCELLED' },
    ]);
    expect(parseChecks(out)).toEqual([
      { name: 'build', workflow: 'CI', state: 'success', url: 'https://github.com/o/r/actions/runs/1/job/2', startedAt: '2026-10-20T19:36:08Z', completedAt: '2026-10-20T19:37:07Z' },
      { name: 'test', workflow: 'CI', state: 'failure', url: 'https://github.com/o/r/actions/runs/1/job/3', startedAt: '2026-10-20T19:36:08Z', completedAt: '2026-10-20T19:37:07Z' },
      { name: 'smoke', state: 'pending' },
      { name: 'deploy', state: 'skipped' },
      { name: 'lint', state: 'failure' },
    ]);
  });

  it('finds the Actions job id in a check link', () => {
    expect(jobIdFromCheckUrl('https://github.com/o/r/actions/runs/39484844549/job/118842457942')).toBe('118842457942');
    expect(jobIdFromCheckUrl('https://ci.example.com/build/1')).toBeNull();
    expect(jobIdFromCheckUrl(undefined)).toBeNull();
  });

  it('keeps the end of a failed log, without timestamps, colours or the job column, under step headings', () => {
    const log = [
      'build\tRun npm test\t\uFEFF2026-10-19T09:15:31.1088959Z ##[group]Run npm test',
      'build\tRun npm test\t2026-10-19T09:15:31.1089147Z \u001b[36;1mnpm test\u001b[0m',
      'build\tRun npm test\t ❯ src/a.test.ts:4',
      'build\tRun npm test\t2026-10-19T09:15:35.3017594Z ##[error]Process completed with exit code 1.',
      'build\tPost\t2026-10-19T09:15:36.0000000Z cleanup ' + 'x'.repeat(500),
      '',
      '',
    ].join('\r\n');
    expect(failedLogExcerpt(log, 60, 20)).toBe(['## Run npm test', 'Run npm test', 'npm test', ' ❯ src/a.test.ts:4', '##[error]Process com…', '## Post', 'cleanup xxxxxxxxxxxx…'].join('\n'));
    expect(failedLogExcerpt(log, 2).split('\n')).toEqual(['## Run npm test', '##[error]Process completed with exit code 1.', '## Post', `cleanup ${'x'.repeat(392)}…`]);
  });
});

describe('parsePatchFiles', () => {
  const patch = [
    'diff --git a/src/a b.ts b/src/a b.ts',
    'index 1..2 100644',
    '--- a/src/a b.ts',
    '+++ b/src/a b.ts',
    '@@ -1,2 +1,2 @@',
    ' keep',
    '-old',
    '+new',
    '+-dash',
    'diff --git a/new.txt b/new.txt',
    'new file mode 100644',
    'index 0..3',
    '--- /dev/null',
    '+++ b/new.txt',
    '@@ -0,0 +1 @@',
    '+hello',
    '\\ No newline at end of file',
    'diff --git a/gone.txt b/gone.txt',
    'deleted file mode 100644',
    '--- a/gone.txt',
    '+++ /dev/null',
    '@@ -1,2 +0,0 @@',
    '-bye',
    '--- a line starting with dashes',
    'diff --git a/old name.txt b/new name.txt',
    'similarity index 90%',
    'rename from old name.txt',
    'rename to new name.txt',
    'diff --git a/img.png b/img.png',
    'index 4..5 100644',
    'Binary files a/img.png and b/img.png differ',
    '',
  ].join('\n');

  it('reads each file: paths with spaces, status, line counts and its own patch', () => {
    const files = parsePatchFiles(patch, 512 * 1024);
    expect(files.map(({ patch: p, ...f }) => ({ ...f, hasPatch: Boolean(p) }))).toEqual([
      { path: 'src/a b.ts', status: 'modified', additions: 2, deletions: 1, binary: false, hasPatch: true },
      { path: 'new.txt', status: 'added', additions: 1, deletions: 0, binary: false, hasPatch: true },
      { path: 'gone.txt', status: 'deleted', additions: 0, deletions: 2, binary: false, hasPatch: true },
      { path: 'new name.txt', origPath: 'old name.txt', status: 'renamed', additions: 0, deletions: 0, binary: false, hasPatch: true },
      { path: 'img.png', status: 'modified', additions: 0, deletions: 0, binary: true, hasPatch: false },
    ]);
    expect(files[0].patch).toMatch(/^diff --git a\/src\/a b\.ts[\s\S]*\+-dash\n$/);
  });

  it('decodes quoted paths: octal escapes are UTF-8 bytes, C escapes and quotes kept, the tab after a spaced name dropped', () => {
    const quoted = [
      'diff --git "a/\\303\\251.txt" "b/\\303\\251.txt"',
      'new file mode 100644',
      '--- /dev/null',
      '+++ "b/\\303\\251.txt"',
      '@@ -0,0 +1 @@',
      '+x',
      'diff --git "a/say \\"hi\\"\\t.txt" "b/say \\"hi\\"\\t.txt"',
      'deleted file mode 100644',
      '--- "a/say \\"hi\\"\\t.txt"',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-x',
      'diff --git "a/\\346\\227\\247 name" "b/\\346\\226\\260 name"',
      'similarity index 100%',
      'rename from "\\346\\227\\247 name"',
      'rename to "\\346\\226\\260 name"',
      'diff --git a/x y.txt b/x y.txt',
      '--- a/x y.txt\t',
      '+++ b/x y.txt\t',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      '',
    ].join('\n');
    expect(parsePatchFiles(quoted, 512 * 1024).map((f) => [f.path, f.origPath ?? null, f.status])).toEqual([
      ['é.txt', null, 'added'],
      ['say "hi"\t.txt', null, 'deleted'],
      ['新 name', '旧 name', 'renamed'],
      ['x y.txt', null, 'modified'],
    ]);
  });

  it('marks a patch over the limit, and the last file of a cut-short diff, as truncated', () => {
    const [big] = parsePatchFiles(patch, 100);
    expect(big).toMatchObject({ path: 'src/a b.ts', truncated: true });
    expect(big.patch).toBeUndefined();
    const cut = parsePatchFiles(patch.split('diff --git a/img.png')[0], 512 * 1024, true);
    expect(cut.map((f) => Boolean(f.truncated))).toEqual([false, false, false, true]);
    expect(cut[3].patch).toBeUndefined();
  });
});
