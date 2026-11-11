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
  /** Linux: the file the autostart entry starts (the AppImage when Quiver runs from one). */
  executable: string;
  /** Linux: writes the XDG autostart entry, or removes it when `entry` is null. */
  writeAutostart(entry: string | null): Promise<void>;
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
  };
}
