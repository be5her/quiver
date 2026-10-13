import { inject, untracked } from '@angular/core';
import { AppState, defineModuleUI } from '@quiver/ui';
import { Logs } from 'lucide';
import { LogsConnectionTab } from './connection-tab';
import { LogsActions } from './logs-actions';
import { LogsSidebar } from './logs-sidebar';

export const logsModuleUI = defineModuleUI({
  id: 'logs',
  title: 'Logs',
  icon: Logs,
  order: 27,
  availability: 'workspace',
  sidebar: LogsSidebar,
  tabs: {
    'logs.connection': LogsConnectionTab,
  },
  actions: () => {
    const logs = inject(LogsActions);
    const app = inject(AppState);
    return [{ id: 'logs.connection.new', title: 'New logs connection (Grafana)', group: 'Logs', run: () => logs.createConnection(), when: () => untracked(app.hasWorkspace) }];
  },
});
