import { inject, untracked } from '@angular/core';
import { AppState, defineModuleUI } from '@quiver/ui';
import { Server } from 'lucide';
import { MockActions } from './mock-actions';
import { MockSidebar } from './mock-sidebar';
import { MockServerTab } from './server-tab';

export const mockModuleUI = defineModuleUI({
  id: 'mock',
  title: 'Mock servers',
  icon: Server,
  order: 30,
  availability: 'workspace',
  sidebar: MockSidebar,
  tabs: {
    'mock.server': MockServerTab,
  },
  actions: () => {
    const mock = inject(MockActions);
    const app = inject(AppState);
    const hasWorkspace = () => untracked(app.hasWorkspace);
    return [
      { id: 'mock.server.new', title: 'New mock server', group: 'Mock servers', run: () => mock.createServer('mock'), when: hasWorkspace },
      { id: 'mock.webhook.new', title: 'New webhook receiver', group: 'Mock servers', run: () => mock.createServer('webhook'), when: hasWorkspace },
    ];
  },
});
