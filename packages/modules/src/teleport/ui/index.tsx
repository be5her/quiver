import { toErrorPayload, type TeleportStatus } from '@quiver/core';
import { defineModuleUI, invoke, notify, useAppStore } from '@quiver/ui';
import { ShieldCheck } from 'lucide-react';
import { teleportLoginAgain } from '../../db/ui/shared';
import { TeleportSidebar } from './Sidebar';

async function logout(): Promise<void> {
  try {
    const status = await invoke<TeleportStatus>('teleport.logout', {}, null);
    notify(status.state === 'logged-out' ? 'Logged out of Teleport' : `Teleport: ${status.state}`, 'info');
  } catch (err) {
    notify(toErrorPayload(err).message, 'error');
  }
}

/**
 * App-wide Teleport access: session status, databases behind `tsh proxy db` tunnels and
 * Kubernetes clusters. Nothing here is stored in `.quiver/`; settings live in global config.
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
    { id: 'teleport.login.ui', title: 'Teleport: log in', group: 'Teleport', keywords: ['tsh', 'sso'], run: () => teleportLoginAgain().then(() => undefined) },
    { id: 'teleport.logout.ui', title: 'Teleport: log out', group: 'Teleport', keywords: ['tsh'], run: logout },
    { id: 'teleport.show', title: 'Teleport: databases and clusters', group: 'Teleport', run: () => useAppStore.getState().setActiveModule('teleport') },
  ],
});
