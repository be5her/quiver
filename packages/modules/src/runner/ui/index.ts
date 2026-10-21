import { inject, untracked } from '@angular/core';
import { AppState, defineModuleUI } from '@quiver/ui';
import { SquareTerminal } from 'lucide';
import { RunnerActions } from './runner-actions';
import { RunnerSidebar } from './runner-sidebar';
import { RunnerStatusItem } from './runner-status-item';
import { RunnerTaskTab } from './task-tab';

export const runnerModuleUI = defineModuleUI({
  id: 'runner',
  title: 'Runner',
  icon: SquareTerminal,
  order: 45,
  availability: 'workspace',
  sidebar: RunnerSidebar,
  statusItems: [RunnerStatusItem],
  tabs: {
    'runner.task': RunnerTaskTab,
  },
  actions: () => {
    const runner = inject(RunnerActions);
    const app = inject(AppState);
    const hasWorkspace = () => untracked(app.hasWorkspace);
    return [
      { id: 'runner.task.run', title: 'Run task', group: 'Runner', keywords: ['start', 'process', 'dev server', 'script'], run: () => runner.pickTask('run'), when: hasWorkspace },
      { id: 'runner.task.open', title: 'Open task', group: 'Runner', keywords: ['output', 'logs', 'process'], run: () => runner.pickTask('open'), when: hasWorkspace },
      { id: 'runner.task.stopAll', title: 'Stop all tasks', group: 'Runner', keywords: ['kill', 'process'], run: () => runner.stopAll(), when: hasWorkspace },
      { id: 'runner.task.new', title: 'New task', group: 'Runner', keywords: ['process', 'command'], run: () => runner.createTask(), when: hasWorkspace },
    ];
  },
});
