import type { ModuleUI } from '@quiver/ui';
import { apiModuleUI } from './api/ui';
import { toolsModuleUI } from './tools/ui';

/** Renderer-side module list, mirrored by `mainModules` in `main.ts`. */
export const uiModules: ModuleUI[] = [apiModuleUI, toolsModuleUI].sort((a, b) => a.order - b.order);
