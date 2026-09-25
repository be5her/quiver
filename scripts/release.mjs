/**
 * Cuts a release: bumps package.json, commits "Release vX.Y.Z", tags vX.Y.Z and pushes master
 * with the tag. GitHub Actions (.github/workflows/release.yml) then builds the installers for
 * Windows, macOS and Linux into a draft release for you to publish.
 *
 *   npm run release -- patch|minor|major|<x.y.z>
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

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

// Run npm's own CLI script with this node instead of the `npm` shim. On Windows the shim is
// npm.cmd, which needs `shell: true`, and cmd then splits the unquoted "Release v%s" message.
const npmCli = [process.env.npm_execpath, join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')]
  .find((path) => path && /npm-cli\.c?js$/.test(path) && existsSync(path));
const npm = (...args) =>
  npmCli
    ? execFileSync(process.execPath, [npmCli, ...args], { stdio: 'inherit' })
    : execFileSync('npm', args, { stdio: 'inherit' });

npm('version', bump, '-m', 'Release v%s');
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
git('push', 'origin', 'master', `refs/tags/v${version}`);

console.log(`
Pushed v${version}.
  Build:   ${REPO}/actions/workflows/release.yml
  Publish: ${REPO}/releases/tag/v${version}  (a draft until you publish it)
`);
