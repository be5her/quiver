# Process runner

The project's long-running commands in one place: tasks discovered from `package.json`, Makefiles, justfiles and compose files or saved with the project, started and stopped as whole process trees, with their output, a ready state and their port. Under construction: the module is registered and empty; the plan is in [docs/plans/git-runner-queues.md](../../../../docs/plans/git-runner-queues.md).

<!-- lane:R1 -->
## Tasks

A task is a command line saved with the project, one committed file per task in `.quiver/runner/<id>.json` (store collection `runner`, `RunnerTaskSchema` in `@quiver/core`): `name`, `command`, `cwd` (relative to the workspace, kept with forward slashes; one outside the workspace is refused), `env` entries, an `envProfile`, `autoRestart`, a `readyPattern`, a `port`, and `source` (`saved`, or where a discovered script came from). The supervisor reads the same file each time the task starts. The `env` entries are committed in plain text with the rest of the task, so secrets belong in an env file (gitignored as usual) named by `envProfile`, not in `env`.

- **Discovery.** `runner.task.discover` reads the project's own files (`discover.ts`, with the parsing in `runner-discover.ts` in `@quiver/core`) in the workspace folder and in every workspace package: the folders named by `workspaces` in the root package.json (a list or `{ packages }`) and by pnpm-workspace.yaml, with `*`, `?` and `**` (five levels deep, never into `node_modules`, `.git`, `.quiver` or build output) and `!` exclusions.
  - **package.json scripts**, run with the root's package manager: its `packageManager` field, else its lockfile (`pnpm-lock.yaml`, `yarn.lock`, `package-lock.json`), else npm, as `<pm> run <script>` in the package's folder. Lifecycle scripts (`postinstall`, `prepare` ...) are left out, and so are hooks the way npm sees them: `pre<name>` and `post<name>` when a script `<name>` exists (`prebuild` next to `build`; `preview` only next to a `view`). A workspace package's scripts are named after the package (`@scope/web: dev`).
  - **Makefile targets** (`GNUmakefile`, `makefile`, `Makefile`, the first there is) as `make <target>`: explicit targets only, not special ones (`.PHONY`), pattern rules, targets built from variables, assignments or anything in a `define` block.
  - **justfile recipes** (`justfile`, `Justfile`, `.justfile`) as `just <recipe>`, without private ones (`_name`, or a `private` attribute such as `[private]` or `[no-cd, private]`), settings, aliases and variables.
  - **compose services** (`compose.yaml`, `compose.yml`, `docker-compose.yml`, `docker-compose.yaml`) as `docker compose -f <file> up <service>`, for service names Compose allows (letters, digits, `.`, `_`, `-`).

  Each found script has `source`, `name`, `command`, `cwd` and `file`, and `taskId` once it is saved.

  A cloned project is not trusted, so discovery only reads and runs nothing:
  - **Names in commands.** A saved command is committed and may run under sh or cmd.exe, so a name goes into it as it is when it is plain (letters, digits, `_ : . @ / + = -`), in double quotes when nothing in it means anything to either shell inside them (`"two words"`, `"lint & fix"`), and is left out otherwise: a `"`, `%`, `$`, a backquote, `\`, `!`, a control character, or a leading `-` that the program would read as an option.
  - **Only the workspace folder.** Patterns are read with `/` or `\` and lose empty and `.` segments; one with a `..` segment, a leading slash or a drive letter is ignored. Every folder and file is checked once its symlinks and junctions are resolved, and one outside the workspace folder is not read. `*` and `**` never follow a link.
  - **Bounded work.** `*` and `?` are matched without a regular expression, and the Makefile and justfile lines with expressions that cannot backtrack, so no pattern or line makes the main process hang. A run of `**` counts as one, the patterns list at most 5000 folders in all, at most 200 packages are read, and a file over 2 MB is skipped.
- **Saving.** `runner.task.save` creates a task (no `id`) or updates one: the fields given replace the saved ones, and an empty `readyPattern` or `envProfile`, or a null `port`, clears it. A task without a name is named after its command. A discovered script is saved by passing it as it is; saving the same script (same source, command and folder) again updates its task rather than adding a second one, and keeps the name the task was given. A save is refused without a command, with a folder outside the workspace, or with a ready pattern the supervisor would refuse (one that could backtrack forever). The saves and deletes of a workspace run one after another, so two saves of one script at once still give one task.
- **Deleting.** `runner.task.delete` removes the task's file, then stops it when it is running, waiting to restart or being started (`runner.proc.stop`, the whole tree), and answers `{ deleted, stopped }` with the stopped run. The file goes first so that a start coming in meanwhile finds no task, and stopping rather than refusing means deleting from the panel or by an agent with mutations on never leaves a process without a task. A task id is a file name (letters, digits, `.`, `_`, `-`); anything else is invalid input.
- **Events.** Saves and deletes emit `runner.changed` with reason `tasks` and the `taskId`, besides the store's own `store.changed`.

Commands: `runner.task.list`, `runner.task.discover` and `runner.task.get` read; `runner.task.save` and `runner.task.delete` are mutating.

The smoke section [`tasks.ts`](../../../../src/main/smoke/parts/runner/tasks.ts) opens a fixture project of its own (a package.json with npm workspaces, a lockfile, an included and an excluded workspace package, a package in `node_modules`, a Makefile, a justfile and a compose file, plus hostile parts: workspace patterns with `..` written with `/` and `\`, a package that is a junction to a project outside, script names with a quote, `&` and `%PATH%`, and a justfile over 2 MB) and checks: what discovery finds and what it leaves out, a name with a space in double quotes, names a shell would misread left out, nothing read outside the workspace or from the big file, saving a discovered script into `.quiver/runner/<id>.json`, saving it again keeping one task, its given name and discovery marking it, two saves of one script at once giving one task, a task without a name named after its command, a task with folder, pattern, port and auto restart, an update clearing port and pattern, list, get, a missing task, refused saves (no command, outside folder, unsafe pattern), a delete with an id that is not a file name refused, the `runner.changed` event, the saved npm script running through `runner.proc.start`, deleting a running task stopping it, delete removing the file, and agents listing and discovering over MCP while save and delete are blocked.
<!-- /lane:R1 -->

<!-- lane:R2 -->
## Processes

A saved task runs through the platform shell in its folder (`cwd`, inside the workspace), with the inherited environment plus its env profile (the `.env.<profile>` file in the task's folder or the workspace folder, or a path when the profile has a slash or starts with `.env`) and its enabled `env` entries on top. It is started as a process tree (`spawnTree` in `@quiver/core/node`), so stopping it stops everything it started: taskkill on the tree on Windows, the process group on macOS and Linux, SIGKILL after 5 seconds when SIGTERM is ignored. The supervisor (`supervisor.ts`) keeps everything in memory on this machine.

- **Runs.** Every start is a new run with its own id and output; the last five runs of a task stay readable. Starting a task that is already running gives back its run; `restart` stops it and starts a new run with the saved task as it is now.
- **States.** `starting` until the task is ready: its `readyPattern` (a case-insensitive regular expression, colour codes ignored) printed, or its `port` accepts connections on IPv4 or IPv6 loopback. A task with neither is `running` as soon as it started. A port that another process already holds when the task starts cannot tell when it is ready (the task's own server will not get it): the output says so, and only the ready pattern, if any, counts. `stopping` while a stop waits for the tree to go, then `exited`; a non-zero exit that nobody asked for is `crashed`. A tree that survives both SIGTERM and, 5 s later, SIGKILL (or taskkill) stays `stopping`.
- **Auto restart.** A crashed task with `autoRestart` starts again in the same run after 1 s, then 2 s, 4 s ... up to 30 s; the count goes back to 1 s once a start became ready or stayed up for 10 s. `restarts` counts these, and `restartAt` says when the next one is due. A stop cancels a pending restart. A clean exit (code 0) is not restarted.
- **Output.** stdout and stderr are split into lines into a ring buffer of 5000 lines per run (`RingBuffer` in `@quiver/core`), each with a sequence number from 1, its stream and time, plus `system` lines of Quiver's own (the command, exits, restarts). Text without a line break, such as a prompt, shows once the process has been quiet for 150 ms; a line over 64 KB is cut. `runner.proc.output` reads from a cursor (`after`), pages by `limit` and counts the lines that fell out before they were read (`dropped`).
- **Waiting.** `runner.proc.wait` waits until the current run is ready, or until a line matches a pattern (lines the current process printed before the call count; after an automatic restart, the crashed process's lines do not), up to a timeout, and ends early when the run exits with no restart pending. Patterns, the ready pattern included, run on the main process against every line, so one that could backtrack for ages on a long line is refused: a repeated group with a repeat inside (`(a+)+`, `(\w*,?)*`), a backreference, or more than 512 characters.
- **Input.** `runner.proc.input` writes to the process's stdin as given; end the text with a line break to send a line.
- **Events.** `runner.changed` with reason `state` on every state change, and `output` at most four times a second per run, both with `taskId` and `runId`.
- **Shutdown.** Closing the workspace stops its process trees (`onWorkspaceClose`), and quitting the app stops all of them (`onStop`); both are spread into the module as `procLifecycle`. The shell's `before-quit` does not wait for `onStop`, so an exit handler still sends the kill to every tree left when the main process exits first.

Commands: `runner.proc.list`, `runner.proc.output` and `runner.proc.wait` read; `runner.proc.start`, `runner.proc.stop`, `runner.proc.restart` and `runner.proc.input` are mutating.

The smoke section [`proc.ts`](../../../../src/main/smoke/parts/runner/proc.ts) runs a fixture Node script (Electron's binary as Node) that starts a grandchild, prints `ready on <port>`, leaves a prompt, echoes stdin and crashes or prints 6000 lines on request. It checks: ready by pattern and by port, the output streams, cursor and paged reads, the prompt without a line break, stdin, a wait that times out and one that ends with the run, the 5000-line buffer and `dropped`, output events throttled to four a second, patterns that could backtrack forever refused (as a wait and as a ready pattern) while ordinary ones pass, a port held by another process not counting as ready, a crash restarted after the backoff in the same run and a pattern wait ignoring the crashed process's lines, `restart` as a new run, stop as an exit (not a crash) that does not restart and leaves no process of the tree (grandchild included), the env entries reaching the shell, a failing command's exit code, a task that is not saved, closing a workspace killing its trees, and agents reading and waiting over MCP while start, stop, restart and input are blocked.
<!-- /lane:R2 -->

<!-- lane:RU -->
## The panel

To be written by lane RU.
<!-- /lane:RU -->

<!-- lane:agents -->
## Agents

Listing, getting and discovering tasks (`runner.task.list`, `runner.task.get`, `runner.task.discover`, which only reads the project's files) and reading output are allowed. Saving or deleting tasks, and starting, stopping, restarting or writing to a process, are gated as mutating.
<!-- /lane:agents -->

## Verified by

The smoke part is split per lane: [`src/main/smoke/parts/runner/`](../../../../src/main/smoke/parts/runner); `npm run smoke -- runner` runs it.
