import { defineConfig } from 'electron-vite';

/**
 * Runtime dependencies that stay outside the main bundle and are resolved from node_modules.
 * Keep in sync with the root package.json "dependencies" so packaging picks them up.
 */
const externalRuntimeDeps = ['undici', 'zod', 'mysql2', /^mysql2\//, 'ioredis', 'graphql', /^graphql\//, 'electron-updater', /^node:/, /^@modelcontextprotocol\/sdk/];
/** Dev-only: the smoke test's fake WebSocket server. Loaded lazily, never shipped. */
const externalDevDeps = ['ws'];

/**
 * Builds the main process and the preload script. The renderer is an Angular application with its
 * own build (src/renderer, `ng build` into out/renderer); `npm run dev` points Electron at its dev server.
 */
export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        external: [...externalRuntimeDeps, ...externalDevDeps],
      },
    },
  },
  preload: {},
});
