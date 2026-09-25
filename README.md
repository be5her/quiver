# Quiver

A per-project developer toolbelt. Open a folder, and that folder gets its own API requests, environments, database connections, mock servers and small tools, stored as JSON under `.quiver/`. Every feature is also exposed to AI agents through a built-in MCP server.

## Status

Early scaffold. Working today:

- Workspace model: open several folders, switch instantly, per-workspace tabs restored on return.
- API client: collections, requests, params/headers/body/auth, environments with encrypted secrets, history, curl import and export, `{{variables}}` everywhere.
- Databases: MySQL, SQLite (via Node's built-in `node:sqlite`, nothing to compile) and Redis. Schema tree, table browser with filter and paging, SQL editor with autocompletion and multi-statement scripts, Redis key browser and console, saved queries and history. Passwords are encrypted per machine and never committed.
- Teleport: app-wide session driven through the `tsh` CLI (status with expiry countdown, browser SSO login, logout), databases from `tsh db ls` with one-click `tsh proxy db --tunnel` tunnels that become Quiver connections, Kubernetes clusters with `tsh kube login`. Database connections can also go through any tunnel command with a `{port}` placeholder (ssh and friends).
- Small tools: JSON format, JWT decode, base64, URL encode, hash, UUID, timestamp.
- MCP server: every command is a tool over Streamable HTTP on `http://127.0.0.1:7411/mcp`.
- Light and dark theme, command palette (`Ctrl+K`).

Planned next: mock server and webhook receiver; WebSocket, SSE and GraphQL; MCP inspector; `.env` file manager.

## Run

```bash
npm install
npm run dev
```

Other scripts:

| Script              | What it does                                                   |
| ------------------- | -------------------------------------------------------------- |
| `npm test`          | Unit tests for the core engine (vitest).                       |
| `npm run typecheck` | Type-checks the main process and the renderer separately.      |
| `npm run smoke`     | Builds, then runs a headless end-to-end check and exits. Covers SQLite, Redis (against an in-process fake) and Teleport (against a fake `tsh` script that answers status, login, db/kube listing and opens real local tunnels). Set `QUIVER_SMOKE_MYSQL=mysql://user:pass@host:3306/db` to also exercise a live MySQL server, and `QUIVER_SMOKE_SHOTS=<dir>` to capture screenshots. The run uses a private MCP port, so a Quiver you have open is left alone. |
| `npm run package`   | Builds an installer with electron-builder (not yet exercised). |

## Layout

```
packages/core      Engine: command registry, models, variable resolution, file store. No Electron or React.
packages/ui        Host contract for the renderer: stores, IPC client, shared components.
packages/modules   One folder per feature. `main.ts` (Node side) and `ui/` (React side) per module.
packages/mcp       Adapts the command registry to an MCP server.
src/main           Electron main process: host wiring, IPC, window, smoke test.
src/preload        The only bridge between renderer and main (three functions).
src/renderer       The shell: title bar, activity bar, sidebar, tabs, status bar, palette, settings.
```

### Adding a feature

1. Create `packages/modules/src/<name>/main.ts` exporting a `ModuleMain` with commands built by `defineCommand`. Each command declares a zod input schema; that schema is validated on every call and becomes the MCP tool schema for free.
2. Create `packages/modules/src/<name>/ui/index.tsx` exporting a `ModuleUI` with a sidebar, tab components and optional palette actions.
3. Register both in `packages/modules/src/main.ts` and `packages/modules/src/ui.ts`.

Commands are the only way the UI talks to the host, so anything you add is reachable from the palette, from MCP and from a future CLI without extra work.

### Storage

- `.quiver/<collection>/<id>.json`: committed, one file per item, diffable in pull requests.
- `.quiver/local/`: gitignored. UI state, request and query history, and secrets (environment values, database passwords) encrypted with the OS keychain.
- SQLite files referenced by a relative path resolve against the project folder, so a committed connection works for every teammate.
- Global config lives in the Electron user data folder as `config.json`. Teleport settings (proxy address, optional tsh path, log in on launch) live there too, never in `.quiver/`; the Teleport session itself is the standard tsh profile in `~/.tsh`, shared with the tsh and kubectl in your terminal.

### Teleport

Quiver finds `tsh` from the path in Settings, then PATH, then the copy bundled with Teleport Connect, and spawns it with tokenized arguments and no shell. `tsh status --format=json` is polled every minute. Login runs `tsh login --proxy=<addr>` with no `--auth` flag and no stdin, so the cluster's default SSO connector opens the browser; the process output is shown in the sidebar. Tunnels are app-wide: one `tsh proxy db --tunnel` per database and database user, shared by every workspace, kept alive while a connection uses it and for 30 seconds after. A connection with Teleport access starts its tunnel on first use, and a query that fails because the certificate expired comes back as `TELEPORT_LOGIN_REQUIRED` with a "Log in again" button.

## MCP

Add Quiver to Claude Code:

```bash
claude mcp add --transport http quiver "http://127.0.0.1:7411/mcp"
```

Append `?workspace=<absolute folder path>` to bind a client to a specific project. Commands flagged as mutating (deletes, database writes) are refused for agents until "Allow mutating commands" is enabled in Settings. `db_query_run` decides per call: `SELECT`, `SHOW`, `EXPLAIN` and read-only Redis commands always work, anything that writes is gated. For Teleport, `teleport_status`, `teleport_db_list`, `teleport_kube_list` and `teleport_db_connect` (start a tunnel, attach a connection) are always allowed; `teleport_login`, `teleport_logout`, `teleport_kube_login` (rewrites your kubeconfig) and `teleport_db_disconnect` are gated because they change state your terminal shares.
