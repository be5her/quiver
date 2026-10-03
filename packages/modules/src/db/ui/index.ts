import { inject, untracked } from '@angular/core';
import { AppState, defineModuleUI } from '@quiver/ui';
import { Database } from 'lucide';
import { ConnectionTab } from './connection-tab';
import { DbActions } from './db-actions';
import { DbSidebar } from './db-sidebar';
import { QueryTab } from './query-tab';
import { RedisTab } from './redis-tab';
import { TableTab } from './table-tab';

export { DbActions } from './db-actions';
export { DbError } from './db-error';
export { formatDuration } from './db-format';
export { TeleportLogin } from './teleport-login';

export const dbModuleUI = defineModuleUI({
  id: 'db',
  title: 'Databases',
  icon: Database,
  order: 20,
  availability: 'workspace',
  sidebar: DbSidebar,
  tabs: {
    'db.connection': ConnectionTab,
    'db.query': QueryTab,
    'db.table': TableTab,
    'db.redis': RedisTab,
  },
  actions: () => {
    const db = inject(DbActions);
    const app = inject(AppState);
    const hasWorkspace = () => untracked(app.hasWorkspace);
    return [
      { id: 'db.connection.new', title: 'New database connection', group: 'Databases', run: () => db.openNewConnectionTab('mysql'), when: hasWorkspace },
      { id: 'db.query.new', title: 'New query', group: 'Databases', shortcut: 'Ctrl+Shift+Q', run: () => db.newQueryForFirstConnection(), when: hasWorkspace },
    ];
  },
});
