import type { ModuleMain } from '@quiver/core';
import { apiModule } from './api/main';
import { dbModule } from './db/main';
import { teleportModule } from './teleport/main';
import { toolsModule } from './tools/main';

/**
 * Node-side module list. Adding a module means adding its folder and one entry here.
 * A future plugin loader would append to this same array from manifests on disk.
 */
export const mainModules: ModuleMain[] = [apiModule, dbModule, teleportModule, toolsModule];
