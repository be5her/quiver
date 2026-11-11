import { describe, expect, it } from 'vitest';
import { autostartDesktopEntry, launchedHidden, loginItemSupport, normalizeBackground, quitsWhenAllWindowsClosed } from './background';

describe('background settings', () => {
  it('defaults an older or hand-edited config to off', () => {
    expect(normalizeBackground(undefined)).toEqual({ startAtLogin: false, keepRunning: false });
    expect(normalizeBackground({ startAtLogin: 'yes' as never, keepRunning: true })).toEqual({ startAtLogin: false, keepRunning: true });
  });

  it('closing the last window quits only without Keep running, and never on macOS or in the smoke', () => {
    expect(quitsWhenAllWindowsClosed({ platform: 'win32', keepRunning: false })).toBe(true);
    expect(quitsWhenAllWindowsClosed({ platform: 'linux', keepRunning: false })).toBe(true);
    expect(quitsWhenAllWindowsClosed({ platform: 'win32', keepRunning: true })).toBe(false);
    expect(quitsWhenAllWindowsClosed({ platform: 'darwin', keepRunning: false })).toBe(false);
    expect(quitsWhenAllWindowsClosed({ platform: 'win32', keepRunning: false, smoke: true })).toBe(false);
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
});
