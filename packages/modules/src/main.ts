import type { ModuleMain } from '@quiver/core';
import { apiModule } from './api/main';
import { dbModule } from './db/main';
import { envModule } from './env/main';
import { logsModule } from './logs/main';
import { mcpModule } from './mcp/main';
import { metabaseModule } from './metabase/main';
import { mockModule } from './mock/main';
import { realtimeModule } from './realtime/main';
import { teleportModule } from './teleport/main';
import { todoModule } from './todo/main';
import { toolsModule } from './tools/main';

/**
 * Node-side module list. Adding a module means adding its folder and one entry here.
 * A future plugin loader would append to this same array from manifests on disk.
 */
export const mainModules: ModuleMain[] = [apiModule, dbModule, envModule, logsModule, mcpModule, metabaseModule, mockModule, realtimeModule, teleportModule, todoModule, toolsModule];
