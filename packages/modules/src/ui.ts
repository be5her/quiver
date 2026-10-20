import type { ModuleUI } from '@quiver/ui';
import { apiModuleUI } from './api/ui';
import { dbModuleUI } from './db/ui';
import { envModuleUI } from './env/ui';
import { gitModuleUI } from './git/ui';
import { logsModuleUI } from './logs/ui';
import { mcpModuleUI } from './mcp/ui';
import { metabaseModuleUI } from './metabase/ui';
import { mockModuleUI } from './mock/ui';
import { queuesModuleUI } from './queues/ui';
import { realtimeModuleUI } from './realtime/ui';
import { runnerModuleUI } from './runner/ui';
import { teleportModuleUI } from './teleport/ui';
import { todoModuleUI } from './todo/ui';
import { toolsModuleUI } from './tools/ui';

/** Renderer-side module list, mirrored by `mainModules` in `main.ts`. */
export const uiModules: ModuleUI[] = [apiModuleUI, dbModuleUI, envModuleUI, gitModuleUI, logsModuleUI, mcpModuleUI, metabaseModuleUI, mockModuleUI, queuesModuleUI, realtimeModuleUI, runnerModuleUI, teleportModuleUI, todoModuleUI, toolsModuleUI].sort((a, b) => a.order - b.order);
