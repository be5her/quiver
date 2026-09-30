import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrowserWindow, app, dialog, safeStorage, shell } from 'electron';
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
if (process.env.QUIVER_SMOKE) {
  // The smoke's UI checks need a window that keeps painting: Chromium stops drawing one that other windows cover,
  // and then screenshots go stale and wheel and drag input is never delivered.
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
}

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

async function pickSavePath(options: { title?: string; filters?: { name: string; extensions: string[] }[]; defaultPath?: string } = {}): Promise<string | undefined> {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const result = await dialog.showSaveDialog(win, { title: options.title, filters: options.filters, defaultPath: options.defaultPath });
  return result.canceled ? undefined : result.filePath;
}

async function revealFolder(folder: string): Promise<void> {
  const error = await shell.openPath(folder);
  if (error) throw new Error(error);
}

let host: Host | null = null;

async function main(): Promise<void> {
  // Smoke runs must never touch the real user configuration or recent workspaces.
  if (process.env.QUIVER_SMOKE) {
    app.setPath('userData', await fs.mkdtemp(path.join(os.tmpdir(), 'quiver-smoke-userdata-')));
  }
  await app.whenReady();

  // The smoke test checks the "no updater" path; with QUIVER_UPDATE_FEED it drives the real one against a local feed instead.
  const updates =
    process.env.QUIVER_SMOKE && !process.env.QUIVER_UPDATE_FEED
      ? undefined
      : new Updater({
          version: app.getVersion(),
          channel: () => host?.api.config.get().updates.channel ?? 'stable',
          emit: (state) => broadcast({ event: 'app.update', payload: state }),
        });
  host = new Host({
    userDataDir: app.getPath('userData'),
    version: app.getVersion(),
    secrets: makeSecrets(),
    broadcast,
    pickFolder,
    pickFile,
    pickSavePath,
    revealFolder: process.env.QUIVER_SMOKE ? undefined : revealFolder,
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

  // Look for a newer release shortly after launch, then every six hours, or every hour on the beta
  // channel so a merged change reaches testers soon. Nothing is downloaded until asked.
  if (updates?.state().supported) {
    const hour = 60 * 60 * 1000;
    let lastCheck = Date.now();
    setTimeout(() => void updates.check('auto'), 10_000);
    setInterval(() => {
      const state = updates.state();
      if (!(state.betaSupported && state.channel === 'beta') && Date.now() - lastCheck < 6 * hour - 60_000) return;
      lastCheck = Date.now();
      void updates.check('auto');
    }, hour);
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
