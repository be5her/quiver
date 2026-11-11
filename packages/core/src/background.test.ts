import { describe, expect, it } from 'vitest';
import { autostartDesktopEntry, launchedHidden, loginItemSupport, normalizeBackground, quitsWhenMainWindowCloses, trayVisible } from './background';

describe('background settings', () => {
  it('defaults an older or hand-edited config to off', () => {
    expect(normalizeBackground(undefined)).toEqual({ startAtLogin: false, keepRunning: false });
    expect(normalizeBackground({ startAtLogin: 'yes' as never, keepRunning: true })).toEqual({ startAtLogin: false, keepRunning: true });
  });

  it('closing the app window quits only without Keep running, never after a hidden start, on macOS or in the smoke', () => {
    expect(quitsWhenMainWindowCloses({ platform: 'win32', keepRunning: false })).toBe(true);
    expect(quitsWhenMainWindowCloses({ platform: 'linux', keepRunning: false, startedHidden: false })).toBe(true);
    expect(quitsWhenMainWindowCloses({ platform: 'win32', keepRunning: true })).toBe(false);
    expect(quitsWhenMainWindowCloses({ platform: 'win32', keepRunning: false, startedHidden: true })).toBe(false);
    expect(quitsWhenMainWindowCloses({ platform: 'darwin', keepRunning: false })).toBe(false);
    expect(quitsWhenMainWindowCloses({ platform: 'win32', keepRunning: false, smoke: true })).toBe(false);
  });

  it('shows the tray with Keep running, after a hidden start, and whenever there is no app window', () => {
    expect(trayVisible({ keepRunning: true, startedHidden: false, windowOpen: true })).toBe(true);
    expect(trayVisible({ keepRunning: false, startedHidden: true, windowOpen: true })).toBe(true);
    expect(trayVisible({ keepRunning: false, startedHidden: false, windowOpen: false })).toBe(true);
    expect(trayVisible({ keepRunning: false, startedHidden: false, windowOpen: true })).toBe(false);
  });

  it('a launch is hidden when the login item started it', () => {
    expect(launchedHidden({ argv: ['Quiver.exe', '--hidden'] })).toBe(true);
    expect(launchedHidden({ argv: ['Quiver.exe'] })).toBe(false);
    expect(launchedHidden({ argv: ['Quiver'], wasOpenedAtLogin: true })).toBe(true);
  });

  it('registers a login item only for an installed app on a known platform', () => {
    expect(loginItemSupport('win32', true)).toBe('supported');
    expect(loginItemSupport('linux', true)).toBe('supported');
    expect(loginItemSupport('darwin', false)).toBe('development');
    expect(loginItemSupport('freebsd', true)).toBe('unsupported');
  });

  it('writes an autostart entry that starts the executable hidden, quoting a path with spaces', () => {
    expect(autostartDesktopEntry('/opt/Quiver/quiver')).toContain('\nExec=/opt/Quiver/quiver --hidden\n');
    expect(autostartDesktopEntry('/home/me/Apps/Quiver 1.2.AppImage')).toContain('\nExec="/home/me/Apps/Quiver 1.2.AppImage" --hidden\n');
  });

  it('escapes backslashes twice and percent signs in the Exec path', () => {
    expect(autostartDesktopEntry('/home/me/a\\b/50%/Quiver')).toContain('\nExec="/home/me/a\\\\\\\\b/50%%/Quiver" --hidden\n');
    expect(autostartDesktopEntry('/home/me/$HOME "x"/Quiver')).toContain('\nExec="/home/me/\\\\$HOME \\\\"x\\\\"/Quiver" --hidden\n');
  });
});
