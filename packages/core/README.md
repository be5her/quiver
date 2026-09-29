# Core

The engine, with no Electron or React in it: the command registry (`defineCommand`, `defineModule`, the mutating gate), the models every module shares, variable resolution, the file store behind `.quiver/`, the colour palettes, and small pure helpers (arrays, activity bar layout). Everything here is unit-tested with vitest (`npm test`); if a piece of logic can be written without I/O, it belongs here with a test beside it.

`src/index.ts` is the pure entry point, safe to import from the renderer. `src/node/` holds the Node-only parts: the workspace manager, the file store and the global config store.

## Storage

- `.quiver/<collection>/<id>.json`: committed, one file per item, diffable in pull requests. Quiver watches the folder, so files an agent writes by hand, a `git pull` or a branch switch show up without a restart.
- `.quiver/local/`: gitignored (the store writes the `.gitignore` itself). UI state (tabs, tree state), request and query history, requests captured by mock servers, realtime message logs, MCP traffic logs, env file backups, fetched GraphQL schemas, the todo list, and secrets (environment values, database passwords) encrypted with the OS keychain.
- SQLite files referenced by a relative path resolve against the project folder, so a committed connection works for every teammate.
- Global config lives in the Electron user data folder as `config.json`: theme and palette, recent and open workspaces (in the order the title bar shows them), global variables, the MCP port and mutation switch, the update channel, the activity bar arrangement (`activityBar`: order and hidden modules), and the Teleport settings (cluster proxy addresses, pins, optional tsh path, log in on launch). Nested sections are merged one level deep and normalised on load, so an older or hand-edited file cannot break the app. The Kubernetes query history and the private kubeconfigs Quiver queries through live in `teleport-kube/` in the same folder, per machine.

## Commands and the mutating gate

A command declares an id, a scope (`global` or `workspace`), a zod input schema and a handler. The schema is validated on every call and becomes the MCP tool schema. `mutating` is a boolean or a function of the input and the call context; a mutating command is refused for MCP callers until "Allow mutating commands" is enabled. Handlers see who is calling (`ctx.caller` is `ui` or `mcp`) and mask secrets for agents.

## Palettes

`src/palettes.ts` holds the six brand palettes, taken from the brand package's `themes/themes.json`, with a light and a dark set each; `resolvePalette` falls back to Slate & Mint for an unknown key. How they reach the screen is described in [src/renderer/README.md](../../src/renderer/README.md).
