import { BrowserWindow, app, session, type Session } from 'electron';
import type { WebResponse, WebSessionsApi } from '@quiver/core';
import { iconPath } from './window';

/** Product tokens Chromium itself sends; the rest (Electron, the app's name) are dropped. */
const BROWSER_TOKENS = new Set(['Mozilla', 'AppleWebKit', 'Chrome', 'Safari']);

/**
 * Chromium's user agent without the Electron and app tokens. Google's sign-in refuses browsers it
 * takes for an embedded web view ("This browser or app may not be secure"), and that is how it tells.
 */
export function browserUserAgent(ua: string = app.userAgentFallback): string {
  return ua.replace(/\s+([^\s/()]+)\/\S+/g, (token, name: string) => (BROWSER_TOKENS.has(name) ? token : '')).trim();
}

/**
 * Persistent sessions for services that sign in through a web page (Grafana with Google SSO).
 * Each partition is its own cookie jar under the app's data folder, so nothing lands in a project.
 * The sign-in window runs remote pages sandboxed, without the preload, and grants no permissions.
 */
export class ElectronWebSessions implements WebSessionsApi {
  private readonly sessions = new Map<string, Session>();
  private readonly pending = new Map<string, { win: BrowserWindow; outcome: Promise<boolean> }>();

  constructor(private readonly options: { show: boolean }) {}

  private get(partition: string): Session {
    let ses = this.sessions.get(partition);
    if (!ses) {
      ses = session.fromPartition(partition);
      ses.setUserAgent(browserUserAgent());
      ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
      ses.setPermissionCheckHandler(() => false);
      this.sessions.set(partition, ses);
    }
    return ses;
  }

  signIn(options: { partition: string; url: string; title: string; done(url: string): boolean | Promise<boolean> }): Promise<boolean> {
    const open = this.pending.get(options.partition);
    if (open && !open.win.isDestroyed()) {
      if (this.options.show) {
        open.win.show();
        open.win.focus();
      }
      return open.outcome;
    }

    const parent = BrowserWindow.getFocusedWindow() ?? undefined;
    const win = new BrowserWindow({
      width: 520,
      height: 720,
      title: options.title,
      show: false,
      parent,
      autoHideMenuBar: true,
      icon: process.platform === 'darwin' ? undefined : iconPath,
      webPreferences: { session: this.get(options.partition), sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false },
    });
    // The window keeps saying what it is for, whatever page is in it.
    win.on('page-title-updated', (event) => event.preventDefault());
    if (this.options.show) win.once('ready-to-show', () => win.show());

    const outcome = new Promise<boolean>((resolve, reject) => {
      let settled = false;
      let checking = false;
      let committed = false;
      const settle = (ok: boolean, error?: Error) => {
        if (settled) return;
        settled = true;
        this.pending.delete(options.partition);
        void this.get(options.partition).cookies.flushStore().catch(() => {});
        if (error) reject(error);
        else resolve(ok);
        if (!win.isDestroyed()) win.close();
      };
      const check = async (url: string) => {
        if (settled || checking) return;
        checking = true;
        try {
          if (await options.done(url)) settle(true);
        } catch {
          // Not there yet; the next page that loads is checked again.
        } finally {
          checking = false;
        }
      };

      win.on('closed', () => settle(false));
      // Identity providers sometimes open a popup; it loads in this window instead, and only over http(s).
      win.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:/i.test(url)) void win.loadURL(url);
        return { action: 'deny' };
      });
      win.webContents.on('will-navigate', (event, url) => {
        if (!/^https?:/i.test(url)) event.preventDefault();
      });
      win.webContents.on('did-navigate', (_event, url) => {
        committed = true;
        void check(url);
      });
      win.webContents.on('did-navigate-in-page', (_event, url, isMainFrame) => isMainFrame && void check(url));
      win.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
        // Only an address that never loads is an error; -3 is an aborted load, which redirects produce.
        if (isMainFrame && !committed && code !== -3) settle(false, new Error(`Could not open ${url}: ${description}`));
      });
      void win.loadURL(options.url).catch(() => {});
    });
    this.pending.set(options.partition, { win, outcome });
    return outcome;
  }

  async fetch(partition: string, url: string, init: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number } = {}): Promise<WebResponse> {
    const controller = new AbortController();
    const timeoutMs = init.timeoutMs ?? 60_000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await this.get(partition).fetch(url, { method: init.method ?? 'GET', headers: init.headers, body: init.body, signal: controller.signal });
      return { status: res.status, headers: Object.fromEntries(res.headers), text: await res.text() };
    } catch (err) {
      if (controller.signal.aborted) throw new Error(`${url} did not answer within ${Math.round(timeoutMs / 1000)} s`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async cookie(partition: string, url: string, name: string): Promise<string | null> {
    const [found] = await this.get(partition).cookies.get({ url, name });
    return found?.value ?? null;
  }

  async clear(partition: string): Promise<void> {
    const open = this.pending.get(partition);
    if (open && !open.win.isDestroyed()) open.win.close();
    const ses = this.get(partition);
    await ses.clearStorageData();
    await ses.clearCache();
    await ses.clearAuthCache();
  }
}
