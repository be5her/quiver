import { inject, untracked } from '@angular/core';
import { AppState, defineModuleUI } from '@quiver/ui';
import { Globe } from 'lucide';
import { ApiActions } from './api-actions';
import { ApiSidebar } from './api-sidebar';
import { EnvironmentTab } from './environment-tab';
import { RequestTab } from './request-tab';
import { SchemaTab } from './schema-tab';

export { ApiActions } from './api-actions';
export { ApiVariables } from './api-variables';
export { AuthEditor } from './auth-editor';
export { HeaderTable } from './header-table';

export const apiModuleUI = defineModuleUI({
  id: 'api',
  title: 'API client',
  icon: Globe,
  order: 10,
  availability: 'workspace',
  sidebar: ApiSidebar,
  tabs: {
    'api.request': RequestTab,
    'api.environment': EnvironmentTab,
    'api.graphql.schema': SchemaTab,
  },
  actions: () => {
    const api = inject(ApiActions);
    const app = inject(AppState);
    const hasWorkspace = () => untracked(app.hasWorkspace);
    return [
      { id: 'api.request.new', title: 'New API request', group: 'API', shortcut: 'Ctrl+N', run: () => api.createRequest(), when: hasWorkspace },
      { id: 'api.request.newGraphql', title: 'New GraphQL request', group: 'API', run: () => api.createGraphqlRequest(), when: hasWorkspace },
      { id: 'api.import.curl', title: 'Import request from curl', group: 'API', run: () => api.importCurl(), when: hasWorkspace },
      { id: 'api.environment.new', title: 'New environment', group: 'API', run: () => api.createEnvironment(), when: hasWorkspace },
    ];
  },
});
