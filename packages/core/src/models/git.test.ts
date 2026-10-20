import { describe, expect, it } from 'vitest';
import { GitArgSchema, GitBranchCreateInputSchema, GitCheckoutInputSchema, GitDiffInputSchema, GitLogInputSchema, GitPathsInputSchema, GitPushInputSchema, GitRemoteInputSchema } from './git';

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
  });

  it('accept ordinary refs, remotes and paths, with the dash anywhere but first', () => {
    for (const ok of ['main', 'feat/x-y', 'HEAD~2', 'v1.0.0', 'origin', 'a-b', 'src/-weird-/file.ts', '@{upstream}']) expect(GitArgSchema.safeParse(ok).success, ok).toBe(true);
    expect(GitLogInputSchema.parse({})).toMatchObject({ limit: 50, skip: 0 });
    expect(GitLogInputSchema.parse({ ref: 'main', path: 'src' })).toMatchObject({ ref: 'main', path: 'src' });
    expect(GitDiffInputSchema.parse({ from: 'main', to: 'HEAD' })).toMatchObject({ staged: false, statOnly: false });
    expect(GitPathsInputSchema.parse({ paths: ['a', 'b/c'] }).paths).toEqual(['a', 'b/c']);
    expect(GitPushInputSchema.parse({ remote: 'origin', branch: 'main', setUpstream: true })).toMatchObject({ forceWithLease: false });
  });
});
