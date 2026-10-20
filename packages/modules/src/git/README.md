# Git

The workspace repository and its pull requests: status, branches, history and diffs through the git CLI, and pull requests with their checks through the GitHub CLI (`gh`), signed in as you, so Quiver stores no GitHub token. Under construction: the module is registered and empty; the plan is in [docs/plans/git-runner-queues.md](../../../../docs/plans/git-runner-queues.md).

<!-- lane:G1 -->
## Local repository

The workspace folder's repository, through the `git` CLI found on PATH ([`local.ts`](local.ts), commands in [`commands-local.ts`](commands-local.ts)). Every call is its own git process run in the repository's root folder with stdin closed, `GIT_TERMINAL_PROMPT=0` and no optional locks, so nothing waits on a prompt and a status never fights a git running in your terminal. Running at the root (`rev-parse --show-toplevel`) is what makes paths mean one thing everywhere: `status` and `diff` print them relative to the root whatever the folder, so `stage`, `unstage`, `diff` and `log` take them that way too, also when the workspace is a subfolder of the repository. Git is asked for NUL-separated output (`status --porcelain=v2 --branch -z`, `log` with `%x00` fields, `diff --raw --numstat -z`), parsed by `packages/core/src/git-parse.ts`, so paths with spaces or quotes come through intact. Nothing is stored: git is the only state.

| Command | What it gives or does |
| --- | --- |
| `git.status` | Branch (null when detached), HEAD (null before the first commit), upstream with ahead/behind, the operation in progress (merge, rebase, cherry-pick, revert) and the changed files with their index and worktree codes (`.` unchanged, `?` untracked). An untracked folder is one entry (`new/`), as git itself lists it, rather than every file in it. |
| `git.branch.list` | Local and remote-tracking branches, newest first, with upstream, ahead/behind, head commit, subject and date. |
| `git.log` | `{ commits, hasMore }`, newest first, of HEAD or `ref`, optionally only commits touching `path`; paged with `limit` and `skip`. |
| `git.diff` | Per-file status, line counts and unified patch: working tree against the index by default, `staged` for the index against HEAD, `from` for the working tree (or index) against a ref, `from` and `to` between two refs. `statOnly` leaves the patches out; a patch over 512 KB, or past the 32 MB output cap, is left out and the file marked `truncated`. |
| `git.show` | `{ commit, files }`: one commit and its changes against its first parent (a root commit against the empty tree). |
| `git.fetch` | `git fetch --prune` of the default remote or `remote`; only remote-tracking refs change. |
| `git.checkout` | Switches to a branch, tag or commit; fails rather than overwrite local changes. |
| `git.branch.create` | A branch at HEAD or `from`, switched to unless `checkout: false`. |
| `git.stage`, `git.unstage` | `git add --all` / `git restore --staged` of paths (`git rm --cached` before the first commit). |
| `git.commit` | Commits the index with the message (passed on stdin, trimmed like an editor would but with `#` lines kept), `amend` to replace the last commit; hooks run. Gives back the new commit. |
| `git.pull` | `git pull --no-edit` of the upstream or `remote` and `branch`, per the repository's own pull settings. |
| `git.push` | Pushes the current branch, or `remote` and `branch`; `setUpstream` (origin and the current branch by default), `forceWithLease`. `branch` is a name, never a refspec: `:main`, `+x:main`, `main:other` and patterns are refused, so nothing is deleted or forced through it. |

