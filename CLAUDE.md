# Working on Quiver

Quiver is a per-project developer toolbelt: Electron + Angular in an npm workspaces monorepo. README.md is the overview; each module has its own README under `packages/modules/src/<name>/` (what it does, storage, which tools agents may call), `packages/core/README.md` covers the engine and storage, `src/renderer/README.md` the shell, and `docs/releasing.md` the release process. This file is about how changes get made.

## One branch and one pull request per change

Every feature, fix or chore is its own branch and its own pull request against `main`. Never commit to `main` or `stable`, never push tags, never create, edit or publish releases: every merge to `main` ships as a Windows beta, and the owner releases stable by merging `main` into `stable` (`docs/releasing.md`).

1. Start from a fresh `main`: `git checkout main && git pull --ff-only origin main`.
2. Branch: `git checkout -b feat/<short-name>` or `fix/<short-name>`.
3. Implement (conventions below). Add smoke checks in `src/main/smoke.ts` for new behaviour and unit tests in `packages/core` for pure logic.
4. Verify all three, and fix what fails: `npm run typecheck`, `npm test`, `npm run smoke`. For UI changes run the smoke with `QUIVER_SMOKE_SHOTS=<dir>` and look at the screenshots.
5. Update the docs when behaviour changes: the module's README (`packages/modules/src/<name>/README.md`: what it does, how it works, its Agents section listing allowed and gated tools, what the smoke covers), the module's line in the README.md table when the one-line summary changes, `src/renderer/README.md` for shell changes, and `docs/releasing.md` for release changes. A new module gets a README and a row in the table.
6. Commit with a message that says what changed and why. The clone is configured with the owner's author identity; keep it.
7. Push and open the pull request: `git push -u origin <branch>`, then `gh pr create` with a title and a body following `.github/pull_request_template.md` (what changed, how it was verified, screenshots for UI, decisions worth knowing), and one label: `breaking`, `enhancement`, `design`, `bug` or `documentation` (none for chores). The label decides the next stable version and its section in the release notes. The owner asked for pull requests to be opened this way.
8. Report the pull request link. Do not merge. If CI fails on the pull request, fix it on the same branch and push again.

## Conventions

- A feature is a set of registry commands (`defineCommand` with a zod input schema) plus UI. Commands are the only way the UI talks to the host, so the palette, the MCP server and a future CLI get every feature for free.
- Mark commands that delete, write externally or change shared state as `mutating` (a function for per-call decisions). Agents get those refused until the user enables mutations.
- Secrets go through `host.secrets` (encrypted per machine, under `.quiver/local`), never into committed files, and are masked for MCP callers.
- Committed data: `.quiver/<collection>/<id>.json`, one item per file. Per-machine data: `.quiver/local/`.
- Host to UI notifications: add the event to `HostEvents` in `packages/core/src/types.ts`; the UI refreshes with `useInvoke(..., { refreshOnEvents })`.
- Module layout: `packages/modules/src/<name>/main.ts` (Node side) and `ui/` (Angular side), registered in `packages/modules/src/main.ts` and `ui.ts`. The Node side is listed in `tsconfig.node.json`; `src/renderer/tsconfig.app.json` picks up every `ui/` folder. UI code follows `src/renderer/README.md` (standalone components, signals, Signal Forms, no experimental APIs).
- Line endings are LF everywhere (`.gitattributes`). On Windows, git's CRLF warnings are expected.
- No new dependency without a sentence in the pull request saying why.

## Releasing (owner only)

Merging to `main` publishes a Windows beta (`.github/workflows/beta.yml`). Merging a pull request from `main` into `stable` with a merge commit bumps the version from the merged pull requests' labels and publishes a stable release for all three platforms (`.github/workflows/stable.yml`, `scripts/release/`). Versions live in tags, not in committed `package.json`. Details in `docs/releasing.md`.
