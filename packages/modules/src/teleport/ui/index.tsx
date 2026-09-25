import { clusterLabel, toErrorPayload, type TeleportStatus } from '@quiver/core';
import { confirmDialog, defineModuleUI, invoke, notify, promptDialog, useAppStore } from '@quiver/ui';
import { ShieldCheck } from 'lucide-react';
import { teleportLoginAgain } from '../../db/ui/shared';
import { TeleportSidebar } from './Sidebar';

/** Palette action: log in, asking which cluster when several are known. */
async function loginFromPalette(): Promise<void> {
  try {
    const status = await invoke<TeleportStatus>('teleport.status', {}, null);
    let proxy: string | undefined;
    if (status.clusters.length > 1) {
      const preferred = status.clusters.find((c) => c.state === 'expired' || c.state === 'logged-out') ?? status.clusters[0];
      const picked = await promptDialog({
        title: 'Log in to which cluster?',
        label: status.clusters.map((c) => `${clusterLabel(c)} (${c.proxy})`).join(', '),
        defaultValue: preferred.proxy,
        confirmLabel: 'Log in',
      });
      if (!picked?.trim()) return;
      proxy = picked.trim();
    }
    await teleportLoginAgain(proxy);
  } catch (err) {
    notify(toErrorPayload(err).message, 'error');
  }
}

async function logoutFromPalette(): Promise<void> {
  if (!(await confirmDialog({ title: 'Log out of every Teleport cluster?', message: 'This also logs out tsh and kubectl in your terminal and stops all tunnels.', confirmLabel: 'Log out', danger: true }))) return;
  try {
    await invoke('teleport.logout', {}, null);
    notify('Logged out of Teleport', 'info');
  } catch (err) {
    notify(toErrorPayload(err).message, 'error');
  }
}

/**
 * App-wide Teleport access: one section per cluster (a tsh profile), pinned resources on top,
 * databases behind `tsh proxy db` tunnels and Kubernetes clusters. Nothing here is stored in
 * `.quiver/`; clusters and pins live in global config.
 */
export const teleportModuleUI = defineModuleUI({
  id: 'teleport',
  title: 'Teleport',
  icon: ShieldCheck,
  order: 25,
  availability: 'always',
  Sidebar: TeleportSidebar,
  tabs: {},
  actions: [
    { id: 'teleport.login.ui', title: 'Teleport: log in', group: 'Teleport', keywords: ['tsh', 'sso'], run: loginFromPalette },
    { id: 'teleport.logout.ui', title: 'Teleport: log out of all clusters', group: 'Teleport', keywords: ['tsh'], run: logoutFromPalette },
    { id: 'teleport.show', title: 'Teleport: clusters, databases and pins', group: 'Teleport', run: () => useAppStore.getState().setActiveModule('teleport') },
  ],
});
