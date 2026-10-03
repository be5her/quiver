import type { ModuleUI } from '@quiver/ui';
import { apiModuleUI } from './api/ui';
import { dbModuleUI } from './db/ui';
import { mockModuleUI } from './mock/ui';
import { realtimeModuleUI } from './realtime/ui';
import { teleportModuleUI } from './teleport/ui';
import { toolsModuleUI } from './tools/ui';

/** Renderer-side module list, mirrored by `mainModules` in `main.ts`. */
export const uiModules: ModuleUI[] = [apiModuleUI, dbModuleUI, mockModuleUI, realtimeModuleUI, teleportModuleUI, toolsModuleUI].sort((a, b) => a.order - b.order);
