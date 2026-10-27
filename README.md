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
| Teleport | Several clusters side by side, SSO login with certificates renewed before they expire, database tunnels that become Quiver connections, and a Kubernetes view that never touches your terminal's kubectl context: read-only queries, typed write actions behind a confirmation, port forwards and protected clusters. | [packages/modules/src/teleport](packages/modules/src/teleport/README.md) |
| Logs | VictoriaLogs through Grafana: sign in once in a Quiver window with your browser account (Google SSO works), then LogsQL with click-to-filter fields, level chips, a histogram and follow mode. | [packages/modules/src/logs](packages/modules/src/logs/README.md) |
| Metabase | Saved questions, dashboards and native SQL through Metabase, signed in with an API key or your browser account: collections and databases in the sidebar, question parameters, tables browsed with filters, sorting and paging through the query builder with no SQL permission needed, SQL completion from Metabase's metadata, and exports to CSV, JSON and Excel. | [packages/modules/src/metabase](packages/modules/src/metabase/README.md) |
| Queues | Kafka, SQS and RabbitMQ connections with encrypted secrets: topics and queues with their counts, peeks that consume nothing, a producer with saved messages, live tails with filters, Kafka consumer group lag, and purge, create and delete behind a confirmation. | [packages/modules/src/queues](packages/modules/src/queues/README.md) |
| Mock servers | Local HTTP servers saved with the project: templated routes, forwarding to a real upstream, every request captured, so an empty server is a webhook receiver. | [packages/modules/src/mock](packages/modules/src/mock/README.md) |
| Realtime | WebSocket and Server-Sent Events connections with a live log, a composer, saved messages and automatic reconnects. | [packages/modules/src/realtime](packages/modules/src/realtime/README.md) |
| MCP inspector | Connect to any MCP server, browse and call its tools, resources and prompts, and watch the JSON-RPC traffic. Record what agents call on Quiver's own server. | [packages/modules/src/mcp](packages/modules/src/mcp/README.md) |
| Git | Stage, commit, discard, pull and push with whole-file side-by-side or inline diffs, the history and blame of any file at any commit; branches and tags with merge, rebase, clean-up and deletion on the remote, stashes, cherry-pick, revert and reset, a banner to continue or abort a merge or rebase, and a conflict editor to accept current, incoming or both per conflict and mark the file resolved; worktrees to add, open as workspaces, lock and remove, with everything working inside a linked worktree too; plus pull requests through the GitHub CLI signed in as you: lists with check badges, the conversation, failed CI logs, files, comments, checkout, a todo from a pull request, a new pull request's title and description drafted from the branch's commits and files into the repository's template, and the branch in the status bar. | [packages/modules/src/git](packages/modules/src/git/README.md) |
| Process runner | The project's npm scripts, Makefile targets, just recipes and compose services, found or saved as tasks, started and stopped as whole process trees: coloured output with search, stdin, a ready state from a pattern or a port, auto restart, env profiles, and the running count in the status bar. | [packages/modules/src/runner](packages/modules/src/runner/README.md) |
| Env files | Every `.env` of the project in one place: masked secrets, edits that keep the file's formatting, compare with the example, profiles, history. | [packages/modules/src/env](packages/modules/src/env/README.md) |
| Todo | A plain list for the day, per workspace and per machine. | [packages/modules/src/todo](packages/modules/src/todo/README.md) |
| Tools | JSON format, JWT decode and signature check, base64, URL encode, hash, UUID, timestamp. | [packages/modules/src/tools](packages/modules/src/tools/README.md) |
| Command line | `quiver`: any command from a terminal or CI, connected to the running app or headless without it, with typed `--field` flags, exit codes and a JUnit reporter for collection runs. | [docs/cli.md](docs/cli.md) |

Around the modules, the shell gives you a workspace model (several folders open at once, per-workspace tabs restored on return and after a restart, tabs, workspaces and the activity bar arranged by dragging), a command palette (`Ctrl+K`), light and dark themes in six brand palettes, and the MCP server below. [src/renderer/README.md](src/renderer/README.md) describes the shell, [packages/core/README.md](packages/core/README.md) the engine and where everything is stored.

The first planned scope is complete. Ideas for later: gRPC, Docker, S3, a plugin loader for module manifests.

## MCP

Every command is a tool over Streamable HTTP on `http://127.0.0.1:7411/mcp`. Add Quiver to Claude Code:

```bash
claude mcp add --transport http quiver "http://127.0.0.1:7411/mcp"
```

Append `?workspace=<absolute folder path>` to bind a client to a specific project. Secrets are always masked for agents. Each module's README lists which of its tools are allowed and which are gated. Of the app's own tools, `app_update_check` is allowed; `app_update_download`, `app_update_install` and `app_update_channel` are gated.

### Agent permissions

Commands that only read are open to agents. Commands flagged as mutating (deletes, database writes, anything that changes state your terminal shares) get what the permission mode in Settings > MCP says: refused (read-only, the default), **ask** each time, or allowed. Some tools decide per call, such as `db_query_run`, which lets `SELECT` through and gates writes.