The mutating commands and fetch give back the new status (pull and push with git's output as well), and emit `git.changed` straight away. A watcher on `.git/HEAD`, `.git/index` and `refs` (and `packed-refs`, in the common dir for a linked worktree) emits `git.changed` too, debounced by 250 ms, so a commit or checkout made in a terminal reaches the view: `status` when HEAD or the index moved, `branches` when HEAD or a ref did. Edits to working files are not watched. The watcher starts when the workspace opens, or with the first git command once the folder has become a repository, and stops when it closes.

Refs, branch names, remotes and paths are refused when they start with `-` (`GitArgSchema`), and paths always follow `--`, so no input can become a git option such as `--output=<file>`. `remote`, for fetch, pull and push, must be one of the repository's configured remotes: git itself also takes a URL or a folder there, which would let an agent's read-only fetch pull any repository the user's credentials or disk can reach into `FETCH_HEAD`. For fetch, pull and push made by an agent, `GCM_INTERACTIVE=never` keeps Git Credential Manager from opening a sign-in window the agent cannot see (the call fails instead); from the UI the window still opens, which is how a first sign-in happens. When git is not on PATH the commands fail with `NOT_FOUND` and `details.reason: 'no-git'`; in a folder that is not a repository with `NOT_FOUND` and `details.reason: 'not-a-repo'`; a git failure is `REQUEST_FAILED` with git's own message.

Agents may call `git.status`, `git.branch.list`, `git.log`, `git.diff`, `git.show` and `git.fetch`. `git.checkout`, `git.branch.create`, `git.stage`, `git.unstage`, `git.commit`, `git.pull` and `git.push` are mutating and refused until mutations are enabled.

The smoke section [`parts/git/local.ts`](../../../../src/main/smoke/parts/git/local.ts) builds a repository in a temporary folder and checks the not-a-repository error, status before and after the first commit, staging and unstaging, a commit and a commit with nothing staged, working, staged and between-refs diffs, `statOnly`, branch create and checkout (files switch too), branch list, show (also of the root commit), log paging and by path, the watcher's `git.changed` after a checkout in a terminal, an option-like ref refused, a commit message keeping its `#` lines, a log of a ref that is also a file name, an untracked folder listed once, a workspace in a subfolder of the repository seeing and taking repository-relative paths, a URL or folder refused as a remote while a configured remote is fetched, a refspec refused as the branch of push and pull, and agents reading status and diffs while commit, checkout, stage and push are gated.
<!-- /lane:G1 -->

<!-- lane:G2 -->
## Pull requests

Pull requests of the workspace's GitHub repository, through the GitHub CLI ([`pr.ts`](pr.ts), commands in [`commands-pr.ts`](commands-pr.ts)). gh runs signed in as you, with your own `gh auth login`, so Quiver never sees or stores a GitHub token. Every call is its own gh process run in the repository root with stdin closed (or holding a body), prompts and update notices off (`GH_PROMPT_DISABLED`, `GH_NO_UPDATE_NOTIFIER`), and asks for `--json`, which `packages/core/src/gh-parse.ts` reads. gh is found on PATH, then in `C:\Program Files\GitHub CLI` on Windows; `QUIVER_GH_PATH` overrides it with a path or a quoted command line, which is how the smoke points it at its fake. Nothing is stored.

The repository is picked from the configured remotes the way gh picks it (the one `gh repo set-default` marked, then `upstream`, `github`, `origin`, then the first) and handed to every call as `--repo`, so gh never guesses and no input can point it at another repository. Remotes on github.com count, plus a GitHub Enterprise host gh is signed in to (or `GH_HOST`).

| Command | What it gives or does |
| --- | --- |
| `git.pr.status` | `{ installed, authenticated, user, repo, message }`: whether gh is installed, signed in (the active account) and the workspace is a GitHub repository, with what to do next when something is missing. Never fails for a missing piece. |
| `git.pr.list` | Pull requests, newest first: `filter` mine (`--author @me`), review-requested (`review-requested:@me`) or all; `state` open, closed, merged or all; `limit` up to 100. Each has its review decision, labels and a roll-up of the head commit's checks (`failure` when any failed, else `pending` when any runs, else `success`; cancelled and timed-out count as failed, as GitHub counts them). |
| `git.pr.get` | One pull request with its body, line counts, files, reviews and comments. |
| `git.pr.checks` | The checks on the head commit (gh's exit codes 1 and 8 for failed and pending checks are read as such, not as errors). `failedLogs` adds, for up to 5 failed Actions jobs, the last 60 lines of `gh run view --job <id> --log-failed` without timestamps or colours, under `## <step>` headings, or `logError` saying why there is none. |
| `git.pr.diff` | The pull request's changes as `git.diff` gives them, read from `gh pr diff`: status, line counts and patch per file, a patch over 512 KB left out and marked `truncated`. |
| `git.pr.open` | `gh pr view --web`: the page opens in your browser. |
| `git.pr.checkout` | `gh pr checkout`: fetches the branch (from a fork too) and switches to it; gives back the new `git.status`. |
| `git.pr.create` | A pull request from the current branch, which must be pushed: its upstream says where the head is, so a branch pushed to a fork goes as `owner:branch`. `base`, `draft`, `labels`. The title and labels are passed as `--flag=value` and the body on stdin, so none of them can be read as an option. |
| `git.pr.comment` | Adds a comment to the conversation; the body goes on stdin. Gives back the comment's address. |

When gh is not installed the commands fail with `NOT_FOUND` and `details.reason: 'no-gh'`; when it is signed out with `AUTH_REQUIRED` and `details.reason: 'gh-signed-out'`; in a repository with no GitHub remote with `NOT_FOUND` and `details.reason: 'not-github'` (and `not-a-repo` outside a repository, as the local commands); any other gh failure is `REQUEST_FAILED` with gh's own message.

Polling is driven by the view, so nothing runs while no view is open: while the pull requests are on screen it calls the hidden `git.pr.refresh` every 60 seconds (`force` for a refresh button). The host then asks gh for a fingerprint of the open pull requests (number, last update and check states, since a finished check run does not change `updatedAt`), at most every 30 seconds per workspace however many views ask, and emits `git.changed` with reason `prs` when it differs from the last one; every view reloads on that event. Create and comment emit it straight away; checkout emits `status` and `branches`.

Agents may call `git.pr.status`, `git.pr.list`, `git.pr.get`, `git.pr.checks`, `git.pr.diff` and `git.pr.open`. `git.pr.checkout`, `git.pr.create` and `git.pr.comment` are mutating and refused until mutations are enabled. `git.pr.refresh` is plumbing and not listed. A checkout made by an agent runs with `GCM_INTERACTIVE=never`, as the local fetch, pull and push do.

The smoke section [`parts/git/pr.ts`](../../../../src/main/smoke/parts/git/pr.ts) runs against [`fake-gh.ts`](../../../../src/main/smoke/fake-gh.ts), a Node script that answers from a state file, exits like gh and refuses any repository but its own; the section writes it to a temporary folder and removes it, and restores `QUIVER_GH_PATH`, in its `after` hook. It checks the status and errors with gh missing, signed out and in a repository whose only remote is not on GitHub, the list with its filters and roll-up, a pull request's detail and a missing one, checks of a failing (with the failed log's excerpt, and a non-Actions check's `logError`), a pending and a checkless pull request, the diff, open, the refresh announcing a finished check run once and honouring its limit, create refusing an unpushed branch and an option-like label and then creating from a fork branch with the title and body kept literal, comment, checkout switching the branch with its events, every call carrying `--repo` and running in the repository root, and agents reading lists and checks while create, comment and checkout are gated and never reach gh.
<!-- /lane:G2 -->

<!-- lane:GU -->
## The panel

To be written by lane GU.
<!-- /lane:GU -->

<!-- lane:agents -->
## Agents

Reads (status, log, diff, pull request lists and checks) are allowed. Stage, commit, checkout, branch, pull, push, and creating or commenting on pull requests are gated as mutating.
<!-- /lane:agents -->

## Verified by

The smoke part is split per lane: [`src/main/smoke/parts/git/`](../../../../src/main/smoke/parts/git); `npm run smoke -- git` runs it.
