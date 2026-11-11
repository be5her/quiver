import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';
import { HIDDEN_LAUNCH_ARG, autostartDesktopEntry, loginItemSupport, type LoginItemSupport } from '@quiver/core';
import type { BackgroundApi } from './host';

/** The machine calls behind starting at login, so the smoke can put a recorder in their place. */
export interface LoginItemDriver {
  platform: string;
  packaged: boolean;
  /** Windows and macOS: Electron's app.setLoginItemSettings. */
  setLoginItemSettings(settings: { openAtLogin: boolean; args: string[] }): void;
  /** Windows and macOS: whether a login item starting this executable with `args` is registered (app.getLoginItemSettings). */
  loginItemRegistered(args: string[]): boolean;
  /** Linux: the file the autostart entry starts (the AppImage when Quiver runs from one). */
  executable: string;
  /** Linux: writes the XDG autostart entry, or removes it when `entry` is null. */
  writeAutostart(entry: string | null): Promise<void>;
  /** Linux: the autostart entry as it is on disk, null when there is none. */
  readAutostart(): Promise<string | null>;
}

/** Start at login: a login item on Windows and macOS, an XDG autostart entry on Linux, only for an installed app. */
export class LoginItems implements BackgroundApi {
  readonly loginItem: LoginItemSupport;

  constructor(private readonly driver: LoginItemDriver) {
    this.loginItem = loginItemSupport(driver.platform, driver.packaged);
  }

  async setStartAtLogin(enabled: boolean): Promise<void> {
    if (this.loginItem !== 'supported') return;
    if (this.driver.platform === 'linux') await this.driver.writeAutostart(enabled ? autostartDesktopEntry(this.driver.executable) : null);
    else this.driver.setLoginItemSettings({ openAtLogin: enabled, args: [HIDDEN_LAUNCH_ARG] });
  }

  /**
   * At each start of an installed app: make the machine match the setting both ways (a login item left from when it
   * was on, turned off from a development build that cannot touch it, is removed; one missing after an update moved
   * the executable is added), but write nothing when it already matches. On Windows every write also re-approves the
   * entry, which would undo the user turning Quiver off under Task Manager's startup apps.
   */
  async sync(enabled: boolean): Promise<void> {
    if (this.loginItem !== 'supported') return;
    if (this.driver.platform === 'linux') {
      const want = enabled ? autostartDesktopEntry(this.driver.executable) : null;
      if ((await this.driver.readAutostart()) !== want) await this.driver.writeAutostart(want);
      return;
    }
    if (this.driver.loginItemRegistered([HIDDEN_LAUNCH_ARG]) !== enabled) this.driver.setLoginItemSettings({ openAtLogin: enabled, args: [HIDDEN_LAUNCH_ARG] });
  }
}

/** ~/.config/autostart/quiver.desktop, or under XDG_CONFIG_HOME when set. */
export function xdgAutostartFile(): string {
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(configHome, 'autostart', 'quiver.desktop');
}

/** The real calls. */
export function electronLoginItemDriver(): LoginItemDriver {
  return {
    platform: process.platform,
    packaged: app.isPackaged,
    setLoginItemSettings: (settings) => app.setLoginItemSettings(settings),
    loginItemRegistered: (args) => app.getLoginItemSettings({ args }).openAtLogin,
    executable: process.env.APPIMAGE || process.execPath,
    writeAutostart: async (entry) => {
      const file = xdgAutostartFile();
      if (entry === null) {
        await fs.rm(file, { force: true });
        return;
      }
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, entry, 'utf8');
    },
    readAutostart: () => fs.readFile(xdgAutostartFile(), 'utf8').catch(() => null),
  };
}
