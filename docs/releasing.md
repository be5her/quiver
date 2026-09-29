# Releasing

Nothing is released by hand: two workflows build and publish GitHub Releases, and installed copies find them through the `latest*.yml` manifests electron-builder attaches. The version in `package.json` is stamped during those builds and never committed; the `vX.Y.Z` tags are the record, and the committed value is only what local builds report.

**Beta, on every merge to `main`** ([.github/workflows/beta.yml](../.github/workflows/beta.yml)). The Windows installer is built as `X.Y.(Z+1)-beta.N`, where `X.Y.Z` is the last stable release and `N` counts the commits since it (so `0.3.1-beta.4` is the fourth merge after 0.3.0), and published as a prerelease. Copies with Beta builds on see it at their next check (Settings → About → Check for updates to not wait); everyone else ignores prereleases. Only the ten newest betas are kept; older ones are deleted with their tags. A beta that fails to build is simply skipped; the next merge produces the next one.

**Stable, on every merge into `stable`** ([.github/workflows/stable.yml](../.github/workflows/stable.yml)).

1. Open a pull request from `main` into `stable`. The Stable workflow comments the version it will release and the notes: the last stable version bumped by the largest pull request merged since it, where `breaking` bumps major (minor while the version is 0.x), `enhancement`, `design`, a `feat/…` branch or a `feat:` title bumps minor, and anything else patch. Label the pull request into `stable` with `release:major`, `release:minor` or `release:patch` to choose yourself; the comment updates.
2. Merge it with **Create a merge commit**, never squash or rebase: `stable` must keep `main`'s history, or the next plan would count everything again (the workflow refuses to release a squashed merge).
3. The workflow drafts `vX.Y.Z` with those notes, builds Windows, macOS and Linux into it and publishes it as the latest release. Allow ten to fifteen minutes. Edit the notes on GitHub afterwards if you like.

Fix a failed stable build on `main` through a pull request and open the next pull request into `stable`; the plan starts again from the last published release, so delete the leftover draft if the version changed. Re-running a release that was published does nothing. electron-builder refuses to upload into a published release, so a published version is final. Hotfixes go through `main` like everything else.

Setup, once: create `stable` from the last release (`git push origin v0.3.0^{commit}:refs/heads/stable`), and allow merge commits in the repository settings (squash can stay the default for `main`).

## Updates in the app

Quiver looks for a newer release on GitHub shortly after launch and every six hours. When there is one, the status bar shows "Update to vX" (or "vX available" where the build cannot replace itself); nothing is downloaded until you click. Settings → About has "Check for updates", the release notes and a "Restart to install" button once the download is verified.

On Windows, Settings → About also has **Beta builds**: with it on, Quiver also offers the build made from every pull request merged into `main` (published about ten minutes after the merge) as well as stable releases, whichever was published last, and checks every hour instead of every six. Turning it off never downgrades: the copy keeps its beta until a newer stable release ships. The setting is per machine.

Local check: `npm run package` builds the installer for this platform into `release/`; to exercise the updater against it, package a higher version too, serve `release/` over HTTP and run the older `release/win-unpacked/Quiver.exe` with `QUIVER_SMOKE=1 QUIVER_UPDATE_FEED=http://127.0.0.1:<port>/`, which checks, downloads and verifies the newer build without installing it.

## Signing

Signing is not set up yet. When it is: for Windows add the `WIN_CSC_LINK` (base64 `.pfx`) and `WIN_CSC_KEY_PASSWORD` repository secrets; for macOS add `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`, remove `identity: null` from `electron-builder.yml`, set `mac.notarize: true`, and flip `MAC_SIGNED` in `src/main/updater.ts` so macOS copies update in place.
