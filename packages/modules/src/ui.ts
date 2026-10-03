import type { ModuleUI } from '@quiver/ui';
import { apiModuleUI } from './api/ui';
import { dbModuleUI } from './db/ui';
import { envModuleUI } from './env/ui';
import { mcpModuleUI } from './mcp/ui';
import { mockModuleUI } from './mock/ui';
import { realtimeModuleUI } from './realtime/ui';
import { teleportModuleUI } from './teleport/ui';
import { toolsModuleUI } from './tools/ui';

/** Renderer-side module list, mirrored by `mainModules` in `main.ts`. */
export const uiModules: ModuleUI[] = [apiModuleUI, dbModuleUI, envModuleUI, mcpModuleUI, mockModuleUI, realtimeModuleUI, teleportModuleUI, toolsModuleUI].sort((a, b) => a.order - b.order);
