import { defineModuleUI, invoke, notify, promptDialog, useAppStore } from '@quiver/ui';
import { ListChecks } from 'lucide-react';
import { TodoSidebar } from './Sidebar';

const hasWorkspace = () => useAppStore.getState().activeWorkspaceId !== null;

async function addFromPalette(): Promise<void> {
  const title = await promptDialog({ title: 'Add a todo', label: 'What needs doing?', confirmLabel: 'Add' });
  if (!title?.trim()) return;
  await invoke('todo.add', { title });
  useAppStore.getState().setActiveModule('todo');
  notify('Added to the todo list', 'success');
}

export const todoModuleUI = defineModuleUI({
  id: 'todo',
  title: 'Todo',
  icon: ListChecks,
  order: 60,
  availability: 'workspace',
  Sidebar: TodoSidebar,
  tabs: {},
  actions: [{ id: 'todo.add.ui', title: 'Add a todo', group: 'Todo', run: addFromPalette, when: hasWorkspace }],
});
