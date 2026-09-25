import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

/**
 * Runtime dependencies that stay outside the main bundle and are resolved from node_modules.
 * Keep in sync with the root package.json "dependencies" so packaging picks them up.
 */
const externalRuntimeDeps = ['undici', 'zod', 'mysql2', /^mysql2\//, 'ioredis', /^node:/, /^@modelcontextprotocol\/sdk/];

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        external: externalRuntimeDeps,
      },
    },
  },
  preload: {},
  renderer: {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer/src'),
      },
    },
  },
});
