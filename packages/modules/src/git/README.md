# Git

The workspace repository and its pull requests: status, branches, history and diffs through the git CLI, and pull requests with their checks through the GitHub CLI (`gh`), signed in as you, so Quiver stores no GitHub token. Under construction: the module is registered and empty; the plan is in [docs/plans/git-runner-queues.md](../../../../docs/plans/git-runner-queues.md).

<!-- lane:G1 -->
## Local repository

To be written by lane G1.
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
