import { describe, expect, it } from 'vitest';
import { betaVersion, bump, latestStable, parseVersion, pullLevel, releaseLevel, releaseNotes } from './versioning.mjs';

const pull = (number, title, labels = [], headRef = 'claude/x') => ({ number, title, labels, headRef });

describe('versions', () => {
  it('parses plain, v-prefixed and prerelease versions', () => {
    expect(parseVersion('v1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: null });
    expect(parseVersion('0.3.1-beta.12')).toEqual({ major: 0, minor: 3, patch: 1, prerelease: 'beta.12' });
    expect(parseVersion('release-1')).toBeNull();
  });

  it('finds the highest stable tag, ignoring betas and other tags', () => {
    expect(latestStable(['v0.1.0', 'v0.10.0', 'v0.9.0', 'v0.11.1-beta.3', 'nightly', 'x1.0.0'])).toBe('0.10.0');
    expect(latestStable(['v0.1.1-beta.1'])).toBeNull();
    expect(latestStable([])).toBeNull();
  });

  it('numbers betas after the next patch, so any stable bump sorts above them', () => {
    expect(betaVersion('0.3.0', 7)).toBe('0.3.1-beta.7');
    expect(betaVersion(null, 1)).toBe('0.0.1-beta.1');
    expect(() => betaVersion('0.3.0', 0)).toThrow();
    expect(() => betaVersion('0.3.1-beta.2', 1)).toThrow();
  });

  it('bumps each part and resets the lower ones', () => {
    expect(bump('0.3.4', 'patch')).toBe('0.3.5');
    expect(bump('0.3.4', 'minor')).toBe('0.4.0');
    expect(bump('0.3.4', 'major')).toBe('1.0.0');
    expect(bump(null, 'minor')).toBe('0.1.0');
  });
});

describe('bump level', () => {
  it('reads labels first, then branch names and conventional titles', () => {
    expect(pullLevel(pull(1, 'Drop the v1 store', ['breaking']))).toBe('major');
    expect(pullLevel(pull(2, 'Kube view', ['enhancement']))).toBe('minor');
    expect(pullLevel(pull(3, 'New palette', ['design']))).toBe('minor');
    expect(pullLevel(pull(4, 'Kube view', [], 'feat/kube'))).toBe('minor');
    expect(pullLevel(pull(5, 'feat(mock): delays'))).toBe('minor');
    expect(pullLevel(pull(6, 'fix!: rename the config file'))).toBe('major');
    expect(pullLevel(pull(7, 'Teleport: fix login loop', ['bug'], 'fix/login'))).toBe('patch');
    expect(pullLevel(pull(8, 'Rename master to main'))).toBe('patch');
  });

  it('takes the largest change merged since the last release', () => {
    const pulls = [pull(4, 'Fix release script', ['bug']), pull(6, 'Kube view', ['enhancement']), pull(5, 'Rename master to main')];
    expect(releaseLevel('0.3.0', pulls)).toEqual({ level: 'minor', reason: 'new feature in #6 Kube view' });
    expect(releaseLevel('0.3.0', [pull(4, 'Fix', ['bug'])]).level).toBe('patch');
    expect(releaseLevel('0.3.0', []).level).toBe('patch');
  });

  it('keeps 0.x on minor for breaking changes, and bumps major from 1.0 on', () => {
    const breaking = [pull(9, 'New storage layout', ['breaking'])];
    expect(releaseLevel('0.3.0', breaking).level).toBe('minor');
    expect(releaseLevel('1.2.0', breaking).level).toBe('major');
  });

  it('lets a release:* label on the pull request into stable decide', () => {
    const pulls = [pull(6, 'Kube view', ['enhancement'])];
    expect(releaseLevel('0.3.0', pulls, ['release:major']).level).toBe('major');
    expect(releaseLevel('0.3.0', pulls, ['Release:Patch']).level).toBe('patch');
    expect(releaseLevel('0.3.0', pulls, ['release:huge', 'bug']).level).toBe('minor');
  });
});

describe('release notes', () => {
  it('groups pull requests by label, skips skip-changelog and links the comparison', () => {
    const notes = releaseNotes({
      repo: 'be5her/quiver',
      version: '0.4.0',
      previous: '0.3.0',
      pulls: [pull(4, 'Fix release script', ['bug']), pull(6, 'Kube view', ['enhancement']), pull(5, 'Rename master to main'), pull(7, 'Bump deps', ['skip-changelog'])],
    });
    expect(notes).toBe(
      [
        '### New',
        '',
        '- Kube view (#6)',
        '',
        '### Fixes',
        '',
        '- Fix release script (#4)',
        '',
        '### Other changes',
        '',
        '- Rename master to main (#5)',
        '',
        '**Full changelog**: https://github.com/be5her/quiver/compare/v0.3.0...v0.4.0',
        '',
      ].join('\n'),
    );
  });

  it('says so when nothing user-visible merged', () => {
    expect(releaseNotes({ repo: 'o/r', version: '0.1.0', previous: null, pulls: [] })).toBe('Maintenance release.\n');
  });
});
