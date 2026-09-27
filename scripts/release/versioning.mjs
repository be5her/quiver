/**
 * Version arithmetic for the two release lines, kept free of git and GitHub calls so it is unit
 * tested (versioning.test.ts). scripts/release/plan.mjs feeds it the tags and pull requests.
 *
 *   beta    every push to main       X.Y.(Z+1)-beta.N  after the last stable X.Y.Z, N = commits since it
 *   stable  every merge into stable  the last stable bumped by the largest change merged since it
 */

/** @typedef {'major' | 'minor' | 'patch'} Level */
/** @typedef {{ number: number, title: string, labels: string[], headRef?: string, url?: string }} Pull */

const LEVELS = /** @type {const} */ (['patch', 'minor', 'major']);
const OVERRIDE = /^release:(major|minor|patch)$/;

/** Parses `1.2.3`, `v1.2.3` or `1.2.3-beta.4`; null for anything else. */
export function parseVersion(text) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(text).trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), prerelease: m[4] ?? null };
}

function compare(a, b) {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

const format = (v) => `${v.major}.${v.minor}.${v.patch}`;

/** The highest `vX.Y.Z` tag without a prerelease part, as `X.Y.Z`; null when there is none. */
export function latestStable(tags) {
  const stable = tags
    .filter((tag) => tag.startsWith('v'))
    .map(parseVersion)
    .filter((v) => v && v.prerelease === null)
    .sort(compare);
  return stable.length ? format(stable[stable.length - 1]) : null;
}

/**
 * The beta after `stable`: the next patch with a build number, so it sorts above `stable` and below
 * whatever stable release comes next, whichever part that one bumps.
 */
export function betaVersion(stable, build) {
  const v = parseVersion(stable ?? '0.0.0');
  if (!v || v.prerelease !== null) throw new Error(`not a stable version: ${stable}`);
  if (!Number.isInteger(build) || build < 1) throw new Error(`the build number must be a positive integer, got ${build}`);
  return `${v.major}.${v.minor}.${v.patch + 1}-beta.${build}`;
}

/**
 * How much one merged pull request asks for. Labels come first (the same ones that group the
 * release notes); branch names (`feat/…`) and conventional titles (`feat: …`, `fix!: …`) back
 * them up for pull requests nobody labelled.
 * @param {Pull} pull
 * @returns {Level}
 */
export function pullLevel(pull) {
  const labels = new Set(pull.labels.map((l) => l.toLowerCase()));
  const conventional = /^(\w+)(\([^)]*\))?(!)?:/.exec(pull.title.trim());
  if (labels.has('breaking') || conventional?.[3]) return 'major';
  if (labels.has('enhancement') || labels.has('design')) return 'minor';
  if (/^feat(ure)?\//.test(pull.headRef ?? '') || conventional?.[1].toLowerCase() === 'feat') return 'minor';
  return 'patch';
}

/**
 * The bump for a stable release. A `release:major|minor|patch` label on the pull request into
 * stable decides outright. Otherwise the largest pull request wins; while the version is 0.x a
 * breaking change bumps the minor part, as semver suggests before 1.0 (label the release
 * `release:major` to go to 1.0.0).
 * @param {string | null} current the last stable version
 * @param {Pull[]} pulls merged since it
 * @param {string[]} releaseLabels labels of the pull request into stable
 * @returns {{ level: Level, reason: string }}
 */
export function releaseLevel(current, pulls, releaseLabels = []) {
  const override = releaseLabels.map((l) => OVERRIDE.exec(l.toLowerCase())).find(Boolean);
  if (override) return { level: /** @type {Level} */ (override[1]), reason: `label ${override[0]} on the release pull request` };
  if (!pulls.length) return { level: 'patch', reason: 'no pull requests found since the last release' };
  let best = pulls[0];
  for (const pull of pulls) if (LEVELS.indexOf(pullLevel(pull)) > LEVELS.indexOf(pullLevel(best))) best = pull;
  const level = pullLevel(best);
  const which = best.number ? `#${best.number} ${best.title}` : best.title;
  if (level === 'major' && (parseVersion(current ?? '0.0.0')?.major ?? 0) === 0) {
    return { level: 'minor', reason: `breaking change in ${which}; 0.x releases bump the minor part (label release:major for 1.0.0)` };
  }
  const why = { major: 'breaking change', minor: 'new feature', patch: 'fixes and chores only' }[level];
  return { level, reason: level === 'patch' ? why : `${why} in ${which}` };
}

/** `1.2.3` bumped by `level`. */
export function bump(version, level) {
  const v = parseVersion(version ?? '0.0.0');
  if (!v) throw new Error(`not a version: ${version}`);
  if (level === 'major') return `${v.major + 1}.0.0`;
  if (level === 'minor') return `${v.major}.${v.minor + 1}.0`;
  return `${v.major}.${v.minor}.${v.patch + 1}`;
}

/** Sections in order; a pull request goes into the first whose label it carries. */
const SECTIONS = [
  { title: 'Breaking changes', labels: ['breaking'] },
  { title: 'New', labels: ['enhancement'] },
  { title: 'Look and feel', labels: ['design'] },
  { title: 'Fixes', labels: ['bug'] },
  { title: 'Documentation', labels: ['documentation'] },
];

/**
 * Release notes for a stable release: the merged pull requests grouped by label, `skip-changelog`
 * left out, and a compare link to the previous release.
 * @param {{ repo: string, version: string, previous: string | null, pulls: Pull[] }} input
 */
export function releaseNotes({ repo, version, previous, pulls }) {
  const groups = new Map();
  for (const pull of pulls) {
    const labels = pull.labels.map((l) => l.toLowerCase());
    if (labels.includes('skip-changelog')) continue;
    const section = SECTIONS.find((s) => s.labels.some((l) => labels.includes(l)))?.title ?? 'Other changes';
    if (!groups.has(section)) groups.set(section, []);
    groups.get(section).push(pull.number ? `- ${pull.title} (#${pull.number})` : `- ${pull.title}`);
  }
  const lines = [];
  for (const title of [...SECTIONS.map((s) => s.title), 'Other changes']) {
    if (!groups.has(title)) continue;
    lines.push(`### ${title}`, '', ...groups.get(title), '');
  }
  if (!lines.length) lines.push('Maintenance release.', '');
  if (previous) lines.push(`**Full changelog**: https://github.com/${repo}/compare/v${previous}...v${version}`);
  return `${lines.join('\n').trim()}\n`;
}
