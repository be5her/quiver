import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrowserWindow, Notification, app, dialog, safeStorage, shell } from 'electron';
import type { PendingApproval, SecretsApi } from '@quiver/core';
import { Host } from './host';
import { registerIpc } from './ipc';
import { runSmokeTest } from './smoke';
import { runUpdateSmoke } from './smoke-update';
import { Updater } from './updater';
import { ElectronWebSessions } from './web-sessions';
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

/** An agent's call waits for an answer while Quiver is behind other windows: a click on the notification brings it up. */
function notifyApproval(pending: PendingApproval): void {
  if (BrowserWindow.getFocusedWindow() || !Notification.isSupported()) return;
  const where = pending.workspace ? ` in ${pending.workspace.name}` : '';
  const notification = new Notification({ title: `${pending.agent.name} asks to run ${pending.title}`, body: `${pending.commandId}${where}. Open Quiver to allow or deny it.` });
  notification.on('click', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
  notification.show();
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
    // The smoke signs in against a local fake that needs no hands, so its window stays hidden.
    web: new ElectronWebSessions({ show: !process.env.QUIVER_SMOKE }),
    notifyApproval: process.env.QUIVER_SMOKE ? undefined : notifyApproval,
    // The `quiver` shims electron-builder puts beside app.asar (resources/cli in this repository).
    cliShims: app.isPackaged ? path.join(process.resourcesPath, 'cli') : undefined,
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

// Quitting waits for the host to stop (port forwards, tunnels and the processes behind them, the MCP server), at
// most QUIT_STOP_MS, then quits for real: a stop left running would end with the process, and forwards and tunnels
// on macOS and Linux lead their own process groups, so they would outlive Quiver. The smoke exits with app.exit,
// which skips this.
const QUIT_STOP_MS = 8000;
let quitStage: 'running' | 'stopping' | 'stopped' = 'running';
app.on('before-quit', (event) => {
  if (!host || quitStage === 'stopped') return;
  event.preventDefault();
  if (quitStage === 'stopping') return;
  quitStage = 'stopping';
  const stopping = host.stop().catch((err) => console.warn(`[quiver] stopping before quit failed: ${(err as Error).message}`));
  void Promise.race([stopping, new Promise((r) => setTimeout(r, QUIT_STOP_MS))]).finally(() => {
    quitStage = 'stopped';
    app.quit();
  });
});

void main().catch((err) => {
  console.error('[quiver] fatal', err);
  app.exit(1);
});
