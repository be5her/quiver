# Plan: Git blame, conflict editor, pull request drafts, worktrees

**Status: combined, awaiting the final review.** The four lanes were built and reviewed as #56 (A, blame), #54 (B, conflict editor), #53 (C, pull request drafts) and #55 (D, worktrees). They were merged with #52 (`fix/keep-unknown-fields`) into `feat/git-blame-conflicts-worktrees`, which went through the whole test suite and the whole smoke and became one combined pull request. The five pull requests stay open for the owner. What was built, how it differs from this plan, and what is left is under [Done / follow-ups](#done--follow-ups).

## How the work runs

1. **Build (4 agents in parallel, one git worktree each).** Each lane branches from `origin/main` (`git fetch origin && git switch -c <branch> origin/main`), runs `npm ci`, implements its lane, adds unit tests and smoke checks, updates the docs, verifies, commits, pushes and opens its pull request (label `enhancement`).
2. **Review per pull request (1 agent per lane).** A fresh agent reads the lane's diff against this plan and `CLAUDE.md`: bugs, input reaching argv, missing `mutating`, missing tests, docs that don't match the code, UI problems in the screenshots. It fixes what it finds on the same branch, reruns the checks and pushes.
3. **Combine.** `feat/git-blame-conflicts-worktrees` from `origin/main`, merging #52 and the four lane branches, resolving the shared files, doing the cross-lane wiring under [Integration](#integration). Typecheck, the whole `npm test` and the whole `npm run smoke -- --shots` run here, once. One pull request that combines all five.
4. **Final review (1 agent)** of the combined pull request; it fixes what it finds, reruns everything and adds a review summary to the pull request body.

**Checks:** lanes and their reviews run targeted checks only: `npm run typecheck`, `npx vitest run <touched test files>`, `npm run smoke -- git --shots`. Each lane pull request body says verification was targeted and that a combined pull request follows. The whole test suite and the whole smoke run on the combined pull request.

Pushing: `git -c credential.username=be5her push -u origin <branch>`. Before `gh pr create`/`gh pr edit`: `gh auth switch --user be5her`; afterwards `gh auth switch --user Besher-Karam`. Nothing gets merged.

## Rules every lane keeps

They are the git module's existing rules (`packages/modules/src/git/README.md`, `local.ts`):

- One git process per call, run at the repository root, with stdin closed. Refs and paths go through `GitArgSchema` (nothing starting with `-`), and paths always come after `--`.
- Parsers for git output go in `packages/core/src/git-parse.ts`, with unit tests in `git-parse.test.ts`. Models and zod schemas go in `packages/core/src/models/git.ts`. Use NUL-separated output wherever git offers it.
- Writes are `mutating`, emit `git.changed` (with the right `reason`) and give back the new status or the changed object. Reads are open to agents.
- Every write the UI shows is announced. UI follows `src/renderer/README.md`: standalone components, signals and the shared components in `packages/ui`.
- Each lane updates the git README: the command table, the UI section, the Agents section and the smoke coverage.

## Shared files (expect conflicts at combine time; keep edits small and additive)

| File | Lanes |
| --- | --- |
| `packages/core/src/models/git.ts`, `packages/core/src/git-parse.ts` (+ tests) | all, appended in separate blocks |
| `packages/modules/src/git/commands-*.ts`, `local.ts` | all; new lanes prefer a new file (`commands-blame.ts`, `commands-conflict.ts`, `commands-worktree.ts`) registered in `main.ts` |
| `packages/modules/src/git/ui/index.ts` (tabs, palette) | all, one entry each |
| `packages/modules/src/git/ui/git-sidebar.ts` | A (file menu: Blame), B (conflict rows open the editor), D (Worktrees section) |
| `packages/modules/src/git/ui/diff-view.ts` | A (Blame button), B (replaces the "resolve in your editor" note) |
| `packages/modules/src/git/ui/branches-tab.ts` | D |
| `packages/modules/src/git/ui/prs-tab.ts` | C |
| `src/main/smoke/parts/git*` | all; each lane adds its own section or file |
| `packages/modules/src/git/README.md`, `README.md` git row | all |

---

## Lane A: Blame (`feat/git-blame`)

