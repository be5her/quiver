// `npm run cli -- <args>`: the `quiver` command line from this checkout (docs/cli.md). Rebuilds out/main when a
// source it is built from changed since the last build, with the build's output on stderr so stdout stays the
// CLI's, then runs out/main/cli.js with this Node and passes its exit code on.
//
//   npm run cli -- list git
//   npm run cli -- todo.add --title "write the notes"
//   npm run cli -- --headless api.collection.run --collection <id> --reporter junit --out results.xml
import { spawn, spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'package.json'));
const cli = path.join(root, 'out', 'main', 'cli.js');

/** Newest modification time under a folder, leaving out dependencies, the renderer's sources and docs. */
function newest(dir) {
  let latest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'ui' || entry.name === 'renderer') continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) latest = Math.max(latest, newest(file));
    else if (!entry.name.endsWith('.md')) latest = Math.max(latest, statSync(file).mtimeMs);
  }
  return latest;
}

let built = 0;
try {
  built = statSync(cli).mtimeMs;
} catch {
  // Never built here: build now.
}
const inputs = ['src', 'packages'].map((d) => newest(path.join(root, d)));
const files = ['package-lock.json', 'electron.vite.config.ts'].map((f) => statSync(path.join(root, f)).mtimeMs);
if (Math.max(...inputs, ...files) > built) {
  const electronVite = path.join(path.dirname(require.resolve('electron-vite/package.json')), 'bin', 'electron-vite.js');
  const result = spawnSync(process.execPath, [electronVite, 'build'], { cwd: root, stdio: ['ignore', 2, 2] });
  if (result.status !== 0) {
    console.error('[cli] the build failed');
    process.exit(1);
  }
}

const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], { stdio: 'inherit' });
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
