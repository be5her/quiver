# Plan: Git/PR, Process runner, Queues

**Status: complete.** All four waves are merged (pull requests #29 to #42 and the wave 3 integration); what is left is listed under [Done / follow-ups](#done--follow-ups) at the end.

Three new modules built by parallel agents. The approach: **one scaffold PR first** takes every shared file (registries, events, deps, lockfile, smoke index, README table). After it merges, each lane owns its own folder and files, so lanes never edit the same file.

## Conflict hotspots (scaffold only)

Only the scaffold (W0) touches these files. Later lanes never edit them.

| File | Why it conflicts |
| --- | --- |
| `packages/modules/src/main.ts`, `ui.ts` | module arrays |
| `tsconfig.node.json` | `include` list |
| `src/main/smoke/index.ts` | part imports |
| `packages/core/src/types.ts` | `HostEvents` |
| `packages/core/src/index.ts` | exports; the scaffold already exports the four empty core modules the lanes fill (`git-parse`, `gh-parse`, `runner-discover`, `ring-buffer`) |
| `package.json`, `package-lock.json` | new deps |
| `electron.vite.config.ts` | `externalRuntimeDeps`: the new deps stay outside the main bundle |
| `src/main/smoke/fixtures.ts` | the shared fakes; a lane's own fake (`fake-gh.ts`, `fake-sqs.ts`) is started and stopped by its smoke section instead |
| `README.md` | module table |

---

## Wave 0: scaffold (1 agent, 1 PR, merge before anything else)

Branch `feat/scaffold-git-runner-queues`, label `enhancement`.

1. **Modules registered as stubs:** `git`, `runner`, `queues`. Each has `main.ts` (module with an empty `commands` array), `ui/index.ts` (empty view plus an activity-bar entry), and a `README.md` skeleton. All three are added to `main.ts`, `ui.ts` and `tsconfig.node.json`.
2. **Commands split by lane file**, so lanes never share `main.ts`:
   - `git/main.ts` → `commands: [...localCommands, ...prCommands]` from `git/commands-local.ts`, `git/commands-pr.ts`
   - `runner/main.ts` → `commands: [...taskCommands, ...procCommands]` from `runner/commands-tasks.ts`, `runner/commands-proc.ts`
   - `queues/main.ts` → `commands` from `queues/commands.ts`. The drivers live in `queues/drivers/{index,memory,kafka,sqs,rabbit}.ts`. `index.ts` maps `kind → driver`, and each non-memory file starts as a stub that throws `not implemented`.
3. **Contracts in core** (types only, no logic): `packages/core/src/models/{git,runner,queues}.ts`. They hold every command's zod input schema and output type, listed below. Lanes implement against them. Changing a contract needs a note in the PR and a ping to the UI lane.
4. **Shared process helper:** `packages/core/src/node/process.ts` (`@quiver/core/node`) with `spawnTree`, `killTree` (taskkill `/T /F` on Windows, process group elsewhere), `whichSync` and `runToEnd`, plus unit tests. It grew out of `teleport/tsh.ts`, which now imports `killTree` and `whichSync` from it instead of keeping its own copies.
5. **Events in `HostEvents`:**
   - `'git.changed': { workspaceId; reason: 'status' | 'branches' | 'prs' }`
   - `'runner.changed': { workspaceId; reason: 'tasks' | 'state' | 'output'; taskId?: string }`
   - `'queues.changed': { workspaceId; reason: 'connections' | 'messages' | 'consumer'; consumerId?: string }`
6. **Dependencies, all added now** so no lane touches the lockfile:
   - `kafkajs` (pure JS, no native build for Electron; see decision 4)
   - `@aws-sdk/client-sqs`
   - `amqplib` (it ships its own types)
   All three are listed in `electron.vite.config.ts` as external, so a lane importing one does not get it bundled into the main process.
7. **Smoke:** `parts/git.ts`, `parts/runner.ts`, `parts/queues.ts`, registered in `index.ts`. Each part runs its section files in order through `runSections`; they start empty:
   - `parts/git/{local,pr,ui}.ts`
   - `parts/runner/{tasks,proc,ui}.ts`
   - `parts/queues/{memory,kafka,sqs,rabbit,ui}.ts`
8. **Error code:** `NOT_SUPPORTED`, for what a broker or driver cannot do.
9. **Docs:** add a README table row per module. Each module README gets one section per lane, marked with an HTML comment naming the lane (wave 3 removed the markers); a lane edits only its own section.

Done when typecheck, tests and the full smoke pass, and the three empty modules appear in the activity bar.

---

## Wave 1: host side (7 agents in parallel, after W0 merges)

Each lane: its own branch and PR, owns only the files listed, adds unit tests in `packages/core` for pure parsing, and fills its smoke section file.

### G1: Git local (`fix`/`feat/git-local`)
- **Owns:** `git/local.ts`, `git/commands-local.ts`, `core/src/git-parse.ts` (+test), `smoke/parts/git/local.ts`
- **How:** runs the `git` CLI through `spawnTree`. Parses `status --porcelain=v2 -b`, `log --format` with NUL separators, and `diff --numstat`/patch.
- **Commands:**
  - `git.status`
  - `git.branch.list`
  - `git.log` (paged, by path)
  - `git.diff` (working, staged, or between two refs)
  - `git.show`
  - `git.fetch`
  - `git.checkout` (mutating)
  - `git.branch.create` (mutating)
  - `git.stage` / `git.unstage` (mutating)
  - `git.commit` (mutating)
  - `git.pull` (mutating)
  - `git.push` (mutating)
- **Watcher:** an fs watch on `.git/HEAD`, `.git/index` and `refs`, debounced to `git.changed`.
- **Smoke:** a temp repo fixture; it checks status, a commit, branch switching and a diff.

### G2: Git PRs (`feat/git-pr`)
- **Owns:** `git/pr.ts`, `git/commands-pr.ts`, `core/src/gh-parse.ts` (+test), `smoke/parts/git/pr.ts`, `smoke/fake-gh.ts`
- **How:** uses the `gh` CLI with `--json`, so the user's own auth is used and Quiver stores no token. If `gh` is missing or signed out, it reports a clear status.
- **Commands:**
  - `git.pr.status` (gh present, auth, repo)
  - `git.pr.list` (mine, review requested, all)
  - `git.pr.get` (body, reviews, files)
  - `git.pr.checks` (CI runs plus a failed-log excerpt)
  - `git.pr.diff`
  - `git.pr.checkout` (mutating)
  - `git.pr.create` (mutating)
  - `git.pr.comment` (mutating)
  - `git.pr.open` (browser)
- **Polling:** every 60s while the view is open, emitting `git.changed{prs}`.
- **Smoke:** `fake-gh.ts`, modelled on `fake-tsh.ts`, but written to a temp dir and cleaned up by `smoke/parts/git/pr.ts` itself (its `after` hook), not by `fixtures.ts`.

### R1: Runner tasks (`feat/runner-tasks`)
- **Owns:** `runner/tasks.ts`, `runner/discover.ts`, `runner/commands-tasks.ts`, `core/src/runner-discover.ts` (+test), `smoke/parts/runner/tasks.ts`
- **Discovery:**
  - `package.json` scripts (npm, pnpm or yarn, picked from the lockfile)
  - `Makefile` targets
  - `justfile`
  - `docker-compose` services
- **Saved tasks:** `.quiver/runner/<id>.json` = `{ name, command, cwd, env, envProfile?, autoRestart, readyPattern?, port? }`
- **Commands:**
  - `runner.task.list`
  - `runner.task.discover`
  - `runner.task.get`
  - `runner.task.save` (mutating)
  - `runner.task.delete` (mutating)

### R2: Runner processes (`feat/runner-proc`)
- **Owns:** `runner/supervisor.ts`, `runner/commands-proc.ts`, `core/src/ring-buffer.ts` (+test), `smoke/parts/runner/proc.ts`
- **Supervisor:**
  - starts, stops and restarts tasks with `spawnTree`/`killTree`
  - keeps the last 5k lines per run in a ring buffer
  - marks a task ready when its `readyPattern` matches or its `port` opens
  - restarts with backoff when `autoRestart` is set
  - kills everything on workspace close and on app quit
- **Commands:**
  - `runner.proc.list` (state, pid, uptime, port)
  - `runner.proc.start` (mutating)
  - `runner.proc.stop` (mutating)
  - `runner.proc.restart` (mutating)
  - `runner.proc.output` (cursor-based read)
  - `runner.proc.wait` (until ready or a pattern, with a timeout)
  - `runner.proc.input` (stdin, mutating)
- **Events:** `runner.changed{state|output}`, throttled to 4/s.
- **Smoke:** a fixture node script that prints "ready on 4xxx", then crashes on request.

### Q1: Queues core + Kafka (`feat/queues-kafka`)
- **Owns:** `queues/commands.ts`, `queues/drivers/{memory,kafka}.ts`, `queues/consumers.ts`, `smoke/parts/queues/{memory,kafka}.ts`
- **Driver interface** (from the W0 contract):
  - `test`
  - `listDestinations` (topics or queues, with counts)
  - `describe`
  - `peek(n, from)`
  - `produce`
  - `consume` (stream)
  - `purge`
  - `create` / `delete`
  - Optional: `groups` and lag for Kafka
- **Connections:** `.quiver/queues/<id>.json`; credentials in `host.secrets`.
- **Commands:**
  - `queues.connection.list` / `get` / `test`
  - `queues.connection.save` / `delete` (mutating)
  - `queues.destination.list` / `describe`
  - `queues.message.peek`
  - `queues.message.produce` (mutating)
  - `queues.consumer.start` / `stop` / `read` (live tail; Kafka uses its own throwaway group id)
  - `queues.message.wait` (match, timeout)
  - `queues.group.list` (Kafka lag)
  - `queues.destination.purge` / `create` / `delete` (mutating)
  - `queues.history.list`
- **Memory driver:** backs the UI lane and the smoke tests.
- **Kafka smoke:** runs only when `QUIVER_SMOKE_KAFKA=host:port` is set; otherwise it is skipped with a note.

### Q2: SQS driver (`feat/queues-sqs`)
- **Owns:** `queues/drivers/sqs.ts`, `smoke/fake-sqs.ts`, `smoke/parts/queues/sqs.ts`
- **Driver:**
  - auth through an AWS profile or an access key (`host.secrets`); the endpoint can be overridden for LocalStack
  - peek uses visibility timeout 0, so messages are not consumed
  - supports FIFO queues and DLQ redrive info
- **Fake:** `fake-sqs.ts` is an HTTP JSON fake covering the SQS API subset used, started and closed by `smoke/parts/queues/sqs.ts` itself, not by `fixtures.ts`.

### Q3: RabbitMQ driver (`feat/queues-rabbit`)
- **Owns:** `queues/drivers/rabbit.ts`, `smoke/parts/queues/rabbit.ts`
- **Driver:**
  - AMQP through `amqplib`, plus the management HTTP API for listings and counts
  - the connection holds `host`, `port`, `vhost`, `ssl` and `username`; the password is the secret `password`. The driver builds the URL itself: a pasted `amqp://user:pass@host` is never stored
  - peek = `get` + `nack(requeue)`, and the UI warns that this changes redelivery flags
- **Smoke:** runs only when `QUIVER_SMOKE_RABBIT` is set; the management-API parts run against a small fake.

**Lane rules:** never edit another lane's files. If you need a contract change, open a tiny separate PR against `core/src/models/*` and say so in your PR.

---

## Wave 2: UI (3 agents in parallel, each starts when its module's host lanes merge)

Angular standalone components with signals, following `src/renderer/README.md`. UI lanes own only `<module>/ui/**`, `smoke/parts/<module>/ui.ts` and the UI section of the module README. Run the smoke with `--shots` and look at the screenshots.

- **GU: Git UI**
  - sidebar: branches and changed files
  - main view: a diff viewer (side-by-side and inline), a stage/commit box and a log list
  - PR tab: a list with check badges; a detail view with checks, failed log excerpts and files
  - palette: switch branch, open PR
- **RU: Runner UI**
  - sidebar: tasks with state dots (stopped, starting, ready, crashed) and Start/Stop/Restart
  - main view: an output pane (ANSI colours, search, follow, clear) plus a task editor form
  - ports appear as clickable links
- **QU: Queues UI**
  - sidebar: connections → topics or queues with counts
  - main view: a message table (key, headers, pretty-printed body, timestamps), a producer composer with saved messages, a live consumer tail with filters, and a Kafka group lag panel
  - destructive actions ask for confirmation

---

## Wave 3: integration and docs (1 agent, after all of the above)

- **Runner and Env:** a task's `envProfile` loads that env profile's values. Lane R2 already reads `.env.<profile>` from the task's folder, then the workspace folder (or a path when the profile has a slash or starts with `.env`); this step aligns that with the env module's own discovery (`<name>.env` too, four folders deep) instead of adding a second lookup.
- **Git and Todo:** create a todo from a PR, and show the branch in the status bar.
- **Runner in the status bar:** the count of running tasks.
- **Docs:** finish each module README (what it does, storage, Agents section with the allowed and gated tools, smoke coverage), remove the lane markers, and update the README table one-liners.
- **Checks:** run the full `npm run typecheck`, `npm test` and `npm run smoke -- --shots`.

---

## Schedule

| Wave | Agents | Lanes | Starts after |
| --- | --- | --- | --- |
| 0 | 1 | Scaffold | – |
| 1 | 7 | G1 G2 R1 R2 Q1 Q2 Q3 | W0 merged |
| 2 | 3 | GU RU QU | that module's W1 lanes merged (QU needs only Q1) |
| 3 | 1 | Integration | all merged |

That is 12 PRs. At most 7 agents work at the same time.

## Per-agent brief template

> Lane **X**. Start from fresh `main` (W0 merged) and branch `feat/<lane>`. You own exactly these files: … Do not edit any other file. If you need to, stop and report. Implement against `packages/core/src/models/<module>.ts`. Mark commands that delete or write externally as `mutating`. Emit `<module>.changed` after writes that are not made through the store. Fill `smoke/parts/<module>/<section>.ts` and add core unit tests for parsers. Run `npm run smoke -- <module>` until it passes, then typecheck, test and the full smoke. Open a PR following CLAUDE.md with label `enhancement`, report the link, and do not merge.

## Decisions (owner, 2026-10-20)

1. GitHub goes through the `gh` CLI with the user's own sign-in. Quiver stores no token.
2. Kafka and RabbitMQ smoke checks that need a real broker are opt-in (`QUIVER_SMOKE_KAFKA`, `QUIVER_SMOKE_RABBIT`). CI does not start brokers.
3. Agents may start, stop and restart runner processes, but those commands are gated as mutating.
4. Kafka goes through `kafkajs` although it has had no release since 2023: it is pure JavaScript, so it needs no native rebuild against Electron, which rules out `@confluentinc/kafka-javascript` (librdkafka). The `QueueDriver` interface keeps the client behind `queues/drivers/kafka.ts`, so swapping it later touches one file and no UI.

## Done / follow-ups

Done: the scaffold (wave 0), the seven host lanes (wave 1), the three panels (wave 2), and the integration (wave 3):

- a status bar extension point for modules (`statusItems` on `ModuleUI`, described in `src/renderer/README.md`), used by Git for the branch with ahead and behind and by the Runner for the count of running tasks, each opening its sidebar on a click;
- a task's `envProfile` found the way the env module finds env files (`findProfileFile` in `env/files.ts`: `.env.<name>` or `<name>.env`, four folders deep, the same folders skipped);
- Add todo in a pull request's tab (`todo.add`, its address in the notes);
- the runner's result types (`RunnerProcInfo`, `RunnerDiscoveredRow`, `RunnerWaitResult`) in `packages/core/src/models/runner.ts`, used by the host, the panel and the smoke;
- the three module READMEs finished, with the allowed and gated tools of each, and the README table.

Follow-ups, none of them blocking:

- **Git host commands** the panel lacks: init, discard working changes, branch delete and rename, stash, and reading a file at a ref (which would let the diff use the shared CodeMirror merge view with full context).
- **Amend's "already pushed" check** looks only at `ahead === 0`: it misses a new branch whose HEAD is already on another remote branch, and warns wrongly when the upstream is gone. The force-push-with-lease offer covers what happens after.
- **ANSI escapes split by a partial flush**: an escape cut by the host's 150 ms flush of text without a line break still shows as text.
- **History paging by `skip`** can skip or repeat a commit when HEAD moves while older pages load.
- **Side-by-side `\ No newline at end of file`**: a deleted and an added line with that marker between them are not paired.
