// `npm run dev`: the Angular dev server for the renderer, then electron-vite for the main process and
// the preload, with Electron pointed at the dev server. Closing the app stops both.
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'package.json'));
const port = Number(process.env.QUIVER_RENDERER_PORT ?? 4200);
const url = `http://localhost:${port}`;

const ng = require.resolve('@angular/cli/bin/ng.js');
const electronVite = path.join(path.dirname(require.resolve('electron-vite/package.json')), 'bin', 'electron-vite.js');

const children = new Set();
function run(script, args, options) {
  const child = spawn(process.execPath, [script, ...args], { stdio: 'inherit', ...options });
  children.add(child);
  child.on('exit', () => children.delete(child));
  return child;
}

// Child processes of the dev server outlive a plain kill on Windows, so take down the whole tree.
function stopAll() {
  for (const child of children) {
    if (child.exitCode !== null) continue;
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
    else child.kill('SIGTERM');
  }
}

async function waitForServer(deadline) {
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

const server = run(ng, ['serve', '--port', String(port)], { cwd: path.join(root, 'src', 'renderer') });
server.on('exit', (code) => {
  if (code) {
    stopAll();
    process.exit(code);
  }
});

if (!(await waitForServer(Date.now() + 120_000))) {
  console.error(`[dev] the renderer dev server did not answer on ${url}`);
  stopAll();
  process.exit(1);
}

const app = run(electronVite, ['dev'], { cwd: root, env: { ...process.env, ELECTRON_RENDERER_URL: url } });
app.on('exit', (code) => {
  stopAll();
  process.exit(code ?? 0);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopAll();
    process.exit(130);
  });
}
