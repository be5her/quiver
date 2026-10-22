# Command line

`quiver` runs any Quiver command from a terminal or CI: the same commands the palette and the MCP server run, with the same input. It works two ways, with one command line:

- **Connected** (the default): it talks to the Quiver you have open, so a command sees the same workspaces, environments, connections and running servers as the app.
- **Headless** (`--headless`): it starts Quiver's host in its own process, with no window and no app running. This is the mode for CI.

```bash
quiver list git                                   # the git commands
quiver describe todo.add                          # a command's fields and an example
quiver todo.add --title "write the release notes" # run one
quiver --headless api.collection.run --collection <id> --reporter junit --out results.xml
```

## Install

Installed builds carry two shims in their resources folder: `quiver.cmd` on Windows, a `quiver` sh script on macOS and Linux. They run the Quiver binary as Node (`ELECTRON_RUN_AS_NODE=1`) on the CLI script inside `app.asar`, so there is nothing else to install. **Settings → Command line** shows the folder and a copyable line per shell to put it on PATH; Quiver never edits PATH itself.

| Platform | Shim folder | Typical install |
| -------- | ----------- | --------------- |
| Windows | `<install folder>\resources\cli` | `%LOCALAPPDATA%\Programs\Quiver\resources\cli` |
| macOS | `/Applications/Quiver.app/Contents/Resources/cli` | add it to PATH, or symlink `quiver` into `/usr/local/bin` |
| Linux (.deb) | `/opt/Quiver/resources/cli` | same |

An AppImage mounts somewhere new on every launch, so its folder changes; use the `.deb` for the command line.

