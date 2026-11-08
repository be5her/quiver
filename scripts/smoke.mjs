// `npm run smoke`: builds, then runs the headless end-to-end check in src/main/smoke and exits with its result.
//
//   npm run smoke                       every part, after a full build (what CI runs, and the run before a commit)
//   npm run smoke -- db teleport        only those parts, plus the core they all share
//   npm run smoke -- --skip logs,mcp    every part but those
//   npm run smoke -- db --shots         with the UI checks, screenshots in out/smoke-shots (or --shots <dir>)
//   npm run smoke -- --list             the parts and what each covers
//
// A run that names parts rebuilds the renderer only when its sources changed since the last build; a full run always
// rebuilds everything. QUIVER_SMOKE_PARTS, QUIVER_SMOKE_SKIP and QUIVER_SMOKE_SHOTS work too, for running Electron
// directly (QUIVER_SMOKE=1 electron .).
import { spawn, spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'package.json'));
const partsDir = path.join(root, 'src', 'main', 'smoke', 'parts');

/** The parts are the files in src/main/smoke/parts, in the order the runner lists them (PARTS in src/main/smoke/index.ts). */
const order = /PARTS: SmokePart\[\] = \[([^\]]*)\]/.exec(readFileSync(path.join(root, 'src', 'main', 'smoke', 'index.ts'), 'utf8'))?.[1].split(/[\s,]+/) ?? [];
const known = readdirSync(partsDir)
  .filter((f) => f.endsWith('.ts'))
  .map((f) => {
    const source = readFileSync(path.join(partsDir, f), 'utf8');
    return { name: f.slice(0, -3), summary: /summary: '([^']*)'/.exec(source)?.[1] ?? '' };
  })
  .sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
const isPart = (name) => known.some((p) => p.name === name);
const list = (value) => (value ?? '').split(/[\s,]+/).filter(Boolean);

const args = process.argv.slice(2);
const only = [];
const skip = [];
let shots = process.env.QUIVER_SMOKE_SHOTS;
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  const [flag, inline] = arg.split(/=(.*)/s);
  const value = () => inline ?? args[++i];
  if (arg === '--list' || arg === '-l') {
    for (const p of known) console.log(`${p.name.padEnd(9)} ${p.summary}`);
    process.exit(0);
  } else if (flag === '--skip') skip.push(...list(value()));
  else if (flag === '--shots') {
    // A bare --shots (followed by nothing, a flag or a part name) uses out/smoke-shots.
    const next = inline ?? args[i + 1];
    if (inline === undefined && (next === undefined || next.startsWith('-') || isPart(next))) shots = path.join(root, 'out', 'smoke-shots');
    else shots = path.resolve(value());
  } else if (arg.startsWith('-')) fail(`unknown option ${arg}`);
  else only.push(...list(arg));
}
if (!only.length) only.push(...list(process.env.QUIVER_SMOKE_PARTS));
if (!skip.length) skip.push(...list(process.env.QUIVER_SMOKE_SKIP));
const unknown = [...only, ...skip].filter((n) => !isPart(n));
if (unknown.length) fail(`unknown part ${unknown.join(', ')}; the parts are ${known.map((p) => p.name).join(', ')}`);
const full = only.length === 0 && skip.length === 0;

function fail(message) {
  console.error(`[smoke] ${message}`);
  process.exit(1);
}

function step(label, script, scriptArgs, cwd) {
  const started = Date.now();
  const result = spawnSync(process.execPath, [script, ...scriptArgs], { cwd, stdio: 'inherit' });
  if (result.status !== 0) fail(`${label} failed`);
  console.log(`[smoke] ${label}: ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

/** Newest modification time under a folder, leaving out dependencies, build caches and docs. */
function newest(dir) {
  let latest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.angular' || entry.name === 'dist') continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) latest = Math.max(latest, newest(file));
    else if (!entry.name.endsWith('.md')) latest = Math.max(latest, statSync(file).mtimeMs);
  }
  return latest;
}

/** Whether the renderer build is older than anything it is built from: its own sources and the packages it imports. */
function rendererStale() {
  let built;
  try {
    built = statSync(path.join(root, 'out', 'renderer', 'index.html')).mtimeMs;
  } catch {
    return true;
  }
  const inputs = [path.join(root, 'src', 'renderer'), path.join(root, 'packages')].map(newest);
  const files = ['package-lock.json', 'tsconfig.base.json'].map((f) => statSync(path.join(root, f)).mtimeMs);
  return Math.max(...inputs, ...files) > built;
}

const electronVite = path.join(path.dirname(require.resolve('electron-vite/package.json')), 'bin', 'electron-vite.js');
step('main and preload build', electronVite, ['build'], root);
if (full || rendererStale()) step('renderer build', require.resolve('@angular/cli/bin/ng.js'), ['build'], path.join(root, 'src', 'renderer'));
else console.log('[smoke] renderer build: skipped, nothing it is built from changed since the last build');

const env = { ...process.env, QUIVER_SMOKE: '1', QUIVER_SMOKE_PARTS: only.join(','), QUIVER_SMOKE_SKIP: skip.join(',') };
if (shots) env.QUIVER_SMOKE_SHOTS = shots;
else delete env.QUIVER_SMOKE_SHOTS;
if (shots) console.log(`[smoke] screenshots: ${shots}`);
const electron = spawn(require('electron'), ['.'], { cwd: root, stdio: 'inherit', env });
electron.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