**Host:** `git.blame` `{ path, ref?, ignoreWhitespace? }` (read, allowed). It runs `git blame --porcelain [-w] [<ref>] -- <path>`, parsed by `parseBlamePorcelain` in core into `{ path, ref, lines: { line, commit, originalLine }[], commits: Record<hash, { hash, author, authorEmail, authorTime, summary, previous?: { commit, path }, boundary }> }`. Commits are listed once, not per line. Uncommitted lines (the all-zero hash, "Not Committed Yet") get `commit: null`. Files over 2 MB and binary files are refused with a clear message, as `git.file.show` refuses them. The repository's `.git-blame-ignore-revs` is used when it exists, via `--ignore-revs-file`.

**UI:** a **Blame** tab (`git.blame`, one per path+ref). It shows the file read-only in CodeMirror with a gutter. Each run of lines from the same commit shows the short hash, the author and a relative date once, coloured by age. Hovering shows the summary and the full date. The tab has these actions:
- Clicking a commit opens it, the same way History opens a commit.
- **Blame before this commit** re-blames at `<commit>^`, using `previous.path` so renames are followed.
- **Back** returns to the previous blame.
- A ref field.
- A whitespace toggle.

It opens from the sidebar file menu, from a **Blame** button in the diff tab header, from the History file list and from the palette ("Git: Blame file", which asks for a path).

**Tests:** porcelain parser cases in core: repeated commits, uncommitted lines, boundary, `previous`, a filename with spaces, CRLF content. The smoke covers blame of a file in the temp repo with two commits and the right line attribution, `ref`, uncommitted lines, an option-like path refused, and a binary file refused. The UI check takes a screenshot.

## Lane B: Conflict resolution editor (`feat/git-conflicts`)

**Host:**
- `git.conflict.get` `{ path }` (read, allowed) gives back:
  - `{ path, kind, ours, theirs, base, working, labels: { ours, theirs }, binary }`
  - `kind` is `both-modified`, `both-added`, `deleted-by-us`, `deleted-by-them`, `added-by-us` or `added-by-them`, taken from the status codes.
  - `ours`, `theirs` and `base` are index stages 2, 3 and 1 (`git show :2:<path>`); null when the stage is absent.
  - `working` is the file on disk, with markers.
  - The labels name what the operation means. In a merge, ours is the current branch and theirs is `MERGE_HEAD`'s name. In a rebase they swap: ours is the branch being rebased onto, theirs is the commit being replayed. Cherry-pick and revert are labelled too.
- `parseConflictMarkers(text)` in core splits text into plain and conflict chunks. It handles the `merge`, `diff3` and `zdiff3` styles (`|||||||` base sections), CRLF, and nested-looking lines that are not markers. `renderResolution(chunks, choices)` builds the result. Both get unit tests.
- `git.conflict.resolve` `{ path, content?, take?: 'ours' | 'theirs' | 'base' | 'delete' }` (mutating), exactly one of the two:
  - `content` writes the file and stages it. It is refused while conflict markers remain, unless `allowMarkers: true`.
  - `take` uses `git checkout --ours/--theirs -- <path>` then `git add`, the base stage, or `git rm` for delete.
  - It emits `git.changed` and gives back the new status. A path that is not unmerged is refused.

**UI:** a **Conflicts** tab (`git.conflict`, one per path). It holds an editable result editor (CodeMirror) where each conflict is highlighted, current (ours) in one colour and incoming (theirs) in another, and labelled with `labels`. Each conflict has its own actions: Accept current, Accept incoming, Accept both (current first, or incoming first), and Accept base when a base exists. Above the editor:
- a counter and previous/next conflict
- whole-file Take current / Take incoming
- **Mark resolved**, enabled once no markers are left, which saves and stages the file

Deleted-by cases show a short explanation with Keep the file / Delete the file. Binary files offer only take-ours/theirs. Conflicted rows in the sidebar open this tab, and the diff view's "resolve the markers in your editor" note becomes an "Open conflict editor" button. When the last conflict is resolved, the tab points at the operation banner's Continue.

**Tests:** marker parser and resolution in core. The smoke uses the conflicting merge the git part already builds:
- get, for both stages and the labels
- resolve with content, which is refused while markers remain
- take ours
- a rebase conflict, for the swapped labels
- deleted-by-them
- agents gated on resolve

The UI check opens the editor, accepts incoming and marks resolved, with a screenshot.

## Lane C: Pull request description draft (`feat/git-pr-draft`)

There is no LLM in Quiver. The draft is built only from git data, and it is a read command, so an agent connected over MCP can write prose on top of it.

