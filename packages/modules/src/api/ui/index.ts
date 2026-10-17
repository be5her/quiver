import { inject, untracked } from '@angular/core';
import { AppState, defineModuleUI } from '@quiver/ui';
import { Globe } from 'lucide';
import { ApiActions } from './api-actions';
import { RunTab } from './run-tab';
import { ApiSidebar } from './api-sidebar';
import { CollectionTab } from './collection-tab';
import { CookieJarTab } from './cookie-jar-tab';
import { EnvironmentTab } from './environment-tab';
import { HistoryTab } from './history-tab';
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
    'api.collection': CollectionTab,
    'api.graphql.schema': SchemaTab,
    'api.history': HistoryTab,
    'api.cookies': CookieJarTab,
    'api.run': RunTab,
  },
  actions: () => {
    const api = inject(ApiActions);
    const app = inject(AppState);
    const hasWorkspace = () => untracked(app.hasWorkspace);
    return [
      { id: 'api.request.new', title: 'New API request', group: 'API', shortcut: 'Ctrl+N', run: () => api.createRequest(), when: hasWorkspace },
      { id: 'api.request.newGraphql', title: 'New GraphQL request', group: 'API', run: () => api.createGraphqlRequest(), when: hasWorkspace },
      { id: 'api.import.curl', title: 'Import request from curl', group: 'API', run: () => api.importCurl(), when: hasWorkspace },
      { id: 'api.import.openapi', title: 'Import from OpenAPI', group: 'API', run: () => api.importFile('openapi'), when: hasWorkspace },
      { id: 'api.import.postman', title: 'Import from Postman', group: 'API', run: () => api.importFile('postman'), when: hasWorkspace },
      { id: 'api.import.insomnia', title: 'Import from Insomnia', group: 'API', run: () => api.importFile('insomnia'), when: hasWorkspace },
      { id: 'api.import.har', title: 'Import from HAR', group: 'API', run: () => api.importFile('har'), when: hasWorkspace },
      { id: 'api.import.paste', title: 'Import a pasted OpenAPI, Postman, Insomnia or HAR file', group: 'API', run: () => api.importPasted(), when: hasWorkspace },
      { id: 'api.environment.new', title: 'New environment', group: 'API', run: () => api.createEnvironment(), when: hasWorkspace },
      { id: 'api.history.show', title: 'Show request history', group: 'API', run: () => api.openHistoryTab(), when: hasWorkspace },
      { id: 'api.cookies.show', title: 'Show cookie jar', group: 'API', run: () => api.openCookieJar(), when: hasWorkspace },
    ];
  },
});
