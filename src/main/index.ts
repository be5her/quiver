import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrowserWindow, app, dialog, safeStorage } from 'electron';
import type { SecretsApi } from '@quiver/core';
import { Host } from './host';
import { registerIpc } from './ipc';
import { runSmokeTest } from './smoke';
import { createMainWindow } from './window';

process.env.QUIVER_VERSION = app.getVersion();

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

  host = new Host({
    userDataDir: app.getPath('userData'),
    version: app.getVersion(),
    secrets: makeSecrets(),
    broadcast,
    pickFolder,
    pickFile,
  });
  registerIpc(host);
  await host.start();

  if (process.env.QUIVER_SMOKE) {
    const code = await runSmokeTest(host, () => createMainWindow({ show: Boolean(process.env.QUIVER_SMOKE_SHOTS) }));
    await host.stop();
    await fs.rm(app.getPath('userData'), { recursive: true, force: true }).catch(() => {});
    // Piped stdout is asynchronous on Windows; give the final summary line a moment to leave the process.
    await new Promise((r) => setTimeout(r, 150));
    app.exit(code);
    return;
  }

  createMainWindow();

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
