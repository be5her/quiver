# Quiver

A per-project developer toolbelt. Open a folder, and that folder gets its own API requests, environments, database connections, mock servers and small tools, stored as JSON under `.quiver/`. Every feature is also exposed to AI agents through a built-in MCP server.

## Install

Download the build for your platform from the [latest release](https://github.com/be5her/quiver/releases/latest). The builds are not code-signed yet, so each OS asks once before the first launch.

| Platform | File                                                                                  | First launch                                                                                                                                                                                                                                              |
| -------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows  | `Quiver-<version>-setup.exe`                                                          | SmartScreen shows "Windows protected your PC": click _More info_, then _Run anyway_. Updates install in place from the app.                                                                                                                                 |
| macOS    | `Quiver-<version>-mac-arm64.dmg` (Apple silicon), `Quiver-<version>-mac-x64.dmg` (Intel) | Drag Quiver to Applications. The first launch is blocked; open _System Settings → Privacy & Security_ and click _Open Anyway_, or run `xattr -dr com.apple.quarantine /Applications/Quiver.app`. The app announces new versions but, until builds are signed, links to the download instead of replacing itself. |
| Linux    | `Quiver-<version>-linux-x64.AppImage` or `Quiver-<version>-linux-x64.deb`             | `chmod +x` the AppImage and run it; it updates in place. The `.deb` announces new versions and links to the download.                                                                                                                                       |

Quiver looks for a newer release on GitHub shortly after launch and every six hours. When there is one, the status bar shows "Update to vX" (or "vX available" where the build cannot replace itself); nothing is downloaded until you click. Settings → About has "Check for updates", the release notes and a "Restart to install" button once the download is verified. Agents get `app_update_check`; `app_update_download` and `app_update_install` are gated like every mutating command.

## Status

Working today:

- Workspace model: open several folders, switch instantly, per-workspace tabs restored on return.
- API client: collections, requests, params/headers/body/auth, environments with encrypted secrets, history, curl import and export, `{{variables}}` everywhere.
- Databases: MySQL, SQLite (via Node's built-in `node:sqlite`, nothing to compile) and Redis. Schema tree, table browser with filter and paging, SQL editor with autocompletion and multi-statement scripts, Redis key browser and console, saved queries and history. Passwords are encrypted per machine and never committed.
- Teleport: several clusters at once, each a tsh profile with its own status, expiry countdown, browser SSO login and logout. Databases from `tsh db ls` with one-click `tsh proxy db --tunnel` tunnels that become Quiver connections, Kubernetes clusters with `tsh kube login`, and pinned resources from any cluster at the top. Database connections can also go through any tunnel command with a `{port}` placeholder (ssh and friends).
- Mock servers and webhook receivers: local HTTP servers saved with the project. Ordered routes with `:param` and `*` patterns, status, headers, delay and bodies templated from the request (`{{params.id}}`, `{{query.q}}`, `{{headers.x}}`, `{{body.field}}`, `{{$uuid}}`). Every request is captured with what was answered, so a server without routes is a webhook receiver; unmatched requests can instead be forwarded to a real upstream and recorded. Replay a captured request against your app, turn it into a route, open it in the API client or copy it as curl. Agents get `mock_request_wait` to block until the next webhook lands.
- GraphQL: a body type of the API client. Query and variables editors with schema-aware autocompletion once the schema has been fetched by introspection (with the request's own headers and auth), an operation picker for documents with several operations, prettify, and a schema explorer with search and an SDL view. Sent as JSON over POST or as query parameters over GET.
- Realtime: WebSocket and Server-Sent Events connections saved with the project, with headers, auth, subprotocols and `{{variables}}`. A live message log with a composer and saved messages for WebSocket, event names and ids for SSE, and automatic reconnects (SSE honours `retry:` and resumes with `Last-Event-ID`). Agents get `realtime_send` and `realtime_message_wait` to drive and observe a stream.
- MCP inspector: connect to any MCP server (a command over stdio, Streamable HTTP, or legacy SSE), browse its tools, resources and prompts, call them with arguments prefilled from the schema, and watch every JSON-RPC message in a traffic log with timings and the process's stderr. Imports the servers a project already declares in `.mcp.json`, `.cursor/mcp.json` or `.vscode/mcp.json`, and can point at Quiver's own server to see exactly what agents see.
- Env files: every `.env`, `.env.<name>` and `<name>.env` of the project in one place, with secret-looking values masked until revealed. Edit keys in a table or the raw text without disturbing comments, blank lines or quoting; compare a file with its `.env.example` and add what is missing; switch `.env` between profiles (`.env.staging`, `.env.production`); a warning when a file with real values is committed or not gitignored; a history of every change Quiver made. Import a file into a Quiver environment (secrets encrypted) or export one back.
- Small tools: JSON format, JWT decode, base64, URL encode, hash, UUID, timestamp.
- MCP server: every command is a tool over Streamable HTTP on `http://127.0.0.1:7411/mcp`.
- Light and dark theme in six brand palettes (Amber Leather by default; Moss & Lime, Signal Blue, Ember, Slate & Mint, Graphite & Red under Settings → Appearance), command palette (`Ctrl+K`).

The first planned scope is complete. Ideas for later: gRPC, Docker, S3, a plugin loader for module manifests.

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
| `npm run smoke`     | Builds, then runs a headless end-to-end check and exits. Covers SQLite, Redis (against an in-process fake), Teleport (against a fake `tsh` script that answers status, login, db/kube listing and opens real local tunnels) mock servers (real listeners: routes, templates, forwarding, replay, a webhook receiver that survives a workspace reopen), GraphQL (a graphql-js endpoint: POST, GET, operation names, introspection), WebSocket (a `ws` server: subprotocols, binary frames, reconnect after a server close), SSE (retry hint, `Last-Event-ID` resume, POST bodies, error answers) and MCP servers (a dependency-free stdio script plus SDK-built Streamable HTTP and legacy SSE endpoints: import from `.mcp.json`, initialize, tools with annotations and structured output, resources and templates, prompts, log notifications, list-changed refresh, a process that exits, a connection to Quiver's own server) and env files (a temporary project with a committed `.env`, an example, a profile, a nested app and a `node_modules` decoy: discovery, parsing, masking for agents, in-place edits, compare and sync, profile switches, backups and restores, import to and export from environments, the UI table and watcher). Set `QUIVER_SMOKE_MYSQL=mysql://user:pass@host:3306/db` to also exercise a live MySQL server, and `QUIVER_SMOKE_SHOTS=<dir>` to capture screenshots. The run uses a private MCP port, so a Quiver you have open is left alone. |
| `npm run package`   | Builds the installer for this platform into `release/` with electron-builder, without publishing. |
| `npm run icon`      | Renders `resources/icon.svg` to `resources/icon.png`, the source of every platform icon. |
| `npm run release`   | Owner only. Bumps the version, tags and pushes so CI builds a draft release; see "Releasing". |

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

### Theme

Colours are CSS variables (`canvas`, `surface`, `elevated`, `fg`, `muted`, `edge`, `accent`, `accent-hover`, `accent-fg`, `danger`, `success`, `warning`) that Tailwind exposes as `bg-canvas`, `text-accent` and so on. `styles.css` holds the default palette; the palettes themselves live in `packages/core/src/palettes.ts`, taken from the brand package's `themes/themes.json`, with a light and a dark set each. `applyTheme` toggles the `dark` class and writes the chosen palette into a `<style id="quiver-palette">` whose selectors outrank `styles.css`, so the mode still follows the class. The choice is `palette` in global config beside `theme`; an unknown key falls back to Amber Leather. The app icon (`resources/icon.svg`) is the brand's C4 Solid mark on the Amber Leather dark badge and does not change with the palette; the in-app mark (`shell/Logo.tsx`) is drawn with the `fg` and `accent` tokens, so it does.

### Storage

- `.quiver/<collection>/<id>.json`: committed, one file per item, diffable in pull requests.
- `.quiver/local/`: gitignored. UI state, request and query history, requests captured by mock servers, realtime message logs, MCP traffic logs, env file backups, fetched GraphQL schemas, and secrets (environment values, database passwords) encrypted with the OS keychain.
- SQLite files referenced by a relative path resolve against the project folder, so a committed connection works for every teammate.
- Global config lives in the Electron user data folder as `config.json`. Teleport settings (cluster proxy addresses, pins, optional tsh path, log in on launch) live there too, never in `.quiver/`; the Teleport sessions themselves are the standard tsh profiles in `~/.tsh`, shared with the tsh and kubectl in your terminal.

### Teleport

Quiver finds `tsh` from the path in Settings, then PATH, then the copy bundled with Teleport Connect, and spawns it with tokenized arguments and no shell. A cluster is a tsh profile identified by its proxy address: the ones listed in Settings plus every profile tsh already has on disk. One `tsh status --format=json` per minute reports all of them, and every other command carries `--proxy=<addr>`, so several clusters work side by side and your terminal's current profile only changes when you log in. Login runs `tsh login --proxy=<addr>` with no `--auth` flag and no stdin, so the cluster's default SSO connector opens the browser; the process output is shown in the sidebar. Pins are Quiver-side favourites (cluster, kind, name) kept in global config. Tunnels are app-wide: one `tsh proxy db --tunnel` per cluster, database and database user, shared by every workspace, kept alive while a connection uses it and for 30 seconds after. A connection with Teleport access remembers its cluster, starts its tunnel on first use, and a query that fails because that cluster's certificate expired comes back as `TELEPORT_LOGIN_REQUIRED` naming the cluster, with a "Log in again" button.

### Mock servers

A mock server is one JSON file under `.quiver/mock-servers/` with a port (a random five-digit one when created, avoiding every port Quiver has handed out on this machine so servers of different projects do not collide), a host (loopback, or every interface for containers and phones), an ordered route list and a fallback. Routes match top to bottom on method and path; `/users/:id` captures a segment, `/files/*` the rest, `HEAD` matches `GET` routes. Bodies and headers are templates over the request: `params`, `query`, `headers` (lower-case names), `body` and `body.<path>` for JSON bodies, plus the dynamic `{{$uuid}}`, `{{$timestamp}}` and friends. The fallback either answers a fixed response (404, or 200 for a webhook receiver) or forwards the request to an upstream base URL and returns what came back, so a server can stand in for a real API while overriding single endpoints. CORS headers and preflight answers are on by default. Each server keeps its last 500 requests (configurable) in memory and in `.quiver/local`, with bodies capped at 256 KB; saving a server applies route changes to the running listener, and servers marked "start with the workspace" come up on open.

### GraphQL

A GraphQL request is an ordinary API request whose body type is `graphql`: a query document, variables as JSON text (with `{{variables}}` inside) and an optional operation name. Over POST it goes out as `{"query","variables","operationName"}` JSON; over GET the same three become query parameters. `api.graphql.introspect` runs the standard introspection query against the request's URL with its headers and auth, and caches the result as SDL under `.quiver/local`, keyed by endpoint; the editor uses it for autocompletion and lint, the Docs tab explores it, and `api.graphql.schema` hands it to agents.

### Realtime

A connection is one JSON file under `.quiver/realtime-connections/`: a kind (`websocket` or `sse`), a URL, headers, auth, subprotocols for WebSocket, a method and body for SSE (POST for servers that take a subscription document), and saved messages. Connecting resolves variables from the active environment and folds the auth in; the handshake or stream request carries the headers. Every message, sent or received, and every state change (open, close with code and reason, error, reconnect) lands in a log of 500 entries (configurable, bodies capped at 256 KB) kept in memory and in `.quiver/local`. WebSocket reconnects back off from 1 s to 30 s unless the close was normal (1000) or requested; SSE reconnects after the server's `retry:` hint (3 s by default) and sends `Last-Event-ID`, while a non-2xx answer or a wrong content type is reported and not retried. `realtime.message.wait` blocks until the next matching message, so an agent can send something and wait for the answer, or watch for a specific event.

### MCP inspector

A server is one JSON file under `.quiver/mcp-servers/`: a transport (`stdio` with a command, arguments, environment variables and a working directory; `http` for Streamable HTTP or `sse` for the older HTTP+SSE pair, both with a URL, headers and auth), plus "connect when the workspace opens" and a log size. Strings take `{{variables}}` from the active environment and `${NAME}` or `${NAME:-default}` from Quiver's own environment, the same syntax Claude Code uses in `.mcp.json`, so an imported entry works unchanged. Connecting runs the MCP handshake with the SDK client, announces the project folder as the root, records the server's info, protocol version, capabilities and instructions, and lists its tools, resources and prompts (refreshed again on `list_changed` notifications). Every JSON-RPC message in both directions, every stderr line of a stdio server and every state change lands in a log of 500 entries (configurable, bodies capped at 256 KB) kept in memory and in `.quiver/local`; responses are paired with their requests so each shows its method, round-trip time and whether it failed. `mcp.tool.call` returns the content blocks, structured content and `isError` flag as the server sent them; `mcp.request` sends any method for the rest. The sidebar lists the servers declared in `.mcp.json`, `.cursor/mcp.json` and `.vscode/mcp.json` that are not imported yet, and "This Quiver" adds Quiver's own server bound to the current workspace.

### Env files

Nothing is stored for this module: the files themselves are the data. Quiver scans the project up to four folders deep (skipping `node_modules`, `.git`, build output and the like) for `.env`, `.env.<name>` and `<name>.env`, classifies them (`.env` is the main file; `.env.example`, `.sample`, `.template`, `.dist` are examples; `.env.local` and `.env.<name>.local` are local overrides; any other `.env.<name>` is a profile) and watches those folders, so a change from your editor or a `cp` shows up at once. Parsing follows the `dotenv` package: `export` prefixes, `KEY: value`, unquoted values cut at `#`, `\n` escapes inside double quotes, literal single quotes and backticks, quoted values spanning lines, and the last of duplicated keys winning (earlier ones are shown as shadowed). Edits go through the parsed document and rewrite only the line they touch, keeping comments, blank lines, indentation, `export` and the quote style; new keys are appended. Before any write Quiver keeps the previous content (the last 20 versions per file, in `.quiver/local`) and the History tab restores any of them, including a deleted file. Keys that look like credentials (`SECRET`, `PASSWORD`, `TOKEN`, `API_KEY`, `PRIVATE`, `DSN`, ... or a URL with `user:pass@`) are masked in the table and in the raw text until revealed, and agents always get them masked unless they pass `reveal: true`, which needs the same switch as mutating commands. With git available, the sidebar warns when such a file is tracked (its values are in the repository) or not covered by `.gitignore`. Compare shows the keys an example defines that the file lacks (and the reverse, and the empty ones), with one click to append them with the example's placeholder values. Switching a profile copies `.env.<name>` over `.env`; the profile whose content `.env` currently has is marked active. "To environment" copies the keys into a Quiver environment for `{{variables}}`, storing secret-looking ones encrypted; `env.file.export` writes an environment back into a file, updating keys in place.

## MCP

Add Quiver to Claude Code:

```bash
claude mcp add --transport http quiver "http://127.0.0.1:7411/mcp"
```

Append `?workspace=<absolute folder path>` to bind a client to a specific project. Commands flagged as mutating (deletes, database writes) are refused for agents until "Allow mutating commands" is enabled in Settings. `db_query_run` decides per call: `SELECT`, `SHOW`, `EXPLAIN` and read-only Redis commands always work, anything that writes is gated. For Teleport, `teleport_status`, `teleport_db_list`, `teleport_kube_list`, `teleport_db_connect` (start a tunnel, attach a connection), `teleport_pin` and `teleport_cluster_add` are always allowed; `teleport_login`, `teleport_logout`, `teleport_kube_login` (rewrites your kubeconfig), `teleport_db_disconnect` and `teleport_cluster_remove` are gated because they change state your terminal shares or delete pins. Mock servers: listing, saving servers and routes, starting, reading captured requests, `mock_request_wait` and `mock_request_replay` are allowed; `mock_server_stop`, `mock_server_delete`, `mock_route_delete` and `mock_request_clear` are gated. Realtime: listing, saving, `realtime_connect`, `realtime_send` and `realtime_message_wait` are allowed; `realtime_disconnect`, `realtime_connection_delete` and `realtime_message_clear` are gated. `api_graphql_introspect` and `api_graphql_schema` are allowed. MCP inspector: listing, saving, importing, `mcp_connect`, `mcp_ping`, the tool, resource and prompt listings, `mcp_resource_read`, `mcp_prompt_get` and `mcp_log_list` are allowed; `mcp_tool_call` decides per call and lets tools annotated `readOnlyHint` through while gating every other tool; `mcp_disconnect`, `mcp_server_delete`, `mcp_log_clear` and `mcp_request` are gated. Env files: `env_file_list`, `env_file_read` (secret values masked), `env_file_diff`, `env_profile_list`, `env_backup_list` and `env_file_import` are allowed; `env_file_read` with `reveal: true` and every write (`env_file_set`, `env_file_write`, `env_file_unset`, `env_file_create`, `env_file_delete`, `env_file_sync`, `env_profile_use`, `env_backup_restore`, `env_file_export`) is gated.

## Development workflow

Every change is a branch and a pull request against `master`. CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs the typecheck, the unit tests and a production build on Linux and the full smoke test on Windows for each pull request. Branch from a fresh `master`, verify with the three scripts, push, open the pull request (the template asks what changed, how it was verified and for screenshots of UI changes) and merge on green.

[CLAUDE.md](CLAUDE.md) spells this out for Claude Code: start a session in this folder, ask for a feature or a fix, and it comes back as a pull request ready for review. Once enough have merged, cut a release.

## Releasing

Releases are GitHub Releases built by [.github/workflows/release.yml](.github/workflows/release.yml) on Windows, macOS and Linux runners. Installed copies find new versions through the `latest*.yml` manifests electron-builder attaches to the release.

1. On a clean, up-to-date `master`: `npm run release -- minor` (or `patch`, `major`, or an explicit `1.2.3`). This bumps `package.json`, commits `Release vX.Y.Z`, tags `vX.Y.Z` and pushes both.
2. The tag starts the Release workflow. It creates a **draft** release whose notes list the merged pull requests, then each runner builds and uploads its installers and manifests. Allow ten to fifteen minutes.
3. Open the draft on GitHub, read and adjust the notes, and click **Publish release**. Only a published release is visible to installed copies.

The notes are grouped by the labels of the merged pull requests, following [.github/release.yml](.github/release.yml): `breaking`, `enhancement` (New), `design` (Look and feel), `bug` (Fixes), `documentation`, then everything else; `skip-changelog` leaves a pull request out. Pick the bump from what merged since the last tag: `major` for a `breaking` pull request, `minor` for new features or a visible redesign, `patch` for fixes only.

If a build fails, fix it on `master` through a pull request, then move the tag (`git tag -f vX.Y.Z && git push -f origin vX.Y.Z`) or bump again. electron-builder refuses to upload into a release that is already published, so a published version is final.

Local check before tagging: `npm run package` builds the installer for this platform into `release/`; to exercise the updater against it, package a higher version too, serve `release/` over HTTP and run the older `release/win-unpacked/Quiver.exe` with `QUIVER_SMOKE=1 QUIVER_UPDATE_FEED=http://127.0.0.1:<port>/`, which checks, downloads and verifies the newer build without installing it.

Signing is not set up yet. When it is: for Windows add the `WIN_CSC_LINK` (base64 `.pfx`) and `WIN_CSC_KEY_PASSWORD` repository secrets; for macOS add `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`, remove `identity: null` from `electron-builder.yml`, set `mac.notarize: true`, and flip `MAC_SIGNED` in `src/main/updater.ts` so macOS copies update in place.