Rules come before the mode, per tool: a command id (`db.query.run`), a module (`git.*`, or a narrower `git.branch.*`) or `*`, with allow, ask or deny. A rule can ask about or deny a read-only tool too. Tools that do several things say what each call does, so a rule can name one action of a full command id with `#<action>`: `db.query.run#ddl` (a `CREATE TABLE`, but not a `SELECT` or an `INSERT`), `teleport.kube.action#delete`, `git.push#force`; which tools have actions, and what they are, is in each module's README (db, teleport and git have them), in Settings' Action picker, and from `mcp.permissions.actions`. A rule can also carry `agent`, the client name from the MCP handshake as the activity feed shows it, and then applies to that agent only. That name is whatever the client says it is called, and any MCP client can give any name: an allow for one agent lets through every client that calls itself that, and a deny for one stops only the clients that do, so keep allows for every agent no wider than you would give any of them, and use per-agent rules to hold one agent back. A deny wins over everything; on a whole tool it leaves the tool out of `tools/list`, while a deny on one action leaves it listed (its other actions may be allowed). Otherwise the most specific rule decides (`id#action` beats the id, which beats a module, which beats `*`; at the same level a rule for this agent beats one for every agent), and a workspace's own rules come before the global ones. A call whose action cannot be told is matched by the rules for the whole tool only, and counts as one that changes data, so the mode decides it when none of them does. A workspace's allow rules only count for the commands that work on the workspace; for global ones (Teleport, app updates, global variables) only its deny and ask rules do, so a loose rule in a scratch workspace never lets an agent connected there do more elsewhere. Both are kept in Quiver's config on this machine, never in the project: a file in the project could come from anyone who can commit to it, and a workspace rule can allow more than the global ones. A config from before permissions keeps its meaning: "Allow mutating commands" on is mode allow, off is read-only. Tool descriptions tell agents which tools ask first.

When a call needs asking, Quiver shows the agent (named from the MCP handshake), the tool and its action (`db.query.run · ddl`), the workspace and the arguments with credentials masked, one call at a time, with a system notification when the window is in the background. The dialog takes the focus itself, not a button, so a key typed for the page underneath answers nothing. Allow once, allow the tool for that agent until Quiver restarts, always allow it (which adds an allow rule: to the workspace's rules when one of them is what asked, since it would beat a global allow, otherwise to the global ones, and lets through the other waiting calls that rule allows; for a call with an action, **Always allow** offers the action, a `db.query.run#insert` rule, or the whole tool, and drops an ask rule as specific that would still ask), or deny. A call the user allows is decided again before it runs, so a pause, read-only mode or a deny rule set while it waited still wins. Unanswered after 120 seconds, the call is refused; a call whose agent closes the connection or cancels it stops waiting at once, so a late answer cannot run it. Refusals come back as `MUTATION_BLOCKED` with `details.reason`: `read-only`, `rule`, `denied`, `approval-timeout`, `paused`, `cancelled`, or `no-approver` in a Quiver without a window; `details.action` names the call's action when the tool has one, and a `rule` refusal carries the rule that decided.

**Pause agents**, in the status bar and in Settings, refuses every MCP call (those waiting for an answer included) until resumed, without changing the tool list. The status bar shows agent calls in the last minute and the approvals waiting; a click opens the **Agent activity** tab with the last 200 calls (agent, tool and its action, workspace, decision, outcome, duration; never arguments or results). Permissions apply to MCP callers only: the window and the command line are the user.

The same port serves the `quiver` command line at `/cli`, behind a per-start token; it runs commands as you, so the agent permissions, approvals, pause and masking are for agents only ([docs/cli.md](docs/cli.md)).

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
| `npm run smoke`        | Builds, then runs a headless end-to-end check of every module against local fakes and exits. `npm run smoke -- db teleport` runs only those parts (one per module, plus `shell` and `cli`; `--list` names them), for quick runs while working on a change; the whole smoke runs before committing. `--shots` (or `QUIVER_SMOKE_SHOTS=<dir>`) adds the UI checks and captures screenshots; `QUIVER_SMOKE_MYSQL=mysql://user:pass@host:3306/db` or `QUIVER_SMOKE_POSTGRES=postgres://user:pass@host:5432/db` also exercises a live server. It uses a private MCP port, so a Quiver you have open is left alone. Each module's README says what its part of the smoke covers; [src/main/smoke/README.md](src/main/smoke/README.md) explains the rest. |
| `npm run cli -- <args>` | Runs the `quiver` command line from this checkout, rebuilding it first when a source changed: `npm run cli -- list`, `npm run cli -- --headless todo.list`. Installed builds ship it as a shim to put on PATH (Settings → Command line). See [docs/cli.md](docs/cli.md). |
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
src/cli            The `quiver` command line: connected to the app, or the host in plain Node (headless).
src/preload        The only bridge between renderer and main (three functions).
src/renderer       The Angular app and the shell: title bar, activity bar, sidebar, tabs, status bar, palette, settings.
```

A feature is a set of commands (`defineCommand` with a zod input schema, validated on every call and turned into the MCP tool schema for free) plus UI. Commands are the only way the UI talks to the host, so anything you add is reachable from the palette, from MCP and from the `quiver` command line without extra work. [CLAUDE.md](CLAUDE.md) walks through adding a module and the conventions.

## Development workflow

Every change is a branch and a pull request against `main`. CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs the typecheck, the unit tests and a production build on Linux and the full smoke test on Windows for each pull request. Branch from a fresh `main`, verify with the three scripts, push, open the pull request (the template asks what changed, how it was verified and for screenshots of UI changes) and merge on green.

Label each pull request before merging: `breaking`, `enhancement` (New), `design` (Look and feel), `bug` (Fixes) or `documentation`. The labels group the release notes and decide the next version; `skip-changelog` leaves a pull request out of the notes.

[CLAUDE.md](CLAUDE.md) spells this out for Claude Code: start a session in this folder, ask for a feature or a fix, and it comes back as a pull request ready for review. Every merge ships as a Windows beta; once enough have merged, release them as stable. How the betas and stable releases are built and published is in [docs/releasing.md](docs/releasing.md).

## License

[MIT](LICENSE). The Quiver name and logo are not part of the license: use the code freely, but call a fork something else.
