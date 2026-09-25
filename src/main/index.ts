import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrowserWindow, app, dialog, safeStorage } from 'electron';
import type { SecretsApi } from '@quiver/core';
import { Host } from './host';
import { registerIpc } from './ipc';
import { runSmokeTest } from './smoke';
import { runUpdateSmoke } from './smoke-update';
import { Updater } from './updater';
import { createMainWindow } from './window';

process.env.QUIVER_VERSION = app.getVersion();
// Windows groups taskbar entries and notifications by this id; the installer gives the shortcut the same one.
app.setAppUserModelId('dev.quiver.app');

function makeSecrets(): SecretsApi {
  const available = safeStorage.isEncryptionAvailable();
  return {
    available,
    encrypt: (plain) => (available ? `enc:${safeStorage.encryptString(plain).toString('base64')}` : `plain:${plain}`),
    decrypt: (cipher) => {
      if (cipher.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(cipher.slice(4), 'base64'));
      if (cipher.startsWith('plain:')) return cipher.slice(6);
      return cipher;
    },
  };
}

function broadcast(message: { event: string; payload: unknown }): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('quiver:event', message);
  }
}

async function pickFolder(): Promise<string | undefined> {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const result = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], title: 'Open project folder' });
  return result.canceled ? undefined : result.filePaths[0];
}

async function pickFile(options: { title?: string; filters?: { name: string; extensions: string[] }[]; defaultPath?: string } = {}): Promise<string | undefined> {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const result = await dialog.showOpenDialog(win, {
    properties: ['openFile', 'promptToCreate'],
    title: options.title ?? 'Pick a file',
    filters: options.filters,
    defaultPath: options.defaultPath,
  });
  return result.canceled ? undefined : result.filePaths[0];
}

let host: Host | null = null;

async function main(): Promise<void> {
  // Smoke runs must never touch the real user configuration or recent workspaces.
  if (process.env.QUIVER_SMOKE) {
    app.setPath('userData', await fs.mkdtemp(path.join(os.tmpdir(), 'quiver-smoke-userdata-')));
  }
  await app.whenReady();

  // The smoke test checks the "no updater" path; with QUIVER_UPDATE_FEED it drives the real one against a local feed instead.
  const updates = process.env.QUIVER_SMOKE && !process.env.QUIVER_UPDATE_FEED ? undefined : new Updater({ version: app.getVersion(), emit: (state) => broadcast({ event: 'app.update', payload: state }) });
  host = new Host({
    userDataDir: app.getPath('userData'),
    version: app.getVersion(),
    secrets: makeSecrets(),
    broadcast,
    pickFolder,
    pickFile,
    updates,
  });
  registerIpc(host);
  await host.start();

  if (process.env.QUIVER_SMOKE) {
    const code =
      updates && process.env.QUIVER_UPDATE_FEED ? await runUpdateSmoke(updates) : await runSmokeTest(host, () => createMainWindow({ show: Boolean(process.env.QUIVER_SMOKE_SHOTS) }));
    await host.stop();
    await fs.rm(app.getPath('userData'), { recursive: true, force: true }).catch(() => {});
    // Piped stdout is asynchronous on Windows; give the final summary line a moment to leave the process.
    await new Promise((r) => setTimeout(r, 150));
    app.exit(code);
    return;
  }

  createMainWindow();

  // Look for a newer release shortly after launch and every six hours; nothing is downloaded until asked.
  if (updates?.state().supported) {
    setTimeout(() => void updates.check('auto'), 10_000);
    setInterval(() => void updates.check('auto'), 6 * 60 * 60 * 1000);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
}

app.on('window-all-closed', () => {
  // Smoke mode destroys its window itself and exits with the check result, not 0.
  if (process.platform !== 'darwin' && !process.env.QUIVER_SMOKE) app.quit();
});

app.on('before-quit', () => {
  void host?.stop();
});

void main().catch((err) => {
  console.error('[quiver] fatal', err);
  app.exit(1);
});
