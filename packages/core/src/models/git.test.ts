import { describe, expect, it } from 'vitest';
import {
  GitArgSchema,
  GitBranchCreateInputSchema,
  GitBranchDeleteInputSchema,
  GitBranchDeleteRemoteInputSchema,
  GitBranchRenameInputSchema,
  GitBranchSetUpstreamInputSchema,
  GitCheckoutInputSchema,
  GitCherryPickInputSchema,
  GitDiffInputSchema,
  GitDiscardInputSchema,
  GitFileShowInputSchema,
  GitLogInputSchema,
  GitMergeInputSchema,
  GitPathsInputSchema,
  GitPrCreateInputSchema,
  GitPushInputSchema,
  GitRebaseInputSchema,
  GitRemoteInputSchema,
  GitResetInputSchema,
  GitRevertInputSchema,
  GitStashApplyInputSchema,
  GitStashPushInputSchema,
  GitTagCreateInputSchema,
  GitTagPushInputSchema,
} from './git';

describe('git command inputs', () => {
  it('refuse anything git would read as an option', () => {
    // A read-only command must not become a write: `git log --output=.git/hooks/pre-commit` writes a hook,
    // `git fetch --upload-pack=cmd .` runs a program.
    for (const bad of ['--output=.git/hooks/pre-commit', '--upload-pack=calc', '-', '-c', '']) expect(GitArgSchema.safeParse(bad).success, bad).toBe(false);
    expect(GitLogInputSchema.safeParse({ ref: '--output=x' }).success).toBe(false);
    expect(GitLogInputSchema.safeParse({ path: '-x' }).success).toBe(false);
    expect(GitDiffInputSchema.safeParse({ from: '--output=x' }).success).toBe(false);
    expect(GitDiffInputSchema.safeParse({ to: '-' }).success).toBe(false);
    expect(GitDiffInputSchema.safeParse({ path: '--no-index' }).success).toBe(false);
    expect(GitPathsInputSchema.safeParse({ paths: ['src/a.ts', '--all'] }).success).toBe(false);
    expect(GitCheckoutInputSchema.safeParse({ ref: '--orphan' }).success).toBe(false);
    expect(GitBranchCreateInputSchema.safeParse({ name: '-f' }).success).toBe(false);
    expect(GitBranchCreateInputSchema.safeParse({ name: 'ok', from: '--track' }).success).toBe(false);
    expect(GitRemoteInputSchema.safeParse({ remote: '--upload-pack=calc' }).success).toBe(false);
    expect(GitPushInputSchema.safeParse({ branch: '--receive-pack=calc' }).success).toBe(false);
    // The base of a pull request is a ref too, and a lane may hand it to git positionally (`git diff <base>...HEAD`).
    expect(GitPrCreateInputSchema.safeParse({ title: 't', base: '--output=x' }).success).toBe(false);
    expect(GitPrCreateInputSchema.safeParse({ title: 't', labels: ['bug', '--foo'] }).success).toBe(false);
  });

  it('accept ordinary refs, remotes and paths, with the dash anywhere but first', () => {
    for (const ok of ['main', 'feat/x-y', 'HEAD~2', 'v1.0.0', 'origin', 'a-b', 'src/-weird-/file.ts', '@{upstream}']) expect(GitArgSchema.safeParse(ok).success, ok).toBe(true);
    expect(GitLogInputSchema.parse({})).toMatchObject({ limit: 50, skip: 0 });
    expect(GitLogInputSchema.parse({ ref: 'main', path: 'src' })).toMatchObject({ ref: 'main', path: 'src' });
    expect(GitDiffInputSchema.parse({ from: 'main', to: 'HEAD' })).toMatchObject({ staged: false, statOnly: false });
    expect(GitPathsInputSchema.parse({ paths: ['a', 'b/c'] }).paths).toEqual(['a', 'b/c']);
    expect(GitPushInputSchema.parse({ remote: 'origin', branch: 'main', setUpstream: true })).toMatchObject({ forceWithLease: false });
    expect(GitPrCreateInputSchema.parse({ title: 't', base: 'main', labels: ['bug'] })).toMatchObject({ base: 'main', labels: ['bug'], draft: false, body: '' });
  });
});

describe('branch management inputs', () => {
  it('refuse anything git would read as an option', () => {
    // git rebase --exec runs a command; git merge -s picks a strategy program; git branch -D forces a delete.
    const bad: [{ safeParse(v: unknown): { success: boolean } }, unknown][] = [
      [GitBranchDeleteInputSchema, { name: '-D' }],
      [GitBranchDeleteRemoteInputSchema, { remote: '--receive-pack=calc', name: 'x' }],
      [GitBranchRenameInputSchema, { to: '--force' }],
      [GitBranchSetUpstreamInputSchema, { upstream: '--unset-upstream' }],
      [GitMergeInputSchema, { ref: '--strategy=calc' }],
      [GitRebaseInputSchema, { onto: '--exec=calc' }],
      [GitCherryPickInputSchema, { commits: ['main', '--strategy-option=x'] }],
      [GitRevertInputSchema, { commit: '-m' }],
      [GitResetInputSchema, { ref: '--hard', mode: 'soft' }],
      [GitStashPushInputSchema, { paths: ['--', 'a'] }],
      [GitDiscardInputSchema, { paths: ['--all'] }],
      [GitTagCreateInputSchema, { name: 'v1', ref: '--sort=x' }],
      [GitTagPushInputSchema, { remote: 'origin', name: '--mirror' }],
      [GitFileShowInputSchema, { path: '--output=x', ref: 'HEAD' }],
    ];
    for (const [schema, input] of bad) expect(schema.safeParse(input).success, JSON.stringify(input)).toBe(false);
    expect(GitResetInputSchema.safeParse({ ref: 'HEAD~1', mode: 'keep' }).success).toBe(false);
    expect(GitMergeInputSchema.safeParse({ ref: 'main', mode: 'octopus' }).success).toBe(false);
    expect(GitCherryPickInputSchema.safeParse({ commits: [] }).success).toBe(false);
    expect(GitStashApplyInputSchema.safeParse({ index: -1 }).success).toBe(false);
    expect(GitStashApplyInputSchema.safeParse({ index: 0, hash: '--all' }).success).toBe(false);
    expect(GitStashApplyInputSchema.safeParse({ index: 0, hash: 'abc1234' }).success).toBe(true);
  });

  it('fill in their defaults', () => {
    expect(GitBranchDeleteInputSchema.parse({ name: 'x' })).toEqual({ name: 'x', force: false });
    expect(GitBranchSetUpstreamInputSchema.parse({ upstream: null })).toEqual({ upstream: null });
    expect(GitStashPushInputSchema.parse({})).toEqual({ includeUntracked: false });
    expect(GitStashApplyInputSchema.parse({ index: 0 })).toEqual({ index: 0, pop: false });
    expect(GitDiscardInputSchema.parse({ paths: ['a'] })).toEqual({ paths: ['a'], staged: false });
    expect(GitFileShowInputSchema.parse({ path: 'a', ref: 'HEAD' })).toEqual({ path: 'a', ref: 'HEAD', index: false });
  });
});