**Host:** `git.pr.draft` `{ base?, includePatch? }` (read, allowed).
- The base is the given branch or the default branch of the remote (`origin/<default>`, then the local default). It works before the branch is pushed and does not need `gh`.
- It gives back `{ head, base, mergeBase, title, body, commits: { hash, subject, body }[], files: { path, status, additions, deletions }[], stats, template: string | null, labels: string[], patch?: { text, truncated } }`.
- `title`: the single commit's subject, or the branch name made readable (`feat/git-blame` → "Git blame").
- `body`: the repository's pull request template, looked up in `.github/pull_request_template.md`, `.github/PULL_REQUEST_TEMPLATE.md`, `docs/`, the root, then the first file of `.github/PULL_REQUEST_TEMPLATE/`. Sections whose heading matches a known name are filled:
  - what changed, summary or changes: the commit subjects, with bodies indented
  - files: files grouped by top folder with +/−
  - Other sections are left as the template has them.
  - Without a template, a default body has Summary (commits) and Changes (grouped files).
- `labels`: suggested from the branch prefix (`feat`→`enhancement`, `fix`→`bug`, `docs`→`documentation`). Only labels the repository has are kept, when `gh` can list them; otherwise none.
- `includePatch`: the `base...HEAD` diff, capped at 200 KB, with `truncated`.

Parsers and the filling logic (template sections, title from branch, grouping) are pure functions in core with unit tests.

**UI:** the create-pull-request form in the PRs tab gets a **Draft from changes** button. It fills the title, body, base and label (asking before replacing text the user typed) and shows a small summary of commits and files changed. When the form opens on a branch with commits, it fills empty fields automatically.

**Tests:** core unit tests for template filling and titles. The smoke covers a draft in the temp repo with a branch of two commits, with and without a template, a patch cap, and that it is not gated. The UI check takes a screenshot of the filled form.

## Lane D: Worktree handling (`feat/git-worktrees`)

Two parts: make everything work in a linked worktree, and manage worktrees.

**Correctness in linked worktrees.** Audit every place that assumes `.git` is a folder at the root: the watcher (it must watch `gitDir` for HEAD and the index and `commonDir` for refs and the stash), operation detection, `git.file.show`, stashes and the PR branch lookup. Fix what breaks. The smoke runs a status, stage, commit, stash and the watcher's `git.changed` inside a linked worktree.

**Host:**
- `git.worktree.list` (read, allowed). It runs `git worktree list --porcelain -z`, parsed by `parseWorktreeList` in core into `{ path, head, branch, detached, bare, locked, lockReason, prunable, prunableReason, main, current }[]`.
- `git.worktree.add` `{ path?, branch?, newBranch?, from?, detach? }` (mutating). The default path is `<repo parent>/<repo name>.worktrees/<branch with / as ->`. It refuses a path inside another worktree or an existing non-empty folder.
- `git.worktree.remove` `{ path, force? }` (mutating). It refuses the main worktree and the current one. Without `force`, git's refusal on a dirty worktree comes back as a clear message.
- `git.worktree.lock` `{ path, reason? }`, `git.worktree.unlock` `{ path }` and `git.worktree.prune` (all mutating).
- `git.status` gains `worktree: { linked: boolean, mainPath: string }`.
- `git.branch.list` gains `worktreePath` (from `%(worktreepath)`) for branches checked out in another worktree. `git.checkout` and `git.branch.delete` turn git's "already checked out at" / "used by worktree" refusals into messages naming the path.

Worktree commands emit `git.changed` with a new reason `worktrees`; the watcher fires it when `commonDir/worktrees` changes.

**UI:**
- A **Worktrees** section in the sidebar. Each row shows branch, path, and locked/prunable/current badges, with these actions:
  - **Open as workspace** (`workspace.open`)
  - reveal in the file manager, copy path
  - lock/unlock
  - remove (asks first; asks again with force when git refuses a dirty one)
  - **New worktree…** opens a dialog: an existing branch or a new branch from a ref, with the path filled in from the default and editable.
  - **Prune**
- In the Branches tab, a branch checked out elsewhere shows an "in worktree" badge with the path and an **Open worktree** action, and every branch gets **New worktree from branch**. Checking out such a branch offers to open its worktree instead.
- In a linked worktree, the status bar's branch item shows a worktree marker with the main path in its tooltip.

