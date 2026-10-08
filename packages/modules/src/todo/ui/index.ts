import { inject, untracked } from '@angular/core';
import { AppState, defineModuleUI } from '@quiver/ui';
import { ListChecks } from 'lucide';
import { TodoActions } from './todo-actions';
import { TodoSidebar } from './todo-sidebar';

export const todoModuleUI = defineModuleUI({
  id: 'todo',
  title: 'Todo',
  icon: ListChecks,
  order: 60,
  availability: 'workspace',
  sidebar: TodoSidebar,
  tabs: {},
  actions: () => {
    const todos = inject(TodoActions);
    const app = inject(AppState);
    return [{ id: 'todo.add.ui', title: 'Add a todo', group: 'Todo', run: () => todos.addFromPalette(), when: () => untracked(app.hasWorkspace) }];
  },
});
