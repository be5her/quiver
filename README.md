# Quiver

A per-project developer toolbelt. Open a folder, and that folder gets its own API requests, environments, database connections, mock servers and small tools, stored as JSON under `.quiver/`. Every feature is also exposed to AI agents through a built-in MCP server.

## Install

Download the build for your platform from the [latest release](https://github.com/be5her/quiver/releases/latest). The builds are not code-signed yet, so each OS asks once before the first launch.

| Platform | File                                                                                  | First launch                                                                                                                                                                                                                                              |
| -------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows  | `Quiver-<version>-setup.exe`                                                          | SmartScreen shows "Windows protected your PC": click _More info_, then _Run anyway_. Updates install in place from the app.                                                                                                                                 |
| macOS    | `Quiver-<version>-mac-arm64.dmg` (Apple silicon), `Quiver-<version>-mac-x64.dmg` (Intel) | Drag Quiver to Applications. The first launch is blocked; open _System Settings → Privacy & Security_ and click _Open Anyway_, or run `xattr -dr com.apple.quarantine /Applications/Quiver.app`. The app announces new versions but, until builds are signed, links to the download instead of replacing itself. |
| Linux    | `Quiver-<version>-linux-x64.AppImage` or `Quiver-<version>-linux-x64.deb`             | `chmod +x` the AppImage and run it; it updates in place. The `.deb` announces new versions and links to the download.                                                                                                                                       |

Quiver looks for a newer release on GitHub shortly after launch and every six hours. When there is one, the status bar shows "Update to vX" (or "vX available" where the build cannot replace itself); nothing is downloaded until you click. Settings → About has "Check for updates", the release notes and a "Restart to install" button once the download is verified. On Windows, **Beta builds** in the same place also offers the build made from every pull request merged into `main`; turning it off never downgrades.

## What is in the box

Each feature is a module with its own README that goes into the details: what it does, where it stores things, and which of its tools agents may call.

| Module | In one line | Details |
| ------ | ----------- | ------- |
| API client | Collections that pass a base URL, headers and auth on to their requests, OAuth 2.0 (client credentials, or a sign-in in a Quiver window), requests with file uploads, checks on responses, collection runs, streamed responses, client certificates and a proxy, their own send options, a Stop button and captures that chain values into the next request, environments with encrypted secrets, responses with the redirect chain, a cookie jar, a JSON path filter, search, image previews and save to file, history with responses to compare side by side, imports from curl (bash, cmd.exe, PowerShell), OpenAPI, Postman, Insomnia and HAR, code in seven languages and tools (curl for bash, cmd.exe and PowerShell), `{{variables}}` everywhere with their value on hover, GraphQL with schema-aware editing. | [packages/modules/src/api](packages/modules/src/api/README.md) |
| Databases | MySQL, PostgreSQL, SQLite and Redis (directly, through a tunnel, or Redis through a Grafana data source): schema tree, a table browser that edits rows, SQL editor with column completion, parameters, cancel and transactions, exports, Redis key browser that edits keys, saved queries, searchable history and schema search. | [packages/modules/src/db](packages/modules/src/db/README.md) |
| Teleport | Several clusters side by side, SSO login, database tunnels that become Quiver connections, and a read-only Kubernetes query view that never touches your terminal's kubectl context. | [packages/modules/src/teleport](packages/modules/src/teleport/README.md) |
| Logs | VictoriaLogs through Grafana: sign in once in a Quiver window with your browser account (Google SSO works), then LogsQL with click-to-filter fields, level chips, a histogram and follow mode. | [packages/modules/src/logs](packages/modules/src/logs/README.md) |
| Metabase | Saved questions, dashboards and native SQL through Metabase, signed in with an API key or your browser account: collections and databases in the sidebar, question parameters, tables browsed with filters, sorting and paging through the query builder with no SQL permission needed, SQL completion from Metabase's metadata, and exports to CSV, JSON and Excel. | [packages/modules/src/metabase](packages/modules/src/metabase/README.md) |
| Queues | Kafka, SQS and RabbitMQ: destinations with counts, peek without consuming, produce, live tail, consumer group lag. In progress. | [packages/modules/src/queues](packages/modules/src/queues/README.md) |
| Mock servers | Local HTTP servers saved with the project: templated routes, forwarding to a real upstream, every request captured, so an empty server is a webhook receiver. | [packages/modules/src/mock](packages/modules/src/mock/README.md) |
| Realtime | WebSocket and Server-Sent Events connections with a live log, a composer, saved messages and automatic reconnects. | [packages/modules/src/realtime](packages/modules/src/realtime/README.md) |
| MCP inspector | Connect to any MCP server, browse and call its tools, resources and prompts, and watch the JSON-RPC traffic. Record what agents call on Quiver's own server. | [packages/modules/src/mcp](packages/modules/src/mcp/README.md) |
| Git | Status, branches, history and diffs, plus pull requests and their CI checks through the GitHub CLI. In progress. | [packages/modules/src/git](packages/modules/src/git/README.md) |
| Process runner | The project's dev servers and scripts started and stopped as process trees, with output, ready state and ports. In progress. | [packages/modules/src/runner](packages/modules/src/runner/README.md) |
| Env files | Every `.env` of the project in one place: masked secrets, edits that keep the file's formatting, compare with the example, profiles, history. | [packages/modules/src/env](packages/modules/src/env/README.md) |
| Todo | A plain list for the day, per workspace and per machine. | [packages/modules/src/todo](packages/modules/src/todo/README.md) |
| Tools | JSON format, JWT decode and signature check, base64, URL encode, hash, UUID, timestamp. | [packages/modules/src/tools](packages/modules/src/tools/README.md) |

Around the modules, the shell gives you a workspace model (several folders open at once, per-workspace tabs restored on return and after a restart, tabs, workspaces and the activity bar arranged by dragging), a command palette (`Ctrl+K`), light and dark themes in six brand palettes, and the MCP server below. [src/renderer/README.md](src/renderer/README.md) describes the shell, [packages/core/README.md](packages/core/README.md) the engine and where everything is stored.

The first planned scope is complete. Ideas for later: gRPC, Docker, S3, a plugin loader for module manifests.

## MCP

Every command is a tool over Streamable HTTP on `http://127.0.0.1:7411/mcp`. Add Quiver to Claude Code:

```bash
claude mcp add --transport http quiver "http://127.0.0.1:7411/mcp"
```

Append `?workspace=<absolute folder path>` to bind a client to a specific project. Commands flagged as mutating (deletes, database writes, anything that changes state your terminal shares) are refused for agents until "Allow mutating commands" is enabled in Settings; some tools decide per call, such as `db_query_run`, which lets `SELECT` through and gates writes. Secrets are always masked for agents. Each module's README lists which of its tools are allowed and which are gated. Of the app's own tools, `app_update_check` is allowed; `app_update_download`, `app_update_install` and `app_update_channel` are gated.

To see what agents actually do, record their calls: the call recorder in the MCP inspector keeps every tool call that reaches this server between Start and End, with the agent that made it, its arguments and its result, and saves the recording to a file. See the [MCP inspector](packages/modules/src/mcp/README.md#call-recorder).

## Run

```bash
npm install
npm run dev
```

Node 22.22.3 or later is needed (on Node 24, 24.15 or later), the minimum of the Angular CLI that builds the renderer.

| Script                 | What it does                                                                                                      |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `npm test`             | Unit tests for the core engine (vitest).                                                                          |
| `npm run typecheck`    | Type-checks the main process and the renderer separately.                                                         |
| `npm run smoke`        | Builds, then runs a headless end-to-end check of every module against local fakes and exits. `npm run smoke -- db teleport` runs only those parts (one per module, plus `shell`; `--list` names them), for quick runs while working on a change; the whole smoke runs before committing. `--shots` (or `QUIVER_SMOKE_SHOTS=<dir>`) adds the UI checks and captures screenshots; `QUIVER_SMOKE_MYSQL=mysql://user:pass@host:3306/db` or `QUIVER_SMOKE_POSTGRES=postgres://user:pass@host:5432/db` also exercises a live server. It uses a private MCP port, so a Quiver you have open is left alone. Each module's README says what its part of the smoke covers; [src/main/smoke/README.md](src/main/smoke/README.md) explains the rest. |
| `npm run package`      | Builds the installer for this platform into `release/` with electron-builder, without publishing.                |
| `npm run icon`         | Renders `resources/icon.svg` to `resources/icon.png`, the source of every platform icon.                          |
| `npm run release:plan` | Previews the next stable release from the current checkout. Needs the GitHub CLI signed in; see [docs/releasing.md](docs/releasing.md). |

## Layout

```
packages/core      Engine: command registry, models, variable resolution, file store. No Electron or UI framework.
packages/ui        Host contract for the renderer: state services, IPC client, shared Angular components.
packages/modules   One folder per feature. `main.ts` (Node side), `ui/` (Angular side) and `README.md` per module.
packages/mcp       Adapts the command registry to an MCP server.
src/main           Electron main process: host wiring, IPC, window, and the smoke test in src/main/smoke.
src/preload        The only bridge between renderer and main (three functions).
src/renderer       The Angular app and the shell: title bar, activity bar, sidebar, tabs, status bar, palette, settings.
```

A feature is a set of commands (`defineCommand` with a zod input schema, validated on every call and turned into the MCP tool schema for free) plus UI. Commands are the only way the UI talks to the host, so anything you add is reachable from the palette, from MCP and from a future CLI without extra work. [CLAUDE.md](CLAUDE.md) walks through adding a module and the conventions.

## Development workflow

Every change is a branch and a pull request against `main`. CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs the typecheck, the unit tests and a production build on Linux and the full smoke test on Windows for each pull request. Branch from a fresh `main`, verify with the three scripts, push, open the pull request (the template asks what changed, how it was verified and for screenshots of UI changes) and merge on green.

Label each pull request before merging: `breaking`, `enhancement` (New), `design` (Look and feel), `bug` (Fixes) or `documentation`. The labels group the release notes and decide the next version; `skip-changelog` leaves a pull request out of the notes.

[CLAUDE.md](CLAUDE.md) spells this out for Claude Code: start a session in this folder, ask for a feature or a fix, and it comes back as a pull request ready for review. Every merge ships as a Windows beta; once enough have merged, release them as stable. How the betas and stable releases are built and published is in [docs/releasing.md](docs/releasing.md).

## License

[MIT](LICENSE). The Quiver name and logo are not part of the license: use the code freely, but call a fork something else.