**Tests:** the porcelain parser (main, linked, detached, locked with reason, prunable, bare, paths with spaces) in core. The smoke covers:
- add with a new branch and with an existing branch
- list
- branch list `worktreePath`
- checkout refused with the friendly message
- lock/unlock
- remove, refused for the current and main worktrees and for a dirty worktree without force
- prune
- the linked-worktree correctness checks above
- agents gated

The UI check takes screenshots of the section and the dialog.

---

## Integration

Done at combine time:

- Merge the shared files. Each lane's commands are registered once, and the git README's tables stay in one order.
- Blame from the conflict editor's per-side context (which commit introduced the incoming change) if it falls out cheaply. Otherwise list it under follow-ups.
- The worktree marker and `git.status.worktree` live alongside the PR draft's base detection; the draft works inside a linked worktree.
- The README.md git row names blame, the conflict editor, PR drafts and worktrees.
- #52's change is merged as is.

## Done / follow-ups

### Built

**#52, keep unknown fields** (merged as is). Saving a committed item no longer drops fields this version does not know. Modules declare their committed collections and item schemas (`ModuleMain.collections`), and `FileStore.put` merges the stored file back in with `keepUnknownFields`. That covers objects by key, arrays by `id`, records, and a union only while one option fits both values.

**Lane A, blame (#56).**
- `git.blame` (read, allowed): `parseBlamePorcelain` in core, the repository's `.git-blame-ignore-revs` used (and dropped when git refuses it), and the same refusals as `git.file.show`.
- A Blame tab with a gutter coloured by age. A click on a marker opens the commit; the right-click menu has Blame before this commit, Back, a ref field and Ignore whitespace.
- Entry points: the sidebar file menu, the diff header and file list, the history and the palette.
- `q-code-editor` gained `lineMarkers` (`packages/ui/src/code-editor/line-markers.ts`).
- Deviations: each line carries its `text`, and each commit carries its `path`. Blame before this commit follows `previous` rather than a literal `<commit>^`, so renames and merges are right.
- The review fixed: a path outside the repository at a ref, untracked files, the ignore-revs retry's error, symbolic links (`lstat`), and a lone CR inside a line shifting the gutter.

**Lane B, conflict editor (#54).**
- `git.conflict.get` (read) and `git.conflict.resolve` (mutating), in `commands-conflict.ts`.
- Core gained `parseConflictMarkers`, `renderResolution` and the label logic for merge, rebase, cherry-pick, revert and stash apply.
- A Conflicts tab built on a new shared `q-conflict-editor` in `packages/ui`, so the git module needs no CodeMirror dependency.
- Conflict rows in the sidebar and the diff view's note open the tab.
- Deviations: `kind` also has `both-deleted`, and the result carries `operation`, `tooLarge` and `markerSize`. `take: 'base'` uses `checkout-index --stage=1`. Exactly-one-of is checked in the handler, so the MCP schema stays a plain object. There is no palette entry.
- The review fixed:
  - `conflict-marker-size`
  - half-deleted conflicts whose leftover markers could be staged
  - unsaved edits lost on reload (the tab is now dirty and asks before closing)
  - the final newline git adds
  - submodule conflicts
  - the label of a pull's merge

**Lane C, pull request drafts (#53).**
- `git.pr.draft` (read, allowed), built from git alone. Pure logic in `packages/core/src/pr-draft.ts`.
- Base detection follows gh's remote order. The draft fills the repository's template, suggests labels from the branch prefix (kept only when `gh label list` has them), and adds an optional patch capped at 200 KB.
- The create form has Draft from changes, fills itself on open, and gained a Labels field.
- Deviations: the logic lives in `pr-draft.ts`, not `git-parse.ts`. The result also has `baseRef` and `templatePath`. Merge commits are left out. The list is capped at 250 commits and 300 files in the body.
- The review fixed: a template read through a link that leads out of the repository (now `realpath` inside the root), the default remote order in a fork, the button comparing with local `main`, drafting with no commits, the commit-cap note, and `--` hardening.

**Lane D, worktrees (#55).**
- Correctness in linked worktrees:
  - `repoDirs` resolves the git dir and the common dir by real path.
  - `git.status` gained `worktree: { linked, mainPath }`.
  - The watcher watches the git dir and the common dir, including `worktrees/` as git creates and deletes it.
- `git.worktree.list/add/remove/lock/unlock/prune`, plus a hidden UI-only `git.worktree.reveal`.
- `git.branch.list` gained `worktreePath`. Checkout and delete give friendly checked-out-elsewhere refusals.
- A new `git.changed` reason, `worktrees`.
- UI: a Worktrees sidebar section, the New worktree dialog, Branches tab badges and actions, and the status bar marker.
- `HostApi` gained an optional `revealFolder`.
- Deviations: remove also refuses a worktree open as another workspace and a locked one. git 2.36 (`list -z`) and 2.23 (`%(worktreepath)`) fall back for older git.
- The review fixed: the main worktree taken for a linked one through a junction or a lower-case drive letter, older git versions, the watcher not re-watching `worktrees/` after the last linked worktree went, paths matched by real path, reveal limited to folders, a quote in a worktree folder name, and the sidebar's current branch in a linked worktree.

### Integration (the combined pull request)

- **Shared files merged.**
  - Commands are registered once in `main.ts`, in the order local, manage, pr, draft, blame, conflict, worktree.
  - Core models and parsers keep each lane's block in lane order.
  - The smoke sections run as local, manage, pr, ui, blame, conflict, draft, worktrees.
  - The git README's command tables run Local repository, Managing the repository, Blame, Resolving conflicts, Worktrees, Pull requests (with Drafting a pull request), each command listed once. The Agents lists, the panel, the smoke coverage and the unit tests are merged into one text each.
  - The README.md git row names all four features.
- **Screenshot names.** Lanes B and D both used `33a`–`33e`, and `34a`–`34e` belongs to the runner. Every git screenshot now sits under git's `32`, the lanes with a letter of their own:
  - blame `32ba`/`32bb`
  - conflicts `32ca`–`32ce`, renumbered in the order they are taken
  - drafts `32pd`/`32pe`
  - worktrees `32wa`–`32we`
- **Inside a linked worktree.** The worktree smoke now also checks, from a linked worktree opened as a workspace: `git.blame` giving lines to the commit made there; `git.pr.draft` of its branch against the shared `main`; and, on the merge it stops, `git.conflict.get` (stages, and labels read from the linked worktree's own `MERGE_MSG`) and `git.conflict.resolve` writing and staging its file while the main worktree's copy stays as it was.
- **Blame from the conflict editor.** `git.conflict.get` gained `commits: { ours?, theirs? }`: HEAD, and the incoming commit (`MERGE_HEAD`, `CHERRY_PICK_HEAD` or `REBASE_HEAD`; none in a revert or a stash apply). The Conflicts tab's header has Blame current and Blame incoming, which open the Blame tab for the file at that commit. Host smoke covers the merge, rebase and revert cases; UI smoke covers Blame incoming opening at `side`'s commit.

### Follow-ups

- **Keyboard access to the blame gutter.** The gutter and its menu are mouse-only, so Blame before this commit has no keyboard path (A's review).
- **Blame at a ref across a rename.** A ref typed in the blame tab for a file renamed since says the path is not in that ref rather than following the rename. Blame incoming from the conflict editor has the same limit when the incoming side renamed the file.
- **Mixed line endings in the conflict editor.** A file that mixes LF and CRLF is written back all CRLF, since CodeMirror normalises line breaks. A fix needs a per-line map (B's review).
- **Final newline when only one side lacks it** in the conflict editor, and non-UTF-8 text files, which are read and written as UTF-8 (B's review).
- **The worktree dialog's open state** (`GitWorktreeActions.dialogOpen`) is one app-wide signal, while the sidebar serves every workspace. A New worktree dialog left open stays up after a switch to another workspace and then works on that one. It should be kept per workspace, or closed on a switch.
- **A branch whose worktree is prunable** (its folder deleted by hand) still has the Branches tab's "in worktree" badge, Open worktree, and the checkout offer, all of which open a folder that no longer exists. The Worktrees section already disables Open and Reveal for such a row. The Branches tab should do the same and point at Prune.
- **Light-theme screenshots render editors dark.** The smoke toggles only the `dark` class, while CodeMirror follows `AppState.resolvedTheme`. On a machine whose system theme is dark, the "light" shots of the diff, blame and conflict editors are dark (`32b`, `32ba`, `32ca`). The smoke should set the app theme rather than the class.
- **The PR draft** reads the template from the working tree, not from the default branch the way GitHub does. It does not recognise setext headings, and it does not cap `files` in the result (only in the body). These were left by C's review.
- **A commit blamed under several paths** keeps its first `previous` (rare without `-C`/`-M`).
