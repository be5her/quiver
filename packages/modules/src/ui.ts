import type { ModuleUI } from '@quiver/ui';

/** Renderer-side module list, mirrored by `mainModules` in `main.ts`. */
export const uiModules: ModuleUI[] = [].sort((a: ModuleUI, b: ModuleUI) => a.order - b.order);
