import { inject, untracked } from '@angular/core';
import { AppState, defineModuleUI } from '@quiver/ui';
import { Radio } from 'lucide';
import { RealtimeConnectionTab } from './connection-tab';
import { RealtimeActions } from './realtime-actions';
import { RealtimeSidebar } from './realtime-sidebar';

export const realtimeModuleUI = defineModuleUI({
  id: 'realtime',
  title: 'Realtime',
  icon: Radio,
  order: 15,
  availability: 'workspace',
  sidebar: RealtimeSidebar,
  tabs: {
    'realtime.connection': RealtimeConnectionTab,
  },
  actions: () => {
    const realtime = inject(RealtimeActions);
    const app = inject(AppState);
    const hasWorkspace = () => untracked(app.hasWorkspace);
    return [
      { id: 'realtime.websocket.new', title: 'New WebSocket connection', group: 'Realtime', run: () => realtime.createConnection('websocket'), when: hasWorkspace },
      { id: 'realtime.sse.new', title: 'New event stream (SSE)', group: 'Realtime', run: () => realtime.createConnection('sse'), when: hasWorkspace },
    ];
  },
});
