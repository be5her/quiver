# Plan: QR and DNS tools, VictoriaLogs direct, git changes as a tree, agent rules per action, Teleport certificate renewal

**Status: through the final review; merged by the owner's instruction.** Six open items of the workspace todo list, built as six lanes in parallel, each its own pull request, reviewed one by one, then combined into one pull request that gets the whole test suite, the whole smoke and a final review, and is merged by the owner's instruction.

## How the work runs

1. **Build (6 agents in parallel, one git worktree each).** Each lane branches from `origin/main` (`git fetch origin && git switch -c <branch> origin/main`), runs `npm ci`, implements its lane, adds unit tests in `packages/core` for pure logic and smoke checks in its module's part, updates the docs, verifies with targeted checks, commits, pushes and opens its pull request (label `enhancement`).
2. **Review per pull request (1 agent per lane).** A fresh agent reads the lane's diff against this plan and `CLAUDE.md`: bugs, caller input reaching argv or a URL unescaped, missing `mutating`, missing tests, docs that don't match the code, UI problems in the screenshots. It fixes what it finds on the same branch, reruns the targeted checks and pushes.
3. **Combine.** `feat/tools-logs-git-agents-teleport` from `origin/main`, merging the six lane branches, resolving the shared files, doing the cross-lane wiring under [Integration](#integration). `npm run typecheck`, the whole `npm test` and the whole `npm run smoke -- --shots` run here, once. One pull request that combines all six.
4. **Final review (1 agent)** of the combined pull request; it fixes what it finds, reruns everything and adds a review summary to the pull request body. Then the combined pull request is merged, and the lane branches and worktrees are deleted.

**Checks:** lanes and their reviews run targeted checks only: `npm run typecheck`, `npx vitest run <touched test files>`, `npm run smoke -- <touched parts> --shots`. Each lane pull request body says verification was targeted and that a combined pull request follows. The whole test suite and the whole smoke run on the combined pull request.

**Pushing:** `git -c credential.username=be5her push -u origin <branch>`. The gh CLI is switched to `be5her` for the whole run by the coordinator; lanes never run `gh auth switch`. Lanes never merge.

## Rules every lane keeps

- A feature is registry commands (`defineCommand`, zod input) plus UI; the UI only talks to the host through commands. Pure logic goes in `packages/core/src/` with vitest tests beside it; Node-only logic (crypto, dns, child processes) in `packages/core/src/node/` or the module's `main.ts`.
- Writes and anything that changes shared state are `mutating`. Reads are open to agents. Secrets go through `host.secrets`, never into `.quiver/<collection>` files, and are masked for MCP callers.
- Every write the UI shows is announced (`store.put`/`remove` emit on their own; `appendLog`, `writeLocal` and writes outside the store do not, so emit the module's event after them).
- UI follows `src/renderer/README.md`: standalone components, signals, Signal Forms, the shared components in `packages/ui`, no experimental APIs.
- No new runtime dependency without a sentence in the pull request saying why. Prefer none.
- Each lane updates its module README (what it does, how it works, Agents, Verified by), the module's row in `README.md` when its one-line summary changes, and adds its smoke checks to the module's part (`src/main/smoke/parts/<name>.ts`, or a new section file under `parts/<name>/` when the part is sectioned).
- Line endings LF. Commit messages say what changed and why. The clone's author identity stays.

## Shared files (expect conflicts at combine time; keep edits small and additive, append at the end of lists)

| File | Lanes |
| --- | --- |
| `README.md` module table | A, B (tools row), C (logs row), D (git row), F (teleport row) |
| `packages/modules/src/tools/main.ts`, `ui/tools.ts`, `ui/tools-sidebar.ts`, `README.md`, `src/main/smoke/parts/tools.ts` | A and B: each appends its own command, descriptor and smoke block at the end; A puts its smoke in a new section file `parts/tools/qr.ts` and B in `parts/tools/dns.ts`, turning `parts/tools.ts` into a `runSections` list (whoever is first; the combiner merges the two) |
| `packages/core/src/index.ts` exports | A, B, D, E |
| `packages/core/src/registry.ts`, `packages/core/src/types.ts` | E only |
| `packages/core/src/models/teleport.ts` | F only |
| `packages/mcp/src/index.ts`, `src/main/host.ts` | E only |

---

## Lane A: QR code encoder in Tools (`feat/tools-qr`)

Todo: "qr encode in tools".

**Host:** `tools.qr.encode` (global, read, allowed) `{ text, errorCorrection?: 'L' | 'M' | 'Q' | 'H' (default 'M'), margin?: 0–8 modules (default 4), moduleSize?: 1–32 px (default 8) }` → `{ svg, modules: string[] (one row per line, '1' dark, '0' light, no margin), version, size, errorCorrection, mode: 'numeric' | 'alphanumeric' | 'byte' }`. Text up to 2953 bytes (the version-40-L byte capacity); longer, or empty, is refused with `INVALID_INPUT` naming the limit.

The encoder is pure TypeScript in `packages/core/src/qr.ts`, no dependency: mode detection (numeric, alphanumeric, UTF-8 byte; no kanji mode), the smallest version that fits at the requested level, Reed–Solomon over GF(256), interleaving, the finder, timing, alignment and dark-module placement, format and version information, all eight masks with the penalty rules and the best one picked. `renderQrSvg(modules, { margin, moduleSize })` builds the SVG with one `<path>` for the dark modules (small output), `shape-rendering="crispEdges"`, and a `currentColor` fill so the UI can theme it. The agent must keep the encoder readable: one function per stage with the spec's table numbers in comments.

**Tests (core):** a known vector (the matrix of `HELLO WORLD` at 1-M or another published one, checked module by module); mode detection; capacity edges (the largest text that fits version 1-L and the one that does not); every level and a long text that forces a high version; the SVG path containing as many squares as dark modules. To prove the output decodes, add `jsqr` as a **devDependency** only (zero dependencies, MIT): a test renders the matrix into an RGBA buffer and decodes numeric, alphanumeric, UTF-8 (`héllo wörld ✓`), a 1 KB text and each level. The pull request body says why the dev dependency is there.

**UI:** a **QR code** tool in the Tools sidebar and palette, in the existing tool tab framework: the text input on the left, options for error correction level, margin and module size, and the output area shows the SVG rendered at a readable size with the version, size and mode under it, plus **Copy SVG** and **Save PNG…** (the renderer draws the SVG onto a canvas and uses the shared save-file path other tabs use; look at how the API module saves a response to a file and reuse that command, do not add a new file dialog in the renderer). `live: true`. If the tool-tab framework only shows text output, extend `ToolDescriptor` with an optional `render: 'svg'` (or similar) in a way that keeps the other tools as they are.

**Smoke:** `parts/tools/qr.ts`: the host encodes a text and the result has a square matrix with the finder patterns in the three corners, `version` and `size` consistent (`size === 17 + 4 * version`), the error correction level honoured (the same text at H gives a higher version than at L for a text that needs it), empty and oversized input refused, an agent calling `tools_qr_encode`. UI (`--shots`): open the tool, type a URL, see the SVG appear and the version line; screenshot light and dark.

**Docs:** tools README (what it does, how it works, Agents: allowed, Verified by), `README.md` tools row adds "QR code".

## Lane B: Detailed DNS lookup in Tools (`feat/tools-dns`)

Todo: "detailed dns lookup".

**Host:** `tools.dns.lookup` (global, read, allowed) `{ name, types?: ('A'|'AAAA'|'CNAME'|'MX'|'NS'|'TXT'|'SOA'|'SRV'|'CAA'|'PTR'|'ANY')[] (default: A, AAAA, CNAME, MX, NS, TXT, SOA, CAA), server?: string (an IP, with optional :port), timeoutMs?: 500–20000 (default 5000) }` → `{ name, asciiName, server: { address, port, source: 'custom' | 'system' }, systemServers: string[], records: { type, name, ttl: number | null, data: object per type (address; exchange+priority; target+priority+weight+port; entries for TXT; nsname/hostmaster/serial/refresh/retry/expire/minttl; critical+issue/iodef for CAA) }[], chain: { name, target }[] (the CNAME chain followed, when the name is an alias), reverse?: { address, names: string[] } (when `name` is an IP, PTR is run instead), errors: { type, code, message }[] (`ENODATA` and `ENOTFOUND` per type are not errors but empty), durationMs }`.

It runs on `node:dns/promises` `Resolver` (one per call, `setServers` when a server is given, the call's timeout, `tries: 2`), with `{ ttl: true }` for A and AAAA (the only types Node gives a TTL for; others get `ttl: null`). The name is validated as a hostname or an IP (`node:net` `isIP`), converted with `url.domainToASCII` (the result also carries the Unicode form), and refused when empty, over 253 characters, or not a hostname; a `server` must be an IP (no hostnames, so nothing is looked up to find the resolver). Types run in parallel and the result lists them in the input's order. `ANY` is sent as is and may be refused by the server; that comes back in `errors`. No new dependency.

**Tests (core, pure parts in `packages/core/src/dns-lookup.ts`):** name validation and normalisation (trailing dot, IDN, IPs, too long, invalid characters), server parsing (`ip`, `ip:port`, `[v6]:port`), grouping and ordering of records, the CNAME chain from a list of answers, the error classification (ENODATA → empty, ETIMEOUT → error).

**UI:** a **DNS lookup** tool in the Tools sidebar and palette: a name field, a resolver field (placeholder "system"), type chips (the defaults ticked), run on Enter or a Lookup button (not live: a lookup is a network call). Output: a table per type, rows with name, TTL and the record's fields formatted per type (MX sorted by priority, SRV by priority then weight), the CNAME chain shown above as `a → b → c`, the resolver used and the time taken under it, errors inline per type. If the tool tab framework cannot host a table, extend it the way lane A extends it for SVG (one `render` kind each; the combiner merges both into one union).

**Smoke:** a fake DNS server in the smoke, `src/main/smoke/fake-dns.ts`, a `dgram` UDP responder on a free port of 127.0.0.1 that answers a small zone (`quiver.test` with A, AAAA, MX, TXT, NS, SOA, CAA; `www.quiver.test` CNAME to it; a PTR for an address; NXDOMAIN for `missing.quiver.test`) and logs each question; started and stopped by the section (`parts/tools/dns.ts`, `after` hook). Host checks: each type's records and TTLs, the CNAME chain, the reverse lookup, ENODATA as empty, NXDOMAIN per type, a hostname given as `server` refused, an option-like name refused, the agent calling `tools_dns_lookup`. UI (`--shots`): a lookup against the fake server, the tables and the chain; screenshot light and dark.

**Docs:** tools README, `README.md` tools row adds "DNS lookup".

## Lane C: VictoriaLogs direct (`feat/logs-victorialogs-direct`)

Todo: "adding victoria logs support". The Logs module only reaches VictoriaLogs through Grafana. This lane adds a second connection kind that talks to a VictoriaLogs server directly, so a local or self-hosted VictoriaLogs without Grafana works, with the same view.

**Model (`packages/core/src/models/logs.ts`):** `LogsConnection` gains `kind: 'grafana' | 'victorialogs'` (default `grafana`, so existing files keep their meaning; `#52`'s unknown-field keeping does the rest), and for `victorialogs`: `url` (the server, e.g. `http://localhost:9428`, a sub-path kept), `tenant?: { accountId: number, projectId: number }` (sent as `AccountID` and `ProjectID` headers), `auth: 'none' | 'basic' | 'bearer'` and `authUsername?`. The password or token is a secret under `host.secrets` keyed by the connection id (`logs-connection:<id>`), never in the JSON file; `logs.connection.save` takes `secret?: string` and stores it, and `logs.connection.get`/`list` only say `hasSecret`. Validation: `url` must be http(s); a tenant id a non-negative integer.

**Host:** one `LogsBackend` interface in the module (`query`, `hits`, `fieldNames`, `fieldValues`, `check`) with two implementations: the Grafana one, which is the code that exists today moved behind the interface unchanged, and `VictoriaLogsBackend` on `undici` (already a dependency): `POST /select/logsql/query` (`query`, `start`, `end`, `limit`; the answer is JSON lines, parsed line by line, newest first with the same nanosecond ordering the Grafana path has), `/select/logsql/hits` (`step` from the range for about 60 buckets), `/select/logsql/field_names`, `/select/logsql/field_values` (`limit`). The query folding (filters in front, pipes at the end), the level mapping and the entry shape are shared code, so the view cannot tell the kinds apart. Errors: a 401/403 comes back as `SIGN_IN_REQUIRED`-like `LOGS_AUTH_FAILED` with the server's message; a connection refused as `LOGS_UNREACHABLE`. `logs.session` for a direct connection reports `state: 'signed-in'` with `user: null` when a `check` (GET `/select/logsql/field_names` over the last minute, or `/health`) succeeds, else the error. `logs.signin`/`logs.signout` refuse a direct connection with a message saying it needs no sign-in. A new `logs.connection.test` (read, allowed) runs `check` and returns `{ ok, version?: string (from /metrics or the health endpoint when cheap), error? }`.

**UI:** the connection setup form gets a kind switch (Grafana / VictoriaLogs). The VictoriaLogs form: URL, tenant account and project (optional), auth kind, username, password/token (a secret field, never shown back; "Change" to replace), Test. The sidebar row shows the kind and, for direct connections, the test result instead of the signed-in user, and no Sign in/Sign out. Everything else in the view is unchanged.

**Agents:** `logs_connection_save` accepts `secret` and it is masked in the MCP log and the activity feed like other secrets (check how db connections do it and follow that). `logs_connection_test` allowed. The README's Agents list is updated.

**Smoke:** `src/main/smoke/fake-victorialogs.ts`: an HTTP server answering the four endpoints and `/health` from the same entries the fake Grafana serves (share the entry data and the filter logic through one module rather than copying), checking the `AccountID`/`ProjectID` headers and basic or bearer auth when the test asks for them, and refusing with 401 otherwise. Host checks in `parts/logs.ts`: save a direct connection with a secret (the file on disk holds no secret; `get` says `hasSecret`), test ok and test refused with the wrong token, query with filters folded, newest-first and the limit, hits, fields and values, tenant headers received, `signin` refused for a direct connection, history recorded, the agent's `logs_connection_save` with a secret masked in the result, an old-format connection file (no `kind`) still read as Grafana. UI (`--shots`): the setup form switched to VictoriaLogs, Test ok, the query view showing entries from the direct connection; screenshot light and dark.

**Docs:** logs README (What it does, How it works: a "Direct connections" section, Agents, Verified by), the `README.md` logs row ("VictoriaLogs directly or through Grafana").

## Lane D: Git changes as a tree (`feat/git-changes-tree`)

Todo: "view as a tree in git", VS Code's "View as Tree" for the changes: the git sidebar's file groups (merge conflicts, staged, changes, untracked), the file list of a diff tab with several files, a commit's files in the History tab and a pull request's Files are flat lists today. This lane adds a tree layout, remembered per machine, and folder-level actions. (A commit graph is not this lane; the todo's wording is VS Code's.)

**Core:** `packages/core/src/file-tree.ts`: `buildFileTree(paths: { path: string, ... }[], { compact: boolean })` → nodes `{ name, path, kind: 'folder' | 'file', children?, depth, item? }`, folders first then files, both sorted case-insensitively, single-child folders compacted into one row (`src/app/settings`) when `compact` is on, like VS Code; `flattenTree(nodes, collapsed: Set<string>)` → the visible rows with `depth` and `expanded`. Unit tests: nesting, compaction (and a folder with one file and one folder not compacted), sorting, paths with spaces and dots, a rename shown under its new path, collapsed folders hidden, Windows-style separators never produced.

**UI:**
- A **View as tree / View as list** toggle in the git sidebar's header (an icon button with a tooltip, and in the sidebar's ⋯ menu if it has one), stored in the renderer's per-machine UI state (find how the diff layout preference is kept and do the same; it must survive a restart). The same preference applies to every file list the git module draws.
- In tree mode each group renders folders with a chevron, indented rows, folder rows showing the number of files inside; folders collapse and expand on click and remember their state within the tab or sidebar. File rows keep their status letter, actions and context menu exactly as in list mode; a file's shown name is its basename, the folder path is the folder row.
- Folder rows get the group's actions for everything under them: Stage all / Unstage all (the existing commands with the list of paths), Discard (asks first, naming the count), Open changes for each file is not offered on folders. Keyboard: left/right collapse and expand, up/down move, as the rest of the app's lists do.
- Diff tab file list, History commit files and PR Files reuse one shared `q-file-tree` (or an equivalent small component in `packages/modules/src/git/ui/`) so the three places behave the same; the status colours and counts per file stay.

**Smoke (`parts/git/tree.ts`, UI with `--shots`):** in the temp repository, files under `src/a/`, `src/a/b/`, `docs/` and the root changed and untracked: switch to tree view and expect folder rows with their counts, a compacted `src/a/b` row, collapsing a folder hiding its files, staging a folder staging exactly its files (host `git.status` confirms), the preference surviving a reload of the window (the smoke has a way to reload; if not, check it is in the saved UI state file), the History commit's files and a diff tab's list in tree mode, and switching back to list. Screenshot light and dark.

**Docs:** git README (the sidebar and diff tab sections, Verified by), the `README.md` git row ("changes as a list or a tree").

## Lane E: Agent rules per action and per agent (`feat/agent-action-rules`)

Todo: "customized agent access for actions". Rules today name a command (`db.query.run`), a module glob or `*`. A command that does several things is one rule: `db_query_run` is a `SELECT` and a `DROP TABLE`; `teleport_kube_action` is a rollout restart and a pod delete; `git_push` is a push and a force push. This lane lets a rule name what the call does, and optionally which agent it applies to.

**Core (`packages/core/src/registry.ts`, `types.ts`, `permissions.ts`):**
- `defineCommand` gains optional `actions?: { list: readonly string[]; of: (input: Input, ctx) => string | Promise<string>; describe?: Record<string, string> }`. `of` names the action of one call from its validated input; it must be total and cheap (no network), and it may reuse the logic `mutating` already has. The commands that declare actions in this lane: `db.query.run` (`select`, `insert`, `update`, `delete`, `ddl`, `other`; the statement classification `mutating` already does, moved into one function with tests), `db.redis.command` (`read`, `write`, `admin` from the command name), `db.table.apply` (`insert`, `update`, `delete`, `mixed`), `teleport.kube.action` (the action id: `scale`, `scale-to-zero` for 0 replicas, `rollout-restart`, `rollout-undo`, `rollout-pause`, `rollout-resume`, `delete`, `cordon`, `uncordon`, `set-image`, `trigger-cronjob`), `git.push` (`push`, `force`), `git.reset` (`soft`, `mixed`, `hard`), `git.branch.delete` (`delete`, `force`), `git.discard` (`changes`, `untracked`, `both`).
- A rule's `match` may end in `#<action>`: `db.query.run#ddl`, `teleport.kube.action#delete`. `isValidRuleMatch` accepts it only after a full command id (not a glob). Specificity: `id#action` beats `id`, which beats a glob, which beats `*`. A rule may also carry `agent?: string`, the exact client name from the MCP handshake (what the activity feed shows); at equal specificity a rule with a matching `agent` beats one without, and a rule whose `agent` does not match is skipped. `decideAgentPermission` takes `action?: string` and `agent?: string`, and `AgentPermissionDecision.rule` is the one that decided. Unit tests in `permissions.test.ts` for every precedence case, the parser, and invalid matches (`git.*#force`, `#x`, `a#`).
- The MCP server (`packages/mcp/src/index.ts`) computes the action with `command.actions.of(validatedInput, ctx)` before deciding (an `of` that throws counts as action unknown: the command-level rule applies, and the error is logged once), passes the agent's name, and keeps `tools/list` as it is: a deny on an action leaves the tool listed, since another action of it may be allowed; the tool's description gains one sentence listing its actions and which are denied or asked for under the current rules is **not** done (descriptions are static), instead the refusal `details` carry `action` and the rule. `src/main/host.ts`'s approval re-check passes the same action and agent. The approval dialog shows the action beside the tool ("db_query_run · ddl") and **Always allow** offers two choices when the call has an action: this action of the tool, or the whole tool; the rule it adds carries `#<action>` for the first. "Allow for this agent until restart" stays as it is.
- The activity feed entry gains `action`.

**UI (`src/renderer/src/app/agents/rules-editor.ts`, Settings > MCP):** the rules table gains an **Action** column (a picker filled from a new read command `mcp.permissions.actions` → `{ commandId, actions, describe }[]` from the registry, free text otherwise) and an **Agent** column (free text, with the names seen in the activity feed offered). The match validation message names the grammar. Rows read `db.query.run · ddl · claude-code · deny`.

**CLI/MCP docs:** README.md's "Agent permissions" paragraph gains the action and agent grammar; the mcp module README and `docs/cli.md` where they list rules; each module README whose commands declare actions says so in its Agents section (db, teleport, git).

**Smoke (`parts/mcp/permissions.ts`, the existing section):** rules `db.query.run#ddl: deny` with mode allow refuse a `CREATE TABLE` and let a `SELECT` and an `INSERT` through; `teleport.kube.action#delete: ask` under mode allow raises an approval only for a delete and the approval's payload names the action; an `agent`-scoped rule applies to the smoke's MCP client by its name and not to a second client with another name (the smoke already has, or adds, a second MCP client with a different `clientInfo.name`); `git.push#force: deny` refuses a force push while a plain push goes through, with the git fixture that exists; Always allow from the dialog with the action choice writes a `#<action>` rule (UI, `--shots`); the rules editor's Action and Agent columns (UI screenshot light and dark); invalid matches refused by the save command.

## Lane F: Teleport certificate renewal (`feat/teleport-auto-renew`)

Todo: "auto refresh teleport token". A Teleport certificate expires after the cluster's TTL; the sidebar shows a countdown and the state goes `expiring` then `expired`, tunnels and kube queries then fail with `TELEPORT_LOGIN_REQUIRED`, and the user logs in again by hand. "Log in on launch" only covers an expired certificate at startup.

**Behaviour:** a per-cluster setting **Keep me logged in** (`teleport.autoRenew: string[]` of proxies, or a boolean per configured cluster in `TeleportConfig`; the existing `loginOnLaunch` stays and is described as the startup half of it). When it is on for a cluster and the status poll sees it `expiring` (under `TELEPORT_EXPIRING_SOON_MS`) or `expired`, the session runs `tsh login --proxy=<addr>` for it, the same way the sidebar's Log in does (`session.login`), one cluster at a time, at most one attempt per cluster per 10 minutes, never while a login is already running, never for a cluster whose last attempt the user cancelled since that certificate was issued (the cancel is remembered with the certificate's `validUntil`, so the next certificate gets a new attempt). While the certificate is still valid, Teleport may reissue it without the browser; when it does open the browser, the attempt is announced first: a toast and, when the window is in the background, a system notification "Teleport: renewing your certificate for <cluster>" with the login output in the sidebar as today, so a browser window appearing is never a surprise. The attempt waits for the window to be focused or the app to be in the foreground when it would open a browser (the fake tsh tells the two apart by printing the URL line a real `tsh login` prints); on a machine where the window is minimised for an hour, the renewal runs when it comes back, before the user's next query. A failed attempt (the user closed the browser, SSO failed) is logged in the sidebar and retried on the next eligible poll.

**After a renewal:** everything that holds the old certificate is refreshed: database tunnels for that cluster are restarted (the `tsh proxy db --tunnel` processes; connections using them reconnect through the restarted tunnel the way they do after a manual re-login; check `tunnels.ts` and make this a method on it), the private kubeconfig is written again by `tsh kube login` on the next query (invalidate its once-per-run mark), running port forwards are left alone unless they died (tsh forwards hold the old cert too: restart the ones that exit within a minute of the renewal, once). `teleport.changed` (or whatever the module's status event is) is emitted so the sidebar's countdown and state update at once.

**Commands:** `teleport.status` gains `autoRenew: boolean` and `renewal: { lastAttemptAt, lastResult: 'ok' | 'failed' | 'cancelled' | null, nextEligibleAt } | null` per cluster. A new `teleport.cluster.autoRenew` `{ proxy, enabled }` (mutating: it changes what Quiver does on this machine) toggles the setting. `teleport.login` is unchanged.

**Core (`packages/core/src/models/teleport.ts`):** `proxiesToAutoRenew(config, clusters, renewalState, now)` beside `proxiesToAutoLogin`, pure, with unit tests: expiring and expired clusters picked, logged-out ones not, the 10-minute spacing, the cancelled-since-this-certificate rule, one at a time, a cluster with the setting off never picked, a login already running blocking all.

**UI:** a **Keep me logged in** switch per cluster in the sidebar's cluster header menu and in Settings > Teleport beside the cluster, the countdown row saying "renews automatically" when it is on, and a line under it after an attempt ("renewed 2 minutes ago", "renewal failed: …, retrying in 8 minutes", "renewal cancelled until this certificate expires").

**Smoke (`parts/teleport.ts`):** the fake tsh gets a certificate lifetime it can be told to move (`QUIVER_FAKE_TSH_STATE` or a control file the smoke writes): the smoke sets a `validUntil` inside the expiring window with the setting on, expects one `tsh login --proxy=<addr>` in the fake's argv log within one poll (the poll interval must be settable for the smoke, as other timers are), the status going back to `logged-in` with the new `validUntil`, the tunnel for that cluster restarted (a new tunnel process, the connection still working), the kube query after it running `tsh kube login` once more; then with the setting off no login runs; then a cancelled attempt not retried until the certificate changes; and the agent: `teleport_cluster_autoRenew` gated, `teleport_status` showing `renewal`. UI (`--shots`): the switch in the cluster menu, the "renews automatically" line, screenshot light and dark.

**Docs:** teleport README ("Staying logged in" under How it drives tsh, Agents, Verified by), the `README.md` teleport row ("certificates renewed before they expire").

---

## Integration

Done at combine time:

- Merge the shared files: the tools module lists both new tools (QR then DNS) once each in `main.ts`, `ui/tools.ts`, the sidebar and the README; `parts/tools.ts` lists the sections `[core, qr, dns]` (the existing checks as the first section); `ToolDescriptor`'s render kinds are one union; `README.md` rows merged.
- Lane E's `actions` on `git.push` and the rest meet lane D's folder-level stage/discard (which only call existing commands with more paths: no action change) and lane F's new `teleport.cluster.autoRenew` (no actions, `mutating: true`).
- Lane C's `logs_connection_save` secret masking follows the same redaction lane E's activity feed uses for arguments; check the feed never shows the secret.
- Cross-lane smoke: an agent rule `tools.*: deny` (lane E) leaves `tools_qr_encode` and `tools_dns_lookup` out of `tools/list`; a `logs.connection.save` from an agent with a secret shows masked in the activity feed.
- The plan file is committed on the combined branch with its Done / follow-ups section filled in.

## Done / follow-ups

### Built

**Lane A, QR code encoder (#58).**
- `tools.qr.encode` (global, read, allowed) on a pure TypeScript encoder in `packages/core/src/qr.ts` after ISO/IEC 18004: mode detection (numeric, alphanumeric, UTF-8 byte), the smallest version at the level, Reed–Solomon over GF(256), interleaving, the function patterns, all eight masks scored by the penalty rules, format and version information. `renderQrSvg` gives one `<path>` in `currentColor`.
- A QR code tab (`render: 'qr'`, `ui/qr-output.ts`): the symbol on a white tile in both themes (scanners do not read inverted codes), the version line, Copy SVG and Save PNG… through `app.pickSavePath` and `api.response.save` (so it needs an open workspace; no new write path).
- `jsqr` is a devDependency so the unit tests decode every symbol they encode.
- Deviations: the tab draws the symbol from `modules` with `qrSvgPath` rather than injecting the SVG string (no sanitizer bypass). The 2953-byte cap applies in every mode.
- The review fixed: the refusal for a text that fits 40-L but not the chosen level now names that level's capacity in the text's mode; the alignment-pattern test checks every pattern and all 39 versions' centres against Table E.1 (jsqr 1.4 has version 23's centres wrong, noted in the test).

**Lane B, DNS lookup (#59).**
- `tools.dns.lookup` (global, read, allowed) on `node:dns/promises`, one `Resolver` per call; the pure parts (name and resolver parsing, IDNA injected, reverse names, the CNAME chain, error classification, record ordering) in `packages/core/src/dns-lookup.ts`.
- A DNS lookup tab (`render: 'dns'`, `ui/dns-lookup.ts`, its own view in place of both editors): type chips, the chain, the resolver and the time, one table per type.
- `src/main/smoke/fake-dns.ts`, a `dgram` responder with a small zone, started and stopped by `parts/tools/dns.ts`.
- Deviations: records carry `query` (the type asked) and the result has `types` and `empty` (so "No records" and NXDOMAIN differ); CAA data is `{ critical, tag, value }`; CNAME records are the whole chain.
- The review fixed: `1.1.1.1:` taken as port 53; the CNAME entry under `empty` guessed from the other types (NXDOMAIN shown as "No records"); `timeoutMs` being per try with c-ares doubling it (now half per try and a deadline at `timeoutMs`); narrow tabs overflowing sideways (names wrap between labels under 42rem, an ip6.arpa PTR in the fake zone).

**Lane C, VictoriaLogs direct (#61).**
- `LogsConnection.kind: 'grafana' | 'victorialogs'` (default `grafana`), with `url`, `tenant`, `auth` and `authUsername` for direct connections; the password or token through `host.secrets` (`logs-connection:<id>`), `get`/`list` saying only `hasSecret`.
- One `LogsBackend` interface (`packages/modules/src/logs/backends.ts`): the Grafana code moved behind it unchanged, and `VictoriaLogsBackend` on `undici`. `makeLogEntry` is shared, so an entry is equal both ways. New error codes `LOGS_AUTH_FAILED` and `LOGS_UNREACHABLE`; new `logs.connection.test` (read, allowed); `signin`, `signout` and `datasources` refuse a direct connection.
- UI: the Connect switch, the VictoriaLogs form with the secret field (Stored on this machine, Change, Clear) and Test, the kind asked for a new connection, "direct" in the sidebar row.
- `src/main/smoke/fake-logs.ts` holds the entries and filter logic shared by the fake Grafana and the new `fake-victorialogs.ts`.
- Deviations: a stored secret and a direct check are announced as `logs.changed` reason `session` (no new `HostEvents` entry); `normalizeServiceUrl` takes a default scheme.
- The review fixed: an agent could repoint a connection with a stored secret at another `url` and have the secret sent there; such a save is now `mutating` (a per-call function). A secret with a line break or control character is refused (undici quoted it in its error). Responses are streamed with a 64 MB cap, a truncated body is `LOGS_UNREACHABLE`, and the secret is scrubbed from error text.

**Lane D, changed files as a tree (#60).**
- `packages/core/src/file-tree.ts`: `buildFileTree` (folders first, case-insensitive sort, compacted single-folder chains, `/` only, renames under the new path, untracked `new/` kept as one row), `flattenTree`, `fileTreeItems`.
- One shared `q-git-file-tree` draws the sidebar groups, a diff tab's file list, a commit's files in History and a pull request's Files. View as tree / View as list in the Changes header and above a diff list; folder rows with counts, keyboard navigation, and the group's actions for everything under them (Stage, Unstage, Mark resolved, Discard / Delete asking with the count).
- Deviations: the preference lives in the per-machine workspace UI state (`git.fileLayout` in `.quiver/local/state.json`), not where the diff layout is (that one is only in memory), so it is per workspace too. No new host commands; folder actions call `git.stage`, `git.unstage` and `git.discard` with the folder's paths.
- The review fixed: tests for a file and a folder with the same path, a leading `./` and deep chains; a diff list in tree mode opening on git's first file (halfway down the tree) instead of the tree's first file.

**Lane E, agent rules per action and per agent (#63).**
- `defineCommand` gained `actions: { list, of, describe? }`, declared on `db.query.run`, `db.redis.command`, `db.table.apply`, `teleport.kube.action`, `git.push`, `git.reset`, `git.branch.delete` and `git.discard`.
- Rules may end in `#<action>` after a full command id and may carry `agent`; `id#action` beats `id` beats a glob beats `*`, an agent's rule beats an agent-less one at the same level, a deny still wins. Refusals carry `details.action` and the deciding rule; the activity feed records the action.
- The approval dialog shows the action, and Always allow offers the action or the whole tool. `mcp.permissions.actions` (hidden) feeds the rules editor's Action and Agent columns.
- Deviations: the action is computed in `CommandRegistry.authorize`, not in `packages/mcp`, so host-level agent calls get action rules too. The kube check is in `parts/teleport.ts` and the force-push check in `parts/git/manage.ts`, where their fixtures are. The kube action id is `cronjob-trigger` (the catalogue's), not `trigger-cronjob`.
- The review fixed: the SQL classifier, now a tokenizer per engine reading (PostgreSQL simple-protocol pieces, backslash and standard strings, dollar quotes, nested comments, data-modifying CTEs, `SELECT … INTO`, `EXPLAIN ANALYZE`, writing built-ins), which `db.query.run`'s `mutating` shares; Redis `EVAL`/`FCALL` and `CLIENT`/`MEMORY`/`DEBUG` subcommands as `admin`; an `of` that throws now counts the call as mutating; the docs and the UI say agent names are self-declared.

**Lane F, Teleport certificate renewal (#62).**
- Keep me logged in per cluster (`teleport.autoRenew: string[]`, `teleport.cluster.autoRenew`, mutating), in the cluster's new `⋯` menu and in Settings > Teleport.
- `proxiesToAutoRenew` (pure, with `nextRenewalAt`, `setAutoRenew`, `isBrowserLoginLine`) picks expiring or expired clusters with the setting on, one at a time, 10 minutes apart, never a certificate whose renewal was cancelled, nothing while a login runs.
- An attempt that needs the browser waits for the window to be in front (reported through the hidden, UI-only `teleport.window.focus`), with a toast and, in the background, a system notification. After a renewal: `TunnelManager.restartCluster`, the kube login mark dropped, port forwards that exit within a minute restarted once, `teleport.changed` with reason `renewal`.
- `teleport.status` per cluster gained `autoRenew` and `renewal`. The poll interval is settable through `QUIVER_TELEPORT_POLL_MS` for the smoke.
- Deviations: small additive edits in `types.ts` and `defaults.ts` (lane E's files). The cancel line reads "renewal cancelled; log in to renew this certificate". An `ok` attempt counts against the spacing. Attempts are kept in memory per run.
- The review fixed: turning the setting off, removing the cluster or logging out during a renewal cancels it; no renewal during a `tsh logout`; a quit is not a user's cancel; Log in on launch waits for a renewal started at launch; `teleport.window.focus` refuses agents; `restartCluster` racing a connection's tunnel request; `stopCluster`/`stopAll` stopping a tunnel that is still starting; the missing port-forward smoke check.

### Integration

Done on `feat/tools-logs-git-agents-teleport`, merging E, F, C, D, A, B in that order:
- Conflicts: `settings-tab.ts` imports (E dropped an unused `AgentRuleAction`, F added `isAutoRenewOn`: both kept); the `README.md` Teleport and Logs rows (F's and C's text); `packages/core/src/index.ts` (`file-tree`, `qr`, `dns-lookup` appended in that order); the tools module's `main.ts` (one `@quiver/core` import with both lanes' names, `qrEncode` then `dnsLookup` in the commands), `ui/tool-tab.ts` (both output components imported), `ui/tools.ts` (`render?: 'qr' | 'dns'`, the QR descriptor then DNS), the tools README (both sections, one Agents paragraph, one smoke line) and `parts/tools.ts` (`runSections(t, [core, qr, dns])`). Lane A's `parts/tools/core.ts` and lane B's `parts/tools/jwt.ts` were the same old body; `core.ts` was kept (it matches `origin/main`'s old `parts/tools.ts` body apart from the wrapper) and `jwt.ts` deleted. `types.ts` and `defaults.ts` (E and F) merged without conflict, both kept. `package-lock.json` was already consistent with `jsqr` (`npm install` changed nothing; `npm ci` clean).
- `logs.connection.save`'s per-call `mutating` composes with lane E's registry: it declares no actions, so `authorize` evaluates the function as before, and the approval payload goes through `maskArguments`.
- The DNS screenshots were renumbered `08f`–`08i` (lane A had `08d`/`08e` too).
- Cross-lane smoke in `parts/mcp/permissions.ts`: `tools.*: deny` leaves `tools_qr_encode`, `tools_dns_lookup` and every other `tools_` tool out of `tools/list` while other modules stay listed; an agent's `logs_connection_save` with a `secret`, held by an ask rule, shows the secret (and the auth kind) masked in the approval payload, and the activity feed never holds it. The feed records no arguments at all, so the approval payload is the only place they are shown; the plan's "masked in the activity feed" is covered by that.
- Two failures that were not from the lanes, fixed in their own commits:
  - The two `git conflict ui` checks the D and E reviewers saw fail on `origin/main` ("a change on disk is noted…" and "Accept incoming on each conflict…"). The check clicked the conflict tab's Refresh, waited a fixed 400 ms, edited the file on disk and clicked Refresh again. Refresh is disabled while `git.conflict.get` loads, and that runs several git processes, which took 800 to 1063 ms per load in the whole smoke on this machine; the second click was dropped, the load in flight had read the file before the edit, so the "changed on disk" note never came and the Accept incoming check failed after it. The smoke now waits for Refresh to be enabled, clicks, and waits for the load to end. The cause was in the smoke, not the machine's git config or a running Quiver.
  - The api part failed once in the whole smoke ("Unresolved variables: host, stage" after the Insomnia import). A watcher reload of a collection dropped the cache and read the folder; a save landing meanwhile cached its item in a map the reload then replaced with what it had read before the file was there. `FileStore` now runs reloads and its own writes of a collection one at a time, with a unit test that failed before.

- Checks on the combined branch: `npm run typecheck` clean; `npm test` 75 files, 1015 tests passed; `npm run smoke -- --shots` SMOKE PASSED, 1427 checks (the first whole run failed on the three checks above, the second, after the two fixes, passed).

### Final review

Fixed, each in its own commit:
- **`db.connection.save` and `db.connection.test` (a0748e7).** The known hole: an agent could repoint a connection whose password is stored (kind, host, port, TLS or access) and the stored password went to the new place. `db.connection.test` had the same hole and needed no save: an inline connection with a saved `id` and no password reused the stored one. Both are now conditionally mutating, and so is a tunnel command (`access.type: command`) that is not the one already saved, since saving or testing one let an agent start any process without mutations. A rename, or a test of the connection as it is, stays allowed. Smoke check in `parts/db.ts`, db README's Agents and Verified by.
- **`metabase.connection.save` (1dc7fe2).** The same pattern: the API key is stored per connection and was sent to a new `url` an agent gave. Now mutating for that case only. Smoke check in `parts/metabase.ts`, metabase README.
- **`FileStore` (cc506ac).** eb5bae1 queued reloads and writes, but a `get`/`list` that found the cache dropped by a reload still read the folder a second time; the put queued behind the reload cached its item in the reload's map, and the get's read, finishing last, replaced it, so the saved item was missing until the next reload. A load now joins the read under way, and a read a reload or invalidate superseded caches nothing. A unit test that failed before.
- **Smoke robustness (04bbde6).** The Teleport check that an expired certificate's renewal waits for the window read the status after a fixed 1.5 s; it now waits for the hold. The DNS timeout check's bound went from 1000 ms to 1400 ms (still below the 1500 ms two doubling tries would take).
- **Docs (8fbed2d, e7bd2f3).** README's Agent permissions and the db README say an action rule covers its own tool only (`db_export` runs SQL and `db_transaction` commits under their own rules); the smoke README lists the fake DNS responder.

Secret-per-connection modules checked: logs (fixed by lane C's review), db (fixed here), metabase (fixed here), queues (`queues.connection.save` is always mutating and `queues.connection.test` with an id and a draft is mutating: already right), realtime (no secret stored per connection), api environments (secrets are variables an agent's sends may use by design; masked in results).

Looked at and left:
- Lane E's registry with lane C's and these conditional saves: the `mutating` function is evaluated after the action, the approval payload is masked, a function that throws refuses the call. Lane F's `teleport.cluster.autoRenew` is plain `mutating`; `teleport.window.focus` refuses every caller but the window. `teleport.kube.history.rerun` cannot get round a `teleport.kube.action#delete` rule: agents may not rerun actions at all.
- `git.discard`'s action is worked out from `git status` and the paths given, the same plan the handler uses, so lane D's folder actions get the right one. The status is read again by the handler, so a file whose state changes while an approval waits may be discarded as the other kind; left.
- `FileStore` queue: no deadlock (loads never queue, `onChange` is synchronous), a failed job does not stall the next (`catch` before `then`), a `put` then a `get` sees the item.
- Security pass: DNS names and resolvers are validated (an IP for the resolver), VictoriaLogs requests are a form POST with secrets refused when they hold control characters and scrubbed from errors, `tsh login --proxy=<addr>` is one argv element, the QR tab draws from `modules` without injecting markup, `mcp.approval.respond`, `mcp.permissions.*` and `teleport.window.focus` refuse agents.
- Smoke: the many fixed `wait()`s in the lanes are in UI checks (not run on Windows CI) or before negative checks; config is restored in `finally` in the permission, kube and force-push checks. `QUIVER_TELEPORT_POLL_MS` and the Teleport autoRenew settings are restored at the end of their block, not in a `finally`.
- An agent can still change a `{{variable}}` in the active environment that a db connection's host or tunnel command uses (`api_variables_set` is allowed for the active environment); the gate compares the saved fields, not their resolved values.

Checks after the fixes: `npm run typecheck` clean; `npm test` 75 files, 1016 tests, twice; `npm run smoke -- --shots` SMOKE PASSED, 1429 checks in 675 s.

### Follow-ups

- Agent changes to a `{{variable}}` a db connection resolves (its host or tunnel command) are not gated like a change of the field itself.
- Real `tsh login` with a still-valid certificate is untested against a real cluster. It most likely prints the profile and keeps the certificate, so renewal before expiry would fail ("tsh kept…", retried every 10 minutes) and the real renewal would happen after expiry through the browser. Consider a quieter result than `failed` for that case.
- Agent-scoped ask rules and Always allow: the rule Always allow writes has no `agent`, even when the ask that triggered it was for one agent, so it allows every agent.
- Lane E: when `actions.of` throws, `id#action` deny and ask rules do not apply (only whole-tool rules, then the mode). Applying them would be stricter.
- An expired cluster waiting for the window holds back an expiring one that would not need the browser (one cluster at a time). A tunnel restart drops in-flight queries on it for a moment.
- DNS: narrow tables wrap names between labels under 42rem; check the wrapping again on very long TXT values and in the dark theme.
- The light-theme editor screenshots render dark (pre-existing, not from these lanes).
- `maskArguments` treats the key `auth` as a credential name, so the approval dialog shows a logs connection's auth kind masked.
