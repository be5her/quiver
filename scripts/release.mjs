/**
 * Cuts a release: bumps package.json, commits "Release vX.Y.Z", tags vX.Y.Z and pushes master
 * with the tag. GitHub Actions (.github/workflows/release.yml) then builds the installers for
 * Windows, macOS and Linux into a draft release for you to publish.
 *
 *   npm run release -- patch|minor|major|<x.y.z>
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const REPO = 'https://github.com/be5her/quiver';
const bump = process.argv[2];
if (!bump || !/^(patch|minor|major|\d+\.\d+\.\d+)$/.test(bump)) {
  console.error('usage: npm run release -- patch|minor|major|<x.y.z>');
  process.exit(2);
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const fail = (message) => {
  console.error(`release: ${message}`);
  process.exit(1);
};

if (git('rev-parse', '--abbrev-ref', 'HEAD') !== 'master') fail('switch to master first; releases are cut from the default branch');
if (git('status', '--porcelain')) fail('the working tree has uncommitted changes');
git('fetch', '-q', 'origin', 'master', '--tags');
if (git('rev-parse', 'HEAD') !== git('rev-parse', 'origin/master')) fail('master differs from origin/master; pull or push first');

execFileSync('npm', ['version', bump, '-m', 'Release v%s'], { stdio: 'inherit', shell: process.platform === 'win32' });
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
git('push', 'origin', 'master', `refs/tags/v${version}`);

console.log(`
Pushed v${version}.
  Build:   ${REPO}/actions/workflows/release.yml
  Publish: ${REPO}/releases/tag/v${version}  (a draft until you publish it)
`);
