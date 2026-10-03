import { inject } from '@angular/core';
import { AppState, defineModuleUI } from '@quiver/ui';
import { ShieldCheck } from 'lucide';
import { KubeQueryTab } from './kube-query-tab';
import { TeleportActions } from './teleport-actions';
import { TeleportSidebar } from './teleport-sidebar';

/**
 * App-wide Teleport access: one section per cluster (a tsh profile), pinned resources on top,
 * databases behind `tsh proxy db` tunnels and Kubernetes clusters with a read-only query view.
 * Nothing here is stored in `.quiver/`; clusters and pins live in global config, the Kubernetes
 * query history in the app data folder.
 */
export const teleportModuleUI = defineModuleUI({
  id: 'teleport',
  title: 'Teleport',
  icon: ShieldCheck,
  order: 25,
  availability: 'always',
  sidebar: TeleportSidebar,
  tabs: { 'teleport.kube': KubeQueryTab },
  actions: () => {
    const teleport = inject(TeleportActions);
    const app = inject(AppState);
    return [
      { id: 'teleport.login.ui', title: 'Teleport: log in', group: 'Teleport', keywords: ['tsh', 'sso'], run: () => teleport.loginFromPalette() },
      { id: 'teleport.logout.ui', title: 'Teleport: log out of all clusters', group: 'Teleport', keywords: ['tsh'], run: () => teleport.logoutFromPalette() },
      { id: 'teleport.show', title: 'Teleport: clusters, databases and pins', group: 'Teleport', run: () => app.setActiveModule('teleport') },
    ];
  },
});
