import { EmptyState, defineModuleUI, type ModuleUI } from '@quiver/ui';
import { FileKey } from 'lucide-react';

function comingSoon(title: string, hint: string) {
  return function ComingSoon() {
    return <EmptyState title={title} hint={hint} />;
  };
}

/**
 * Modules that are planned but not built yet. They reserve their place in the
 * activity bar so the shape of the app is visible from day one.
 */
export const placeholderModules: ModuleUI[] = [
  defineModuleUI({
    id: 'env',
    title: 'Env files',
    icon: FileKey,
    order: 50,
    availability: 'workspace',
    Sidebar: comingSoon('Environment files', 'Edit .env files with secrets masked, diff them against examples, and switch profiles.'),
    tabs: {},
  }),
];
