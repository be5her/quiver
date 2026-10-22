# Smoke test

`npm run smoke` builds the app, starts Electron with `QUIVER_SMOKE=1` and runs every check against local fakes: an echo server, a GraphQL endpoint, WebSocket and SSE servers, a RESP server standing in for Redis, a fake Grafana, a fake `tsh` and MCP servers. Nothing outside the machine is touched, user data goes to a temporary folder and Quiver's MCP server listens on a private port, so a Quiver you have open is left alone. The run prints one `PASS` or `FAIL` line per check, a table of checks and time per part, and exits non-zero when a check failed.

## Running part of it

The checks are split into parts, one per module plus `shell` for the app around them and `cli` for the `quiver` command line. While working on a change, run the parts it touches; before committing, run the whole smoke once, because a change in one place can break another.

```
npm run smoke                       every part, after a full build (CI runs this)
npm run smoke -- db                 the db part only
npm run smoke -- db teleport        several parts
npm run smoke -- --skip logs,mcp    every part but these
npm run smoke -- db --shots         with the UI checks, screenshots in out/smoke-shots
npm run smoke -- db --shots <dir>   screenshots somewhere else
npm run smoke -- --list             the parts and what each covers
```

A run that names parts (or skips some) rebuilds the renderer only when something it is built from (`src/renderer`, `packages`, the lockfile) changed since the last build, so a change to host code alone does not wait for the Angular build (15 seconds with a warm cache, a minute without). A full run always rebuilds everything. The summary of a partial run lists the parts that did not run.

The UI checks only run with screenshots (`--shots` or `QUIVER_SMOKE_SHOTS=<dir>`); without them the window only loads for the shell's theme checks, and a part-only run of a module does not open it at all. `QUIVER_SMOKE_MYSQL=mysql://user:pass@host:3306/db` and `QUIVER_SMOKE_POSTGRES=postgres://user:pass@host:5432/db` add checks against a live server to the db part. When starting Electron by hand, `QUIVER_SMOKE_PARTS` and `QUIVER_SMOKE_SKIP` (comma-separated names) pick the parts.

## How it is built

- `index.ts` is the runner. It starts the fixtures, then sets up the core every part relies on: the private MCP port, a workspace in a temporary folder, the active environment `local` (`{{baseUrl}}` is the echo server, `{{token}}` the secret `s3cret`) and an MCP client for that workspace. `PARTS` lists the parts in the order they run.
- `fixtures.ts` starts the local servers; the `fake-*.ts` files are the fakes with more to them. `certs/` holds test-only TLS material for the mutual-TLS server in `fake-network.ts` (see its README).
- `part.ts` holds the contract and small helpers (`until`, `processAlive`, `freePort`, `runSections`).
- `parts/<name>.ts` is one part. Its `run(t)` does the host checks: commands, files on disk and the same features as an agent sees them over MCP. It may return hooks that run later, each in its own phase and in part order: `renderer` once the window has loaded, `ui` with screenshots to drive the window, and `after` once every part's UI is done.
- A part that several people work on at once is split into sections, `parts/<name>/<section>.ts`, each a `SmokeSection` with the same shape as `run`; `parts/<name>.ts` then only lists them, `run: (t) => runSections(t, [a, b, ui])`. The sections run in that order, and their hooks are chained in the same order per phase. A section that throws stops the part like any other failure, and the sections after it do not run. Git, the process runner and Queues are built this way.

Every part runs in the same workspace and app, one after another, so a part may count on what it set up itself but not on another part: run alone, it must still pass. When a check needs something another module makes (a second environment, enough open tabs), the part creates it. Each part's UI starts in the light theme with whatever module was last on screen, so it opens its own module first and turns on the dark theme where a screenshot wants it. If a part throws, its remaining checks are skipped, the failure is reported under its name and the other parts still run.

## Adding checks

Put a module's checks in its part, next to the related ones: host checks in `run`, UI checks in the `ui` hook. When the part is split into sections, put them in the section for that area (`parts/git/local.ts`, not `parts/git.ts`); a fake only that section needs is started and stopped by the section itself, in its `after` hook, rather than in `fixtures.ts`. A new module gets a new file in `parts/` and an entry in `PARTS`. Then run that part, and the whole smoke before committing. The module's README says what its part covers under "Verified by".
