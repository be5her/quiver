# Quiver

A per-project developer toolbelt. Open a folder, and that folder gets its own API requests, environments, database connections, mock servers and small tools, stored as JSON under `.quiver/`. Every feature is also exposed to AI agents through a built-in MCP server.

## Status

Early scaffold. Working today:

- Workspace model: open several folders, switch instantly, per-workspace tabs restored on return.
- API client: collections, requests, params/headers/body/auth, environments with encrypted secrets, history, curl import and export, `{{variables}}` everywhere.
- Databases: MySQL, SQLite (via Node's built-in `node:sqlite`, nothing to compile) and Redis. Schema tree, table browser with filter and paging, SQL editor with autocompletion and multi-statement scripts, Redis key browser and console, saved queries and history. Passwords are encrypted per machine and never committed.
- Teleport: several clusters at once, each a tsh profile with its own status, expiry countdown, browser SSO login and logout. Databases from `tsh db ls` with one-click `tsh proxy db --tunnel` tunnels that become Quiver connections, Kubernetes clusters with `tsh kube login`, and pinned resources from any cluster at the top. Database connections can also go through any tunnel command with a `{port}` placeholder (ssh and friends).
- Mock servers and webhook receivers: local HTTP servers saved with the project. Ordered routes with `:param` and `*` patterns, status, headers, delay and bodies templated from the request (`{{params.id}}`, `{{query.q}}`, `{{headers.x}}`, `{{body.field}}`, `{{$uuid}}`). Every request is captured with what was answered, so a server without routes is a webhook receiver; unmatched requests can instead be forwarded to a real upstream and recorded. Replay a captured request against your app, turn it into a route, open it in the API client or copy it as curl. Agents get `mock_request_wait` to block until the next webhook lands.
- Small tools: JSON format, JWT decode, base64, URL encode, hash, UUID, timestamp.
- MCP server: every command is a tool over Streamable HTTP on `http://127.0.0.1:7411/mcp`.
- Light and dark theme, command palette (`Ctrl+K`).

Planned next: WebSocket, SSE and GraphQL; MCP inspector; `.env` file manager.

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
| `npm run smoke`     | Builds, then runs a headless end-to-end check and exits. Covers SQLite, Redis (against an in-process fake), Teleport (against a fake `tsh` script that answers status, login, db/kube listing and opens real local tunnels) and mock servers (real listeners: routes, templates, forwarding, replay, a webhook receiver that survives a workspace reopen). Set `QUIVER_SMOKE_MYSQL=mysql://user:pass@host:3306/db` to also exercise a live MySQL server, and `QUIVER_SMOKE_SHOTS=<dir>` to capture screenshots. The run uses a private MCP port, so a Quiver you have open is left alone. |
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
- `.quiver/local/`: gitignored. UI state, request and query history, requests captured by mock servers, and secrets (environment values, database passwords) encrypted with the OS keychain.
- SQLite files referenced by a relative path resolve against the project folder, so a committed connection works for every teammate.
- Global config lives in the Electron user data folder as `config.json`. Teleport settings (cluster proxy addresses, pins, optional tsh path, log in on launch) live there too, never in `.quiver/`; the Teleport sessions themselves are the standard tsh profiles in `~/.tsh`, shared with the tsh and kubectl in your terminal.

### Teleport

Quiver finds `tsh` from the path in Settings, then PATH, then the copy bundled with Teleport Connect, and spawns it with tokenized arguments and no shell. A cluster is a tsh profile identified by its proxy address: the ones listed in Settings plus every profile tsh already has on disk. One `tsh status --format=json` per minute reports all of them, and every other command carries `--proxy=<addr>`, so several clusters work side by side and your terminal's current profile only changes when you log in. Login runs `tsh login --proxy=<addr>` with no `--auth` flag and no stdin, so the cluster's default SSO connector opens the browser; the process output is shown in the sidebar. Pins are Quiver-side favourites (cluster, kind, name) kept in global config. Tunnels are app-wide: one `tsh proxy db --tunnel` per cluster, database and database user, shared by every workspace, kept alive while a connection uses it and for 30 seconds after. A connection with Teleport access remembers its cluster, starts its tunnel on first use, and a query that fails because that cluster's certificate expired comes back as `TELEPORT_LOGIN_REQUIRED` naming the cluster, with a "Log in again" button.

### Mock servers

A mock server is one JSON file under `.quiver/mock-servers/` with a port (a random five-digit one when created, avoiding every port Quiver has handed out on this machine so servers of different projects do not collide), a host (loopback, or every interface for containers and phones), an ordered route list and a fallback. Routes match top to bottom on method and path; `/users/:id` captures a segment, `/files/*` the rest, `HEAD` matches `GET` routes. Bodies and headers are templates over the request: `params`, `query`, `headers` (lower-case names), `body` and `body.<path>` for JSON bodies, plus the dynamic `{{$uuid}}`, `{{$timestamp}}` and friends. The fallback either answers a fixed response (404, or 200 for a webhook receiver) or forwards the request to an upstream base URL and returns what came back, so a server can stand in for a real API while overriding single endpoints. CORS headers and preflight answers are on by default. Each server keeps its last 500 requests (configurable) in memory and in `.quiver/local`, with bodies capped at 256 KB; saving a server applies route changes to the running listener, and servers marked "start with the workspace" come up on open.

## MCP

Add Quiver to Claude Code:

```bash
claude mcp add --transport http quiver "http://127.0.0.1:7411/mcp"
```

Append `?workspace=<absolute folder path>` to bind a client to a specific project. Commands flagged as mutating (deletes, database writes) are refused for agents until "Allow mutating commands" is enabled in Settings. `db_query_run` decides per call: `SELECT`, `SHOW`, `EXPLAIN` and read-only Redis commands always work, anything that writes is gated. For Teleport, `teleport_status`, `teleport_db_list`, `teleport_kube_list`, `teleport_db_connect` (start a tunnel, attach a connection), `teleport_pin` and `teleport_cluster_add` are always allowed; `teleport_login`, `teleport_logout`, `teleport_kube_login` (rewrites your kubeconfig), `teleport_db_disconnect` and `teleport_cluster_remove` are gated because they change state your terminal shares or delete pins. Mock servers: listing, saving servers and routes, starting, reading captured requests, `mock_request_wait` and `mock_request_replay` are allowed; `mock_server_stop`, `mock_server_delete`, `mock_route_delete` and `mock_request_clear` are gated.
