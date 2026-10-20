import { defineModuleUI } from '@quiver/ui';
import { SquareTerminal } from 'lucide';
import { RunnerSidebar } from './runner-sidebar';

export const runnerModuleUI = defineModuleUI({
  id: 'runner',
  title: 'Runner',
  icon: SquareTerminal,
  order: 45,
  availability: 'workspace',
  sidebar: RunnerSidebar,
  tabs: {},
});
