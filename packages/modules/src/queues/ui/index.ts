import { defineModuleUI } from '@quiver/ui';
import { Layers } from 'lucide';
import { QueuesSidebar } from './queues-sidebar';

export const queuesModuleUI = defineModuleUI({
  id: 'queues',
  title: 'Queues',
  icon: Layers,
  order: 29,
  availability: 'workspace',
  sidebar: QueuesSidebar,
  tabs: {},
});
