# Process runner

The project's long-running commands in one place: tasks discovered from `package.json`, Makefiles, justfiles and compose files or saved with the project, started and stopped as whole process trees, with their output, a ready state and their port. Under construction: the module is registered and empty; the plan is in [docs/plans/git-runner-queues.md](../../../../docs/plans/git-runner-queues.md).

<!-- lane:R1 -->
## Tasks

To be written by lane R1.
<!-- /lane:R1 -->

<!-- lane:R2 -->
## Processes

To be written by lane R2.
<!-- /lane:R2 -->

<!-- lane:RU -->
## The panel

To be written by lane RU.
<!-- /lane:RU -->

<!-- lane:agents -->
## Agents

Listing tasks and reading output are allowed. Saving or deleting tasks, and starting, stopping, restarting or writing to a process, are gated as mutating.
<!-- /lane:agents -->

## Verified by

The smoke part is split per lane: [`src/main/smoke/parts/runner/`](../../../../src/main/smoke/parts/runner); `npm run smoke -- runner` runs it.
