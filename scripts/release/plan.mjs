/**
 * Works out the next release from git tags and the merged pull requests, for the Beta and Stable
 * workflows (.github/workflows/beta.yml, stable.yml). Needs the full history with tags; the stable
 * plan also needs the GitHub CLI (`gh`, with GH_TOKEN in Actions) to read pull request labels.
 *
 *   node scripts/release/plan.mjs beta   [--ref <commit>]
 *   node scripts/release/plan.mjs stable [--ref <commit>] [--pr <number>] [--notes <file>] [--summary <file>]
 *
 * Prints the plan, and in Actions also writes version, tag, previous (and level, released) to
 * GITHUB_OUTPUT. `npm run release:plan` runs the stable plan on the current checkout as a preview.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { betaVersion, bump, latestStable, parseVersion, releaseLevel, releaseNotes } from './versioning.mjs';

const [mode, ...rest] = process.argv.slice(2);
const args = {};
for (let i = 0; i < rest.length; i += 2) {
  if (!rest[i].startsWith('--') || rest[i + 1] === undefined) usage();
  args[rest[i].slice(2)] = rest[i + 1];
}
if (mode !== 'beta' && mode !== 'stable') usage();

function usage() {
  console.error('usage: plan.mjs beta [--ref <commit>]\n       plan.mjs stable [--ref <commit>] [--pr <number>] [--notes <file>] [--summary <file>]');
  process.exit(2);
}

const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim();
const lines = (text) => text.split('\n').filter(Boolean);

function gh(path) {
  try {
    return JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  } catch (err) {
    const detail = err.code === 'ENOENT' ? 'the GitHub CLI (gh) is not installed' : String(err.stderr || err.message).trim();
    console.error(`plan: gh api ${path} failed: ${detail}`);
    process.exit(1);
  }
}

function output(values) {
  if (!process.env.GITHUB_OUTPUT) return;
  appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(values).map(([k, v]) => `${k}=${v ?? ''}\n`).join(''));
}

function repository() {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  const m = /github\.com[/:]([^/]+\/[^/.]+?)(?:\.git)?$/.exec(git('remote', 'get-url', 'origin'));
  if (!m) throw new Error('cannot tell the GitHub repository from the origin remote; set GITHUB_REPOSITORY');
  return m[1];
}

const ref = git('rev-parse', args.ref ?? 'HEAD');
const tags = lines(git('tag', '--list', 'v*'));
if (!tags.length) console.warn('plan: no v* tags found; fetch them (fetch-depth: 0) or this is the first release');
const previous = latestStable(tags);
const since = previous ? `v${previous}..${ref}` : ref;

if (mode === 'beta') {
  const build = Number(git('rev-list', '--count', since));
  if (build < 1) {
    console.error(`plan: ${ref.slice(0, 7)} is already part of v${previous}; nothing to build`);
    process.exit(1);
  }
  const version = betaVersion(previous, build);
  output({ version, tag: `v${version}`, previous });
  console.log(`Beta ${version}: build ${build} since ${previous ? `v${previous}` : 'the first commit'}.`);
  process.exit(0);
}

// Stable. A commit that already carries a stable tag was released; re-running must not bump again.
const released = lines(git('tag', '--points-at', ref)).find((tag) => parseVersion(tag)?.prerelease === null);
if (released) {
  output({ released, version: released.slice(1), tag: released, previous });
  console.log(`${ref.slice(0, 7)} is already released as ${released}.`);
  process.exit(0);
}

const repo = repository();
const pulls = new Map();
for (const sha of lines(git('rev-list', '--no-merges', since))) {
  // Skip release pull requests (main into stable); hotfix pull requests into stable still count.
  const found = gh(`repos/${repo}/commits/${sha}/pulls`).filter((p) => p.merged_at && !(p.base.ref === 'stable' && p.head.ref === 'main'));
  if (!found.length) {
    // Pushed without a pull request: still part of the release, listed by its subject.
    pulls.set(sha, { number: 0, title: git('log', '-1', '--format=%s', sha), labels: [], headRef: '' });
  }
  for (const p of found) pulls.set(p.number, { number: p.number, title: p.title, labels: p.labels.map((l) => l.name), headRef: p.head.ref, url: p.html_url });
}
const merged = [...pulls.values()].sort((a, b) => (a.number || Infinity) - (b.number || Infinity));

const releasePull = args.pr ? gh(`repos/${repo}/pulls/${args.pr}`) : gh(`repos/${repo}/commits/${ref}/pulls`).find((p) => p.base.ref === 'stable');
const releaseLabels = releasePull?.labels.map((l) => l.name) ?? [];
// A squashed or rebased release loses main's history on stable, and the next plan would count
// everything again. Stop before publishing a wrong version.
if (!args.pr && releasePull?.head.ref === 'main' && lines(git('rev-list', '--parents', '-n', '1', ref)).join(' ').split(' ').length < 3) {
  console.error(`plan: #${releasePull.number} was not merged with a merge commit. Revert it on stable and merge the pull request from main again with "Create a merge commit".`);
  process.exit(1);
}

const { level, reason } = releaseLevel(previous, merged, releaseLabels);
const version = bump(previous, level);
const notes = releaseNotes({ repo, version, previous, pulls: merged });

output({ version, tag: `v${version}`, previous, level, released: '' });
if (args.notes) writeFileSync(args.notes, notes);
const summary = [
  `**Quiver ${version}** (${level}: ${reason}), after ${previous ? `v${previous}` : 'no earlier release'}.`,
  '',
  args.pr
    ? 'Merging this into `stable` builds Windows, macOS and Linux and publishes this as the latest release. To pick the bump yourself, label this pull request `release:major`, `release:minor` or `release:patch`.'
    : 'Builds for Windows, macOS and Linux, then publishes this as the latest release.',
  '',
  '<details><summary>Release notes</summary>',
  '',
  notes,
  '</details>',
  '',
].join('\n');
if (args.summary) writeFileSync(args.summary, summary);
console.log(summary);
