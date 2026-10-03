import { inject, untracked } from '@angular/core';
import { AppState, defineModuleUI } from '@quiver/ui';
import { FileKey } from 'lucide';
import { EnvActions } from './env-actions';
import { EnvSidebar } from './env-sidebar';
import { EnvFileTab } from './file-tab';

export const envModuleUI = defineModuleUI({
  id: 'env',
  title: 'Env files',
  icon: FileKey,
  order: 50,
  availability: 'workspace',
  sidebar: EnvSidebar,
  tabs: {
    'env.file': EnvFileTab,
  },
  actions: () => {
    const env = inject(EnvActions);
    const app = inject(AppState);
    const hasWorkspace = () => untracked(app.hasWorkspace);
    return [
      { id: 'env.file.new', title: 'New env file', group: 'Env files', run: () => env.createEnvFile(), when: hasWorkspace },
      { id: 'env.environment.export', title: 'Export environment to an env file', group: 'Env files', run: () => env.exportEnvironment(), when: hasWorkspace },
    ];
  },
});
