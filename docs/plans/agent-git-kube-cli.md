# Plan: Git branch management, Kubernetes actions, agent permissions, CLI

**Status: combined, in final review.** The four lanes are built, reviewed and merged into `feat/agent-git-kube-cli` with the cross-lane work below (lane pull requests #50, #47, #48 and #49, left open for the owner); the combined pull request, #51, waits for the final review and the whole smoke. What was built, the deviations and what is left are under [Done / follow-ups](#done--follow-ups).

## How the work runs

1. **Build (4 agents in parallel, one git worktree each).** Each lane branches from `origin/main` (`git fetch origin && git switch -c <branch> origin/main`, since `main` is checked out in the main folder), runs `npm ci`, implements its lane, adds unit tests and smoke checks, updates the docs, verifies, commits, pushes and opens its pull request (label `enhancement`).
2. **Review per pull request (1 agent per lane).** A fresh agent reads the lane's diff against this plan and the conventions in `CLAUDE.md`, looking for bugs, security gaps (input reaching argv, missing `mutating`, secrets leaking to agents), missing tests, docs that don't match the code and UI problems in the screenshots. It fixes what it finds on the same branch, reruns the checks and pushes.
3. **Combine (1 agent).** It makes `feat/agent-git-kube-cli` from `origin/main`, merges the four lane branches, resolves the conflicts on the shared files, does the cross-lane wiring listed under [Integration](#integration), runs typecheck, tests and the whole smoke with `--shots`, then opens one pull request that combines the four.
4. **Final review (1 agent).** A detailed review of the combined pull request covering correctness, security, gaps against this plan, docs and tests. It fixes what it finds, reruns everything, pushes and adds a review summary to the pull request body.

Pushing: `git -c credential.username=be5her push -u origin <branch>`. Before `gh pr create`: `gh auth switch --user be5her`. Nothing gets merged.

## Shared files (expect conflicts at combine time; keep edits small and additive)

| File | Lanes |
| --- | --- |
| `packages/core/src/types.ts` (`Caller`, `HostEvents`, `GlobalConfig`) | C, D (A, B only for new events) |
| `packages/core/src/defaults.ts` | C |
| `packages/core/src/registry.ts` | C only |
| `packages/core/src/index.ts` exports | all, one line each |
| `packages/mcp/src/index.ts` | C (policies, agent in ctx), D (a one-line hook to its own endpoint file) |
| `src/main/host.ts`, `src/main/index.ts` | C (approvals), D (CLI endpoint, token, headless entry) |
| `src/renderer/src/app/settings/settings-tab.ts` | C (permissions), D (CLI section) |
| `README.md` (table, MCP section, Run) | all |
| `package.json`, `electron.vite.config.ts`, `electron-builder` config | D only |

Lanes A and B stay inside their own module folders plus their core model and parser files.

---

## Lane A: Git branch management (`feat/git-branch-management`)

**Owns:** `packages/modules/src/git/**` (commands-local.ts, local.ts, ui/**), `packages/core/src/git-parse.ts` (+test), `packages/core/src/models/git.ts` if present, `src/main/smoke/parts/git/**`, git README.

Every new command follows the existing rules: one git process per call at the repository root, `GitArgSchema` (nothing starting with `-`), paths after `--`, refs validated, `GCM_INTERACTIVE=never` for agents on network calls, emit `git.changed` after writes. Writes come back with the new status.

**Host commands**
- Branches: `git.branch.delete` `{ name, force? }` (`-d`, `-D` with force; refuses the current branch); `git.branch.deleteRemote` `{ remote, name }` (`git push <remote> --delete <name>`, refuses the remote's default branch); `git.branch.rename` `{ from?, to }`; `git.branch.setUpstream` `{ branch?, upstream: string | null }`. `git.branch.list` gains `merged` (merged into the default branch, or into the current one when there's no default) and `gone` (the upstream was pruned).
- Merge and rebase: `git.merge` `{ ref, mode?: 'ff' | 'no-ff' | 'ff-only' | 'squash', message? }`; `git.rebase` `{ onto }` (never interactive). For the operation in progress: `git.operation.continue | abort | skip` (merge, rebase, cherry-pick, revert), with `GIT_EDITOR=true` so continue never waits on an editor. A result that stops on conflicts is a success that reports the conflicted files, not an error.
- Commits: `git.cherryPick` `{ commits[] }`, `git.revert` `{ commit }`, `git.reset` `{ ref, mode: 'soft' | 'mixed' | 'hard' }`.
- Stashes: `git.stash.list`, `git.stash.show` `{ index }` (diff like `git.show`), `git.stash.push` `{ message?, includeUntracked?, paths? }`, `git.stash.apply` `{ index, pop? }`, `git.stash.drop` `{ index }`.
- Working tree: `git.discard` `{ paths }` (`git restore --worktree --source=HEAD`, and `git clean -f` only for paths the status lists as untracked).
- Tags: `git.tag.list`, `git.tag.create` `{ name, ref?, message? }`, `git.tag.delete` `{ name }`, `git.tag.push` `{ remote, name }`.
- `git.file.show` `{ ref, path }`: a file's content at a ref, capped at 2 MB, with binary detection. The diff view then uses the shared CodeMirror merge view with full context when both sides fit.

**Agents:** `git.stash.list`, `git.stash.show`, `git.tag.list` and `git.file.show` are allowed. Every write above is `mutating`.

**UI**
- A **Branches** tab (`git.branches`): local and remote branches plus tags, with a filter. Each row shows upstream, ahead/behind, last commit, and the current/merged/gone badges. Actions: checkout, new branch from, rename, delete (asks first, then asks again with force when the branch isn't merged), delete on the remote (asks first and names the remote), set or unset upstream, merge into current, rebase current onto, compare (diff between the two refs), copy name. "Clean up" lists merged and gone branches with checkboxes. It opens from the sidebar and from the palette.
- Sidebar:
  - a **Stashes** section (stash changes, apply, pop, drop, view)
  - **Discard** per file and per group, behind a confirmation
  - an **operation banner** while a merge, rebase, cherry-pick or revert is in progress, with Continue, Skip (rebase only) and Abort
- History: context menu on a commit with cherry-pick, revert, reset to here (soft, mixed, hard; hard asks first), new branch here, tag here, checkout.
- Palette entries for: Branches, Stash changes, Merge branch into current, Rebase onto, Delete branch.

**Tests:** parsers for stash list, tag list, branch `merged`/`gone` and operation states go in core unit tests. The smoke extends `parts/git/local.ts`, using the temp repository it already builds:
- delete, including refusing the current branch and an unmerged branch without force
- rename and set-upstream
- a merge that stops on a conflict, then continue and abort
- a rebase that stops, then continue and abort
- cherry-pick, revert and reset
- stash push, list, apply, pop and drop
- discard of a tracked and an untracked file
- tag create, list and delete
- `git.file.show`, including a binary file
- an option-like name refused
- agents gated on every write

`parts/git/ui.ts` adds a Branches tab check, the stash section and the conflict banner, with screenshots.

---

## Lane B: Kubernetes actions beyond read-only (`feat/kube-actions`)

**Owns:** `packages/modules/src/teleport/kube.ts`, `teleport/main.ts` (kube commands only), `teleport/ui/**` (kube view), `packages/core/src/models/kube.ts` and a new `packages/core/src/models/kube-actions.ts` (+tests), `src/main/smoke/parts/teleport.ts` and its fake tsh, teleport README.

The read-only design stays: no command line for anyone, a fixed catalogue, hard-coded templates and typed, validated fields. Writes go in a **separate catalogue** with its own builder, so the existing unit test still proves the read catalogue cannot write. A new test lists every action template and proves each one is exactly the expected kubectl verb.

**Actions (`KUBE_ACTIONS`)**
- `scale` `{ kind: deployments | statefulsets | replicasets, name, namespace, replicas: 0..1000 }`
- `rollout-restart` `{ kind: deployments | statefulsets | daemonsets, name, namespace }`
- `rollout-undo` `{ kind, name, namespace, toRevision? }`, plus `rollout-pause` and `rollout-resume` for deployments
- `delete` `{ kind: pods | jobs, name, namespace, gracePeriodSeconds? }`, which only ever deletes one named object (no selectors, no `--all`)
- `cordon` and `uncordon` `{ node }`
- `set-image` `{ kind: deployments | statefulsets | daemonsets, name, namespace, container, image }`, with the image checked against a strict image reference pattern
- `cronjob-trigger` `{ name, namespace, jobName? }` → `create job --from=cronjob/<name> <jobName>`

`exec`, `apply`, `edit`, `patch`, `drain` and anything taking free-form YAML or a command are deliberately absent; the README says so and why.

**Port forwards:** `teleport.kube.portForward.start` `{ cluster, kind: pods | services | deployments, name, namespace, remotePort, localPort? }` runs `tsh kubectl port-forward --address 127.0.0.1` as a long-running process (killed as a tree on stop and on quit). `portForward.list` and `portForward.stop` round it out, and the list shows in the kube view with the local URL. The `teleport.changed` event covers it, or a new one if needed.

**Commands**
- `teleport.kube.action` (`mutating: true` always) and `teleport.kube.action.preview` (allowed; gives back the exact argv)
- `teleport.kube.portForward.start` and `stop` (mutating); `list` (allowed)

Every action goes into history marked as an action. Rerunning an action from history is mutating: `teleport.kube.history.rerun` becomes conditionally mutating by entry kind.

**Protected clusters:** a per-cluster `protected` flag in the Teleport settings (global config). Actions on a protected cluster need the cluster name typed in the confirmation, from the UI. For agents a protected cluster refuses actions outright unless the user turns that off.

**UI:** the operation picker gets an **Actions** group, styled apart from the reads. Every run goes through a confirmation dialog that shows the exact command line. Destructive ones (delete, scale to 0, rollout-undo, cordon) also need the object's name typed. Results show like a query result. There's a Port forwards panel, and the protected toggle sits in the cluster's context menu.

**Tests:** core unit tests cover the action catalogue (every template, rejection of `-` values, enums that leave out secrets, image pattern, replicas bounds) and confirm the read catalogue still has no write verbs. The fake tsh answers the action verbs and port-forward (a real local listener). The smoke covers:
- each action's argv as received by the fake
- preview matching what actually ran
- agents gated, and a protected cluster refusing agents
- history rerun of an action being gated
- port-forward start, list, a TCP connect and stop with the process tree gone

UI checks with `--shots`: the Actions group and the confirmation dialog.

---

## Lane C: Agent-first mode, per-tool permissions with approvals (`feat/agent-permissions`)

**Owns:** `packages/core/src/registry.ts` (gating), `packages/core/src/types.ts` (config, events, `CommandContext.agent`), `defaults.ts`, a new `packages/core/src/permissions.ts` (+test), `packages/mcp/src/**`, approval wiring in `src/main/host.ts`, the renderer's settings MCP section, a shell-level approval dialog and status bar item, the MCP inspector's README section where relevant, the root README MCP section, `src/renderer/README.md`, smoke `parts/mcp.ts` and `parts/shell.ts`.

**Model.** `config.mcp.permissions = { mode: 'read-only' | 'ask' | 'allow', rules: Array<{ match: string; action: 'allow' | 'ask' | 'deny' }> }`.
- `match` is a command id or a module glob: `git.*`, `db.query.run`, `*`.
- `mode` is what mutating calls get when no rule matches; read-only calls are allowed when no rule matches.
- A rule may also `ask` or `deny` a read-only command, for example to deny `db.query.run` entirely.
- Precedence: `deny` beats everything, then the most specific match wins (an exact id beats a module glob beats `*`), then `mode`.
- Migration: `allowMutating: true` becomes mode `allow`, `false` becomes `read-only`, so behaviour is unchanged until the user picks `ask`. Keep `allowMutating` readable for old configs, or migrate it on load.
- Per-workspace rules in `.quiver/local/agent-permissions.json` (per machine) take precedence over global rules. Conditional mutating commands (`db.query.run`) keep deciding per call.
- `permissions.ts` holds the pure decision function, with unit tests for every precedence case.

**Ask flow.** For caller `mcp` only, the registry asks `host.approvals.request({ agent, workspace, commandId, title, input, mutating })` when the decision is `ask`.
- The input is masked with the existing redact helpers.
- The host emits `mcp.approval.requested`, and a shell dialog, queued with one at a time, shows the agent, tool, workspace and arguments.
- The choices are Allow once, Allow this tool for this agent until Quiver restarts, Always allow this tool (adds a rule) and Deny.
- With no answer in 120 s the call is refused with `MUTATION_BLOCKED` and `details.reason: 'approval-timeout'`; a denial uses `details.reason: 'denied'`.
- When the window isn't focused, the main process shows a system notification that focuses the window when clicked.
- `mcp.approval.respond` and `mcp.approval.list` are hidden commands; the smoke answers through them.

**Agent identity in commands.** The MCP layer already identifies the agent (`identifyAgent`). Pass it into `CommandContext` as `ctx.agent`, so approvals, rules and the activity feed name it.

**Visibility.**
- Denied tools are left out of `tools/list`.
- Tool descriptions say "asks the user first" for `ask`.
- A **Pause agents** switch, in the status bar and the settings, refuses every MCP call (`details.reason: 'paused'`) and leaves `tools/list` intact.

**Activity.** An always-on ring buffer of the last 200 MCP calls (agent, tool, workspace, decision, ok, duration; no arguments, so nothing sensitive is kept). It is exposed through `mcp.activity.list` and a `mcp.activity` event. The status bar item shows agent calls in the last minute and any approvals waiting, and a click opens an **Agent activity** tab with the list and the pending approvals. The call recorder stays as it is.

**Settings UI.** The "Allow mutating commands" toggle becomes a permission mode selector (Read-only, Ask, Allow) plus a rules table: pick a module or command, pick an action, delete a rule. The workspace rules sit in their own table.

**Tests:** unit tests for `permissions.ts`, plus mcp package tests for tools/list filtering. The smoke covers:
- migration from `allowMutating`
- deny hiding a tool
- ask, then approve once
- ask, then always (the rule gets written)
- ask, then deny
- an approval timeout, using a short test override
- pause
- a workspace rule beating a global one
- activity listing calls

UI checks with `--shots`: the dialog, the settings table and the status bar item.

**Coordination with lane D:** the CLI calls as caller `cli`, which is the user's own process. Policies and approvals apply to `mcp` only; say so in the docs.

---

## Lane D: CLI (`feat/cli`)

**Owns:** a new `src/cli/**`, a new `packages/mcp/src/cli-endpoint.ts` (or `src/main/cli-endpoint.ts`) with a one-line hook in the HTTP handler, CLI token handling in `src/main`, `package.json` scripts, `electron.vite.config.ts` (CLI entry), the electron-builder config (shims), the settings CLI section, smoke `parts/cli.ts` plus registering it, a new `docs/cli.md`, the README Run section and table.

**Two modes, one command line**
- **Connected (default):** the CLI talks to the running Quiver over `POST http://127.0.0.1:<mcp port>/cli`.
  - The CLI authenticates with a random token the app writes to `<userData>/cli-token`, readable by the user only, and regenerates on every start. It finds the port in `<userData>/cli-endpoint.json`.
  - Requests carry the token in a header; any request with an `Origin` header is refused, so a browser page can't reach it.
  - The body is `{ command, input, workspace }`, executed with caller `cli`, which gets the user's rights.
  - Secrets resolve as they do in the app, and results are not masked (masking is for agents).
- **Headless (`--headless`, or automatic with `--headless=auto` when no app answers):** the CLI boots `Host` in-process in plain Node, with no Electron, against `--data-dir` (default: a `quiver-cli` folder in the OS data directory).
  - The workspace is `--workspace` or the current folder.
  - `SecretsApi` reads `QUIVER_SECRET_<KEY>` environment variables or `--secrets <file.json>`.
  - safeStorage isn't available, so a command that needs a stored encrypted secret fails with a clear `SECRET_UNAVAILABLE` message.
  - This is the CI mode. Check that `src/main/host.ts` imports nothing from Electron (it doesn't today) and keep it that way.

**Syntax**
- `quiver list [module]` lists commands (id, title, whether mutating)
- `quiver describe <command>` gives the input JSON schema and an example
- `quiver <command> [--input '<json>' | --input @file.json | --<field> <value> ...]` runs a command; `quiver run <command> ...` is an alias
- `--workspace <path>`, `--json` (the default when stdout isn't a TTY), `--quiet`, `--headless`, `--data-dir`, `--timeout`
- Exit codes: 0 ok; 1 command failed (the error JSON goes to stderr); 2 usage or invalid input; 3 Quiver not reachable in connected mode; 4 the result reports failed checks (`api.collection.run` with failures)
- `quiver api.collection.run --collection <id> --reporter junit --out results.xml` is the CI test runner, with a JUnit reporter for collection runs.

**Build and ship**
- An extra entry in the electron-vite main build (`out/main/cli.js`).
- `npm run cli -- <args>` for development.
- Packaged shims in `resources/cli/`: `quiver.cmd` on Windows and a `quiver` sh script for mac/linux. They run the Quiver binary with `ELECTRON_RUN_AS_NODE=1` on `app.asar/out/main/cli.js`.
- Settings → Command line shows the shim folder, a copyable "add to PATH" line per platform and the connected-mode status. Nothing edits PATH by itself.

**Tests:** argument parsing (flags to input, `@file`, type coercion against the zod schema) and the JUnit reporter are pure, so they get core-style unit tests in a testable package location. The smoke part `cli` spawns the built CLI:
- `list`, `describe` and running a read command against the smoke host in connected mode, using the smoke's private port and token
- a bad token refused, and an `Origin` header refused
- a mutating command run through the CLI (allowed, caller `cli`)
- invalid input giving exit 2
- headless mode adding and listing a todo in a temporary workspace, plus a secret coming from an environment variable
- JUnit output for a collection run against a local fake

**Not in scope:** editing PATH automatically, shell completion (follow-up), and remote hosts.

---

## Integration

Done by the combine agent after merging all four:
- The README table gains a CLI row and updated Git and Teleport lines. The MCP section describes the permissions in place of the single toggle, and the Run section points to `docs/cli.md`.
- The new git and kube commands get correct `mutating` flags, so lane C's policies, the ask dialog and the activity feed cover them. Smoke: a kube action under mode `ask` raises an approval.
- The CLI's `list`/`describe` show the new git and kube commands, and the CLI caller bypasses agent policies. Smoke: one CLI run of `git.status`, and one gated git write that the CLI is allowed to make.
- `CommandContext.agent` (C) and caller `cli` (D) coexist in `types.ts`.
- This plan's status line is updated, and "Done / follow-ups" is filled in.

## Done / follow-ups

Done, one lane per pull request, then combined:

- **Lane A, Git branch management (#50).** 23 commands in `git/commands-manage.ts`: branch delete (refuses the current branch, `not-merged` without `force`), delete on the remote (refuses the remote's default branch), rename, set upstream; merge and rebase with continue, skip and abort, where stopping on conflicts is a success that lists the files and git never opens an editor; cherry-pick, revert, reset; stashes (list, show, push, apply or pop, drop); discard (only untracked paths are deleted); tags (list, create, delete, push); a file at a ref or in the index (`git.file.show`, 2 MB, binary detection). `git.branch.list` reports `merged` and `gone`, and `git.changed` gains the `stashes` reason. The panel has a Branches and tags tab with Clean up, a Stashes section, Discard per file and group, an operation banner, a commit menu in the history and palette actions; side-by-side diffs show whole files in the shared CodeMirror merge view, with the hunk view as fallback.
- **Lane B, Kubernetes actions (#47).** A typed action catalogue (`models/kube-actions.ts`: scale, rollout restart, undo, pause and resume, delete one pod or job, cordon, uncordon, set image, trigger a CronJob), each on one named object in a required namespace, with no selectors, YAML, exec, apply, edit, patch or drain. `teleport.kube.action` is always mutating and `teleport.kube.action.preview` gives the exact argv. Port forwards on 127.0.0.1 run as process trees and stop on stop, logout, cluster removal and quit. Protected clusters need the cluster name typed (`confirmCluster`, enforced by the host for every caller but agents, who are refused outright unless Settings allow them), and writes need the exact listed cluster name. The UI has an Actions group in the operation picker, a confirmation dialog with the exact command line, a Port forwards panel and the Protected checkbox.
- **Lane C, agent permissions (#48).** A permission mode (read-only, ask, allow) in place of the single switch, migrated from `allowMutating` and kept in step with it; allow, ask and deny rules per command id or glob, global and per workspace (on this machine only); approvals with Allow once, until restart, always and Deny, a 120 s timeout and a system notification; Pause agents; and an Agent activity tab with the last 200 calls. Deny rules hide tools from `tools/list`, tool descriptions say which tools ask, and every refusal is `MUTATION_BLOCKED` with a `details.reason`.
- **Lane D, the CLI (#49).** `quiver list`, `describe` and any command with typed `--field` flags, connected to the running app through `POST /cli` on the MCP port (a per-start token, no `Origin` allowed) or headless in plain Node (`--headless`, `--headless=auto`), with exit codes, `--json`, `--timeout` and a JUnit reporter for collection runs. Headless secrets come from `--secrets <file>` or `QUIVER_SECRET_<NAME>`. Shims for the installed builds, `npm run cli` for a checkout, and a Command line section in Settings.

Combine:

- Conflicts were small and additive: `defaults.ts` (lane C's MCP section next to lane B's Teleport fields), `packages/mcp/src/index.ts` (lane C's imports plus `CLI_PATH`), `src/main/host.ts` and `src/main/index.ts` (lane C's `notifyApproval` and approvals next to lane D's `serve`, `cliShims` and `CliAccess`), `settings-tab.ts` (both panels imported), and the core and renderer READMEs (both texts kept).
- The README's MCP section says the command line is outside the agent permissions, approvals and pause; the Git and Teleport READMEs describe gating with the agent permissions rather than the old switch; `docs/cli.md` and the Teleport README say a protected cluster needs `--confirm-cluster` from the command line.
- Smoke: the Teleport part's protected-cluster checks switch the permission mode instead of `allowMutating`, and a kube action under mode `ask` raises an approval, waits for it and runs once allowed, while the action preview stays open. The `cli` part checks that `list` and `describe` show the new git and kube commands with the right `mutating` flags, that `git.status` and a gated `git.branch.create` run through the CLI while a `git.*` deny rule and read-only mode refuse agents, and that pausing agents leaves the CLI alone.

Deviations from this plan, all in the lane pull requests:

- Lane A: `merged` uses `origin/HEAD`, else a local `main` or `master`, and only then the current branch; `git.branch.delete` falls back to `-D` when the branch's commits are in the default branch; `git.discard` restores the working tree from the index unless `staged: true`; `git.file.show` takes `{ path, ref }` or `{ path, index: true }`; the host smoke checks are their own section, `parts/git/manage.ts`.
- Lane B: the namespace is required for every namespaced action; `cronjob-trigger`'s job name is filled in by the host; protected clusters refuse agents' port forwards too; the typed object name of a destructive action is a UI-only check (the host enforces only `confirmCluster`); agents may protect but never unprotect; the confirmation dialog lives in the Teleport module.
- Lane C: a deny at either level wins, so a workspace allow cannot lift a global deny; only deny rules hide tools; every refusal is `MUTATION_BLOCKED` with a reason; pause lives in the global config and survives a restart; workspace rules live in the global config on this machine rather than in `.quiver/local`.
- Lane D: headless secrets use a new optional `SecretsApi.lookup(name)` (API environment variables only); headless runs store new secrets as `plain:`; connected mode depends on the MCP server being on; with no `--workspace` and no `.quiver` folder found, connected mode uses the app's active workspace; the field `secrets` clashes with the option and goes in `--input`.

Follow-ups, none of them blocking:

- **Ask before refuse on protected clusters.** Under mode `ask`, an agent's action on a protected cluster raises an approval first and is refused by the handler after the user allows it. The protected check could move into the command's `mutating` decision, or the registry could ask the command whether it would refuse, so the user is not asked for nothing.
- **What the CLI may call.** The CLI is the user and reaches hidden commands such as `config.update` and `mcp.permissions.setMode` (only `mcp.approval.respond` is window-only). An agent with shell access can use the CLI instead of MCP, and one that can read `<userData>/cli-token` could post to `/cli`.
- **Agent identity.** Grants until restart are keyed by the agent name from the MCP handshake, which a client chooses.
- **Headless secrets** for DB passwords, client certificate passphrases, Metabase and queue connections have no by-name lookup yet; DB and certificates fail with `SECRET_UNAVAILABLE`, Metabase and queues fall back to empty.
- **Git:** interactive rebase; annotated tags from the history ("Tag here" makes lightweight ones); smoke coverage of cherry-pick and revert conflicts with skip; an operation stopped by something other than conflicts stays in progress with git's error; `rebase-apply` from `git am` shows as a rebase; `applyPatch` may fall back to the hunk view on unusual patches; the CodeMirror merge view follows the app theme, so it is dark in the smoke's light screenshots.
- **Kubernetes:** a few concurrent starts to different targets can pass the cap of 16 forwards; the Settings checkbox for agents on protected clusters is not screenshotted; a port forward is reachable by any local process while it runs, as with kubectl.
- **CLI:** the macOS and Linux shims were not run on those platforms; an AppImage's shim folder changes on every launch; `--timeout` cancels only collection runs; shell completion.
