import type { LoginItemDriver } from '../background';

/** What the smoke's login item stub was asked to do, in order. The smoke never registers a real login item. */
export const loginItemCalls: ({ kind: 'settings'; openAtLogin: boolean; args: string[] } | { kind: 'autostart'; entry: string | null })[] = [];

/** Stands in for app.setLoginItemSettings and the Linux autostart file, as an installed app on this platform. */
export function fakeLoginItemDriver(): LoginItemDriver {
  let registered = false;
  let autostart: string | null = null;
  return {
    platform: process.platform,
    packaged: true,
    executable: '/opt/Quiver/quiver',
    setLoginItemSettings: (settings) => {
      registered = settings.openAtLogin;
      loginItemCalls.push({ kind: 'settings', ...settings });
    },
    loginItemRegistered: () => registered,
    writeAutostart: async (entry) => {
      autostart = entry;
      loginItemCalls.push({ kind: 'autostart', entry });
    },
    readAutostart: async () => autostart,
  };
}
