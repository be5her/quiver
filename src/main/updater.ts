import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import { QuiverError, type UpdateState, type UpdatesApi } from '@quiver/core';

export const RELEASES_URL = 'https://github.com/be5her/quiver/releases';

/**
 * Flip to true once macOS builds are signed and notarized. Squirrel.Mac refuses to replace an
 * unsigned app, so until then macOS copies only announce new versions and link to the download.
 */
const MAC_SIGNED = false;

export interface UpdaterOptions {
  version: string;
  emit(state: UpdateState): void;
}

interface Support {
  supported: boolean;
  installable: boolean;
  reason?: string;
}

function support(): Support {
  // QUIVER_UPDATE_FEED points the updater at any server that serves electron-builder's latest*.yml (used by the packaged smoke run).
  if (process.env.QUIVER_UPDATE_FEED) return { supported: true, installable: process.platform !== 'darwin' || MAC_SIGNED };
  if (!app.isPackaged) return { supported: false, installable: false, reason: 'Updates are only checked in installed builds.' };
  if (process.platform === 'darwin' && !MAC_SIGNED) {
    return { supported: true, installable: false, reason: 'This macOS build is not signed, so it cannot replace itself. New versions are announced here; download them from GitHub.' };
  }
  if (process.platform === 'linux' && !process.env.APPIMAGE) {
    return { supported: true, installable: false, reason: 'Installed from a package, which Quiver does not replace itself. New versions are announced here; download them from GitHub.' };
  }
  return { supported: true, installable: true };
}

function describe(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/404|latest(-\w+)?\.yml|No published versions/i.test(message)) return 'No release found on GitHub yet.';
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|net::ERR|EAI_AGAIN/i.test(message)) return 'Could not reach GitHub to check for updates.';
  return message.length > 240 ? `${message.slice(0, 240)}…` : message;
}

/**
 * In-app updates through electron-updater, fed by the GitHub release that electron-builder
 * publishes (the `latest*.yml` manifests next to the installers). Nothing is downloaded until
 * asked: check, then download, then restart. A downloaded update is also applied on the next quit.
 */
export class Updater implements UpdatesApi {
  private current: UpdateState;
  private pending: Promise<UpdateState> | null = null;

  constructor(private readonly opts: UpdaterOptions) {
    const s = support();
    this.current = { supported: s.supported, installable: s.installable, reason: s.reason, current: opts.version, status: 'idle', url: RELEASES_URL };
    if (s.supported) this.attach();
  }

  state(): UpdateState {
    return this.current;
  }

  private set(patch: Partial<UpdateState>): void {
    this.current = { ...this.current, ...patch };
    this.opts.emit(this.current);
  }

  private attach(): void {
    autoUpdater.autoDownload = false;
    // A downloaded update is applied when the app quits, except in smoke runs, which must never install anything.
    autoUpdater.autoInstallOnAppQuit = !process.env.QUIVER_SMOKE;
    autoUpdater.logger = {
      info: (m: unknown) => console.log('[quiver:update]', m),
      warn: (m: unknown) => console.warn('[quiver:update]', m),
      error: (m: unknown) => console.error('[quiver:update]', m),
      debug: () => {},
    };
    const feed = process.env.QUIVER_UPDATE_FEED;
    if (feed) {
      autoUpdater.forceDevUpdateConfig = true;
      autoUpdater.setFeedURL({ provider: 'generic', url: feed });
    }
    autoUpdater.on('download-progress', (p) => {
      this.set({ status: 'downloading', progress: { percent: Math.round(p.percent), transferred: p.transferred, total: p.total, bytesPerSecond: Math.round(p.bytesPerSecond) } });
    });
    autoUpdater.on('update-downloaded', (info) => this.set({ status: 'downloaded', version: info.version, progress: undefined }));
    autoUpdater.on('error', (err) => {
      // Errors during a check or download surface through their promises; this catches the rest (e.g. the install on quit).
      if (!this.pending) this.set({ status: 'error', error: describe(err), progress: undefined });
    });
  }

  async check(trigger: 'manual' | 'auto' = 'manual'): Promise<UpdateState> {
    if (!this.current.supported) return this.current;
    if (this.pending) return this.pending;
    if (this.current.status === 'downloading' || this.current.status === 'downloaded') return this.current;
    this.pending = (async () => {
      this.set({ status: 'checking', trigger, error: undefined });
      try {
        const result = await autoUpdater.checkForUpdates();
        const checkedAt = new Date().toISOString();
        if (result?.isUpdateAvailable) {
          const info = result.updateInfo;
          this.set({ status: 'available', version: info.version, releaseDate: info.releaseDate, url: `${RELEASES_URL}/tag/v${info.version}`, checkedAt });
        } else {
          this.set({ status: 'none', version: undefined, releaseDate: undefined, url: RELEASES_URL, checkedAt });
        }
      } catch (err) {
        this.set({ status: 'error', error: describe(err), checkedAt: new Date().toISOString() });
      } finally {
        this.pending = null;
      }
      return this.current;
    })();
    return this.pending;
  }

  async download(): Promise<UpdateState> {
    if (!this.current.supported) throw new QuiverError('INVALID_INPUT', this.current.reason ?? 'Updates are not available in this build.');
    if (!this.current.installable) throw new QuiverError('INVALID_INPUT', `${this.current.reason ?? 'This build cannot replace itself.'} ${this.current.url ?? RELEASES_URL}`);
    if (this.current.status === 'downloading' || this.current.status === 'downloaded') return this.pending ?? this.current;
    if (this.current.status !== 'available') {
      const after = await this.check('manual');
      if (after.status !== 'available') return after;
    }
    this.pending = (async () => {
      this.set({ status: 'downloading', progress: { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 }, error: undefined });
      try {
        await autoUpdater.downloadUpdate();
        if (this.current.status !== 'downloaded') this.set({ status: 'downloaded', progress: undefined });
      } catch (err) {
        this.set({ status: 'error', error: describe(err), progress: undefined });
      } finally {
        this.pending = null;
      }
      return this.current;
    })();
    return this.pending;
  }

  async install(): Promise<void> {
    if (this.current.status !== 'downloaded') throw new QuiverError('INVALID_INPUT', 'No update has been downloaded yet.');
    // Let the command's reply reach the caller before the app goes away.
    setTimeout(() => autoUpdater.quitAndInstall(true, true), 300);
  }
}
