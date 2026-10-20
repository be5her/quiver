# Git

The workspace repository and its pull requests: status, branches, history and diffs through the git CLI, and pull requests with their checks through the GitHub CLI (`gh`), signed in as you, so Quiver stores no GitHub token. Under construction: the module is registered and empty; the plan is in [docs/plans/git-runner-queues.md](../../../../docs/plans/git-runner-queues.md).

<!-- lane:G1 -->
## Local repository

The workspace folder's repository, through the `git` CLI found on PATH ([`local.ts`](local.ts), commands in [`commands-local.ts`](commands-local.ts)). Every call is its own git process run in the workspace folder with stdin closed, `GIT_TERMINAL_PROMPT=0` and no optional locks, so nothing waits on a prompt and a status never fights a git running in your terminal. Git is asked for NUL-separated output (`status --porcelain=v2 --branch -z`, `log` with `%x00` fields, `diff --raw --numstat -z`), parsed by `packages/core/src/git-parse.ts`, so paths with spaces or quotes come through intact. Nothing is stored: git is the only state.

| Command | What it gives or does |
| --- | --- |
| `git.status` | Branch (null when detached), HEAD (null before the first commit), upstream with ahead/behind, the operation in progress (merge, rebase, cherry-pick, revert) and the changed files with their index and worktree codes (`.` unchanged, `?` untracked). |
| `git.branch.list` | Local and remote-tracking branches, newest first, with upstream, ahead/behind, head commit, subject and date. |
| `git.log` | `{ commits, hasMore }`, newest first, of HEAD or `ref`, optionally only commits touching `path`; paged with `limit` and `skip`. |
| `git.diff` | Per-file status, line counts and unified patch: working tree against the index by default, `staged` for the index against HEAD, `from` for the working tree (or index) against a ref, `from` and `to` between two refs. `statOnly` leaves the patches out; a patch over 512 KB, or past the 32 MB output cap, is left out and the file marked `truncated`. |
| `git.show` | `{ commit, files }`: one commit and its changes against its first parent (a root commit against the empty tree). |
| `git.fetch` | `git fetch --prune` of the default remote or `remote`; only remote-tracking refs change. |
| `git.checkout` | Switches to a branch, tag or commit; fails rather than overwrite local changes. |
| `git.branch.create` | A branch at HEAD or `from`, switched to unless `checkout: false`. |
| `git.stage`, `git.unstage` | `git add --all` / `git restore --staged` of paths (`git rm --cached` before the first commit). |
| `git.commit` | Commits the index with the message (passed on stdin), `amend` to replace the last commit; hooks run. Gives back the new commit. |
| `git.pull` | `git pull --no-edit` of the upstream or `remote` and `branch`, per the repository's own pull settings. |
| `git.push` | Pushes the current branch, or `remote` and `branch`; `setUpstream` (origin and the current branch by default), `forceWithLease`. |

The mutating commands and fetch give back the new status (pull and push with git's output as well), and emit `git.changed` straight away. A watcher on `.git/HEAD`, `.git/index` and `refs` (and `packed-refs`, in the common dir for a linked worktree) emits `git.changed` too, debounced by 250 ms, so a commit or checkout made in a terminal reaches the view: `status` when HEAD or the index moved, `branches` when HEAD or a ref did. Edits to working files are not watched. The watcher starts when the workspace opens, or with the first git command once the folder has become a repository, and stops when it closes.

Refs, branch names, remotes and paths are refused when they start with `-` (`GitArgSchema`), and paths always follow `--`, so no input can become a git option such as `--output=<file>`. `remote`, for fetch, pull and push, must be one of the repository's configured remotes: git itself also takes a URL or a folder there, which would let an agent's read-only fetch pull any repository the user's credentials or disk can reach into `FETCH_HEAD`. When git is not on PATH the commands fail with `NOT_FOUND` and `details.reason: 'no-git'`; in a folder that is not a repository with `NOT_FOUND` and `details.reason: 'not-a-repo'`; a git failure is `REQUEST_FAILED` with git's own message.

Agents may call `git.status`, `git.branch.list`, `git.log`, `git.diff`, `git.show` and `git.fetch`. `git.checkout`, `git.branch.create`, `git.stage`, `git.unstage`, `git.commit`, `git.pull` and `git.push` are mutating and refused until mutations are enabled.

The smoke section [`parts/git/local.ts`](../../../../src/main/smoke/parts/git/local.ts) builds a repository in a temporary folder and checks the not-a-repository error, status before and after the first commit, staging and unstaging, a commit and a commit with nothing staged, working, staged and between-refs diffs, `statOnly`, branch create and checkout (files switch too), branch list, show (also of the root commit), log paging and by path, the watcher's `git.changed` after a checkout in a terminal, an option-like ref refused, a URL or folder refused as a remote while a configured remote is fetched, and agents reading status and diffs while commit, checkout, stage and push are gated.
<!-- /lane:G1 -->

<!-- lane:G2 -->
## Pull requests

To be written by lane G2.
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
