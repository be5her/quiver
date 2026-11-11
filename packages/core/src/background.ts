/**
 * Running in the background: starting at login and staying up with no window, so agents always reach the MCP
 * server the host serves. The Electron side (login item, tray, window lifecycle) lives in src/main; the decisions
 * it makes are here, where they can be tested.
 */

/** Settings → Startup & background, per machine in the global config. */
export interface BackgroundConfig {
  /** Start Quiver hidden when the user logs in (a login item on Windows and macOS, an XDG autostart entry on Linux). */
  startAtLogin: boolean;
  /** Closing the last window leaves Quiver running in the tray; only Quit ends it. */
  keepRunning: boolean;
}

export function defaultBackgroundConfig(): BackgroundConfig {
  return { startAtLogin: false, keepRunning: false };
}

/** An older config has no section; a hand-edited one may hold something other than booleans. */
export function normalizeBackground(value: Partial<BackgroundConfig> | undefined): BackgroundConfig {
  return { startAtLogin: value?.startAtLogin === true, keepRunning: value?.keepRunning === true };
}

/** The argument the login item starts Quiver with: no window until one is asked for. */
export const HIDDEN_LAUNCH_ARG = '--hidden';

/**
 * Whether this machine can register Quiver to start at login: `supported` for an installed app, `development` for
 * a build run from a checkout (the setting is kept and applies to the installed app), `unsupported` where Quiver has
 * no way to do it.
 */
export type LoginItemSupport = 'supported' | 'development' | 'unsupported';

export function loginItemSupport(platform: string, packaged: boolean): LoginItemSupport {
  if (platform !== 'win32' && platform !== 'darwin' && platform !== 'linux') return 'unsupported';
  return packaged ? 'supported' : 'development';
}

/** What app.background.status answers: the settings and what this machine does with them. */
export interface BackgroundStatus extends BackgroundConfig {
  loginItem: LoginItemSupport;
  platform: string;
}

/**
 * Whether closing the last window quits the app. macOS keeps apps running without windows anyway, the smoke closes
 * its window itself and exits with its result, and with Keep running on only Quit ends Quiver.
 */
export function quitsWhenAllWindowsClosed(options: { platform: string; keepRunning: boolean; smoke?: boolean }): boolean {
  if (options.smoke || options.platform === 'darwin') return false;
  return !options.keepRunning;
}

/** Whether this launch should open no window: started by the login item (`--hidden`, or macOS saying it opened the app at login). */
export function launchedHidden(options: { argv: readonly string[]; wasOpenedAtLogin?: boolean }): boolean {
  return options.argv.includes(HIDDEN_LAUNCH_ARG) || options.wasOpenedAtLogin === true;
}

/** Quote a path for an XDG desktop entry's Exec key (the spec's double-quote rules). */
function quoteExec(arg: string): string {
  return /^[A-Za-z0-9_./-]+$/.test(arg) ? arg : `"${arg.replace(/(["`$\\])/g, '\\$1')}"`;
}

/** The XDG autostart entry (~/.config/autostart/quiver.desktop) that starts Quiver hidden at login on Linux. */
export function autostartDesktopEntry(executable: string): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Quiver',
    'Comment=Keep Quiver and its MCP server running for agents',
    `Exec=${quoteExec(executable)} ${HIDDEN_LAUNCH_ARG}`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n');
}
