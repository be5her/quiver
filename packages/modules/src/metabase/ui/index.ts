import { inject, untracked } from '@angular/core';
import { AppState, defineModuleUI } from '@quiver/ui';
import { ChartColumnBig } from 'lucide';
import { MetabaseConnectionTab } from './connection-tab';
import { MetabaseActions } from './metabase-actions';
import { MetabaseSidebar } from './metabase-sidebar';
import { MetabaseQueryTab } from './query-tab';
import { MetabaseQuestionTab } from './question-tab';
import { MetabaseTableTab } from './table-tab';

export const metabaseModuleUI = defineModuleUI({
  id: 'metabase',
  title: 'Metabase',
  icon: ChartColumnBig,
  order: 28,
  availability: 'workspace',
  sidebar: MetabaseSidebar,
  tabs: {
    'metabase.connection': MetabaseConnectionTab,
    'metabase.question': MetabaseQuestionTab,
    'metabase.query': MetabaseQueryTab,
    'metabase.table': MetabaseTableTab,
  },
  actions: () => {
    const metabase = inject(MetabaseActions);
    const app = inject(AppState);
    const hasWorkspace = () => untracked(app.hasWorkspace);
    return [
      { id: 'metabase.connection.new', title: 'New Metabase connection', group: 'Metabase', run: () => metabase.createConnection(), when: hasWorkspace },
      { id: 'metabase.query.new', title: 'New Metabase native query', group: 'Metabase', keywords: ['sql'], run: () => metabase.newQueryForFirstConnection(), when: hasWorkspace },
    ];
  },
});
