import { inject, untracked } from '@angular/core';
import { AppState, defineModuleUI } from '@quiver/ui';
import { Layers } from 'lucide';
import { QueuesConnectionTab } from './connection-tab';
import { QueuesDestinationTab } from './destination-tab';
import { QueuesActions } from './queues-actions';
import { QueuesSidebar } from './queues-sidebar';

export const queuesModuleUI = defineModuleUI({
  id: 'queues',
  title: 'Queues',
  icon: Layers,
  order: 29,
  availability: 'workspace',
  sidebar: QueuesSidebar,
  tabs: {
    'queues.connection': QueuesConnectionTab,
    'queues.destination': QueuesDestinationTab,
  },
  actions: () => {
    const queues = inject(QueuesActions);
    const app = inject(AppState);
    const hasWorkspace = () => untracked(app.hasWorkspace);
    return [
      { id: 'queues.connection.new', title: 'New queue connection', group: 'Queues', keywords: ['kafka', 'sqs', 'rabbitmq', 'amqp'], run: () => queues.createConnection(), when: hasWorkspace },
      { id: 'queues.destination.open', title: 'Open topic or queue', group: 'Queues', keywords: ['kafka', 'sqs', 'rabbitmq', 'peek', 'produce', 'tail'], run: () => queues.pickDestination(), when: hasWorkspace },
    ];
  },
});