From a checkout, `npm run cli -- <args>` does the same: it rebuilds `out/main` when a source changed (the build's output goes to stderr) and runs `out/main/cli.js` with Node.

## Running commands

```
quiver list [module] [--all]          the commands (id, title, whether it changes data); --all adds the hidden ones
quiver describe <command>             a command's description, fields, input JSON Schema and an example
quiver <command> [fields]             run it; quiver run <command> works too, and quiver <command> --help describes it
```

A command's input comes from its fields:

- `--<field> <value>` or `--<field>=<value>` sets one field. The value is read as the command's schema says: numbers, `true`/`false`, `null` where the field takes it, and JSON for objects and arrays. A string field keeps `42` as text.
- A bare `--<field>` is `true`; `--no-<field>` is `false`.
- `--<field>.<key> <value>` sets a nested field (`--auth.type bearer`). An array field given more than once collects the values (`--paths a.txt --paths b.txt`).
- Names may be written in kebab-case (`--environment-id`) and may leave off a trailing `Id` (`--collection` for `collectionId`).
- `--input '<json>'`, `--input @file.json` or `--input @-` (stdin) gives the whole input; fields given as flags go on top of it. On Windows, PowerShell and cmd strip the double quotes inside JSON on its way to `quiver.cmd`, so there use field flags, `@file.json` or `@-`. `quiver.cmd` is a batch file, so `cmd.exe` reads its arguments again: a value holding `&`, `|`, `<`, `>` or `^` must be quoted (`--url "https://x/?a=1&b=2"`), and a script must never pass untrusted text to it unquoted, or `cmd.exe` runs what follows the `&` as a command of its own.

An unknown field is refused rather than dropped, so a typo never runs a command with less than you meant. Values that start with `--` need the `=` form. A field named like one of the options below (the `secrets` of `env.file.import` and `queues.connection.save`) goes in `--input`.

Options, anywhere on the line:

| Option | |
| ------ | - |
| `--workspace <folder>` | The project a workspace command runs in. Without it, the nearest folder up from the current one that has a `.quiver` folder; connected, with none found, the workspace the app shows; headless, the current folder. Global commands ignore it. |
| `--json` | JSON output. The default when stdout is not a terminal, so `quiver ... \| jq` just works; `--json=false` forces text. |
| `--quiet`, `-q` | Print nothing on success; errors still go to stderr. |
| `--timeout <seconds>` | Give up after this long (`30`, `1.5`, `500ms`, `2m`), exit 1 with `TIMEOUT`. A command that times out, or is stopped with Ctrl+C, is cancelled in the app too: the endpoint aborts it when the CLI stops waiting, and a collection run is cancelled. A command that cannot be interrupted (a git push under way, say) finishes in the app. Without it a call waits as long as the command takes. |
| `--headless`, `--headless=auto` | Run in this process; `auto` connects when the app answers and runs headless when it does not. |
| `--data-dir <folder>` | Headless: where the global config and per-machine state go. Default `quiver-cli` in the OS application data folder (beside the app's `Quiver`), or `QUIVER_DATA_DIR`. |
| `--secrets <file.json>` | Headless: secret values by name (see below). |
| `--user-data-dir <folder>` | Connected: the app's user data folder, when it is not the default (an app started with `--user-data-dir`), or `QUIVER_USER_DATA_DIR`. |
| `--reporter junit [--out <file>]` | `api.collection.run` only: a JUnit XML report, to the file or to stdout. |

## Output and exit codes

The result goes to stdout: JSON in JSON mode; in a terminal, text as it is and anything else indented, `list` as a table, `describe` as fields and an example, and a collection run as one line per request.

| Code | Meaning |
| ---- | ------- |
| 0 | The command ran. |
| 1 | The command failed. Its error is on stderr as JSON: `{ "code": "NOT_FOUND", "message": "…", "details": … }`. |
| 2 | Bad usage, or input the command refused (`INVALID_INPUT`, `UNKNOWN_COMMAND`). Usage errors are one `quiver: …` line on stderr. |
| 3 | Connected mode found no Quiver to talk to. |
| 4 | The command ran and its result reports failed checks: a collection run with a failed request or that was cancelled before its end, or a sent request whose checks failed. |

## Connected mode

While its MCP server listens, the app writes two files in its user data folder (`%APPDATA%\Quiver`, `~/Library/Application Support/Quiver`, `~/.config/Quiver`): `cli-endpoint.json` with the port, and `cli-token` with a random token, readable by the user only and made anew on every start. The CLI reads both, checks the app answers, and sends each call to `POST http://127.0.0.1:<port>/cli` with the token in the `x-quiver-cli-token` header and `{ command, input, workspace }` as the body. The endpoint shares the MCP server's port, so it is off while the MCP server is turned off in Settings (`--headless` still works). The endpoint file goes away when the server stops.

A request without the right token is refused, and so is any request with an `Origin` header, whatever its token: a browser always sends one, so a web page open on this machine cannot reach the endpoint. Quiver never sends the token header on an agent's behalf: the API client refuses a request that carries it, and realtime connections, MCP server connections and mock replays and forwards drop it, so an agent that read the token file cannot relay calls to the endpoint through an open tool. On Windows the token file is protected by the user data folder's permissions (the user's profile), not by a file mode.

The command runs as caller `cli`: the user's own process, with the user's rights. Agent permissions do not apply to it (they are for `mcp` callers only), and results are not masked: `quiver api.environment.get` shows secret values the way the app's own editor does. A workspace command runs in the folder the call names; a folder the app does not have open is opened for the call, as with an MCP client's `?workspace=`, without being added to the ones reopened on the next start.

Pausing agents, the permission mode and the allow, ask and deny rules in Settings > MCP leave the CLI alone, and it never raises an approval. The checks that protect the user from a slip still apply, the same as in the window: a Kubernetes action on a protected cluster needs the cluster's name typed, given as `--confirm-cluster <name>` (`quiver teleport.kube.action --proxy <proxy> --cluster prod-eks --confirm-cluster prod-eks --input @action.json`), and git's own refusals stand, such as deleting the current branch, or an unmerged one without `--force`.

## Headless mode

`--headless` boots the host in plain Node, with no Electron: every module, its commands and its storage, against `--data-dir` for the global config and per-machine state and the workspace folder for the project. No MCP server or command line endpoint is started. A workspace opened headless starts what it would start in the app (mock servers and connections marked to start on open), so a collection can run against a mock server the project defines. Module log lines go to stderr, or nowhere with `--quiet`.

There is no OS keychain, so secrets the app encrypted on this machine cannot be read. A command that needs one fails with `SECRET_UNAVAILABLE`, naming what to set, rather than sending an empty value. Secrets come in by name instead:

- `QUIVER_SECRET_<NAME>`: the name upper-cased, with camelCase and anything that is not a letter or digit turned into `_` (`token` is `QUIVER_SECRET_TOKEN`, `apiToken` and `api.token` are `QUIVER_SECRET_API_TOKEN`);
- `--secrets <file.json>`: an object of name to value, which wins over the variables.

Today that covers the API client's environments: a secret variable takes its value from its name, and that value is used for the run and never written to the project. What a headless command stores itself (a cookie jar, an OAuth token, a secret you save) is kept unencrypted (`plain:`) under `.quiver/local`, as the app does on a machine without a keychain; on your own machine, run such commands connected. A cookie jar the app encrypted is the exception: a headless run leaves it as it is and keeps the cookies its requests receive in memory for the run.

## CI: running a collection

`api.collection.run` answers at once with a run id in the app; the CLI follows the run to its end, so its result is the finished run. With `--reporter junit` it writes one test suite per run and one test case per request: a request whose checks failed is a `<failure>` with the checks' messages, one with no response an `<error>`, one that never ran `<skipped>`. The exit code is 4 when a request failed.

```yaml
# .github/workflows/api.yml (the runner needs Quiver installed, or a checkout with npm run cli)
- run: quiver --headless api.collection.run --collection 3f2a9c1d --environment staging-env-id --reporter junit --out results.xml
  env:
    QUIVER_SECRET_TOKEN: ${{ secrets.API_TOKEN }}
- uses: mikepenz/action-junit-report@v5
  if: always()
  with:
    report_paths: results.xml
```

The collection, its requests and the environment are the committed files under `.quiver/`, so the checkout is all a run needs; `--environment` picks the environment by id, since the active one is a per-machine choice the checkout does not have.

## Not covered

Editing PATH, shell completion and talking to a Quiver on another machine are left out. The CLI only ever connects to `127.0.0.1`.

## Verified by

Unit tests in `packages/core/src/cli-args.test.ts` (argument parsing, flags to input against a command's schema, describe's example, exit codes, secret names, PATH lines) and `packages/core/src/junit.test.ts` (the JUnit report), and `packages/mcp/src/cli-endpoint.test.ts` for the endpoint (token, `Origin`, method and body checks). The smoke's `cli` part ([src/main/smoke/parts/cli.ts](../src/main/smoke/parts/cli.ts)) runs the built CLI the way the shims do, as Electron in Node mode: in connected mode `list`, `describe`, a read command in the workspace with its secret unmasked, a mutating command an agent is refused, the new git and kube commands listed with whether they change data, `git.status` and a gated `git.branch.create` run while a `git.*` deny rule refuses agents and while agents are paused, invalid input and unknown fields exiting 2, a failing command exiting 1 with its error on stderr, the endpoint refusing a wrong or missing token and an `Origin` header, the API client refusing to send the token header (for an agent and the UI), a realtime SSE connection to the endpoint dropping it, exit 3 with no app and `--headless=auto` falling back; headless, a todo added and listed in a temporary workspace, a secret from `QUIVER_SECRET_TOKEN` and from `--secrets`, `SECRET_UNAVAILABLE` for one the app encrypted, a cookie jar the app encrypted left in place, collection runs against the local echo server with a JUnit report and exit codes 4 and 0, and no handed-in secret written to the project. With `--shots` it checks the Settings section (`40a-settings-cli-light.png`, `40b-settings-cli-dark.png`). `npm run smoke -- cli --shots` runs it alone.
