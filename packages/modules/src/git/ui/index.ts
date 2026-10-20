import { defineModuleUI } from '@quiver/ui';
import { GitBranch } from 'lucide';
import { GitSidebar } from './git-sidebar';

export const gitModuleUI = defineModuleUI({
  id: 'git',
  title: 'Git',
  icon: GitBranch,
  order: 35,
  availability: 'workspace',
  sidebar: GitSidebar,
  tabs: {},
});
