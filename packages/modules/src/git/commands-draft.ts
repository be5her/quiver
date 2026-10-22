import { GitPrDraftInputSchema, QuiverError, defineCommand, type CommandDefinition, type GitPrDraft } from '@quiver/core';
import { draft } from './draft';

// A pull request description drafted from git alone. A read: open to agents, which can write prose on top of it.

const prDraft = defineCommand({
  id: 'git.pr.draft',
  title: 'Draft pull request description',
  description:
    "A title, description and labels for a pull request from the current branch, made from git alone: it works before the branch is pushed and without gh. base defaults to the default branch of the remote (origin/<default>), else a local main or master. Gives back head, base (as the pull request names it), baseRef, mergeBase, title (a single commit's subject, else the branch name made readable), body (the repository's pull request template with its what-changed and files sections filled, or Summary and Changes), commits (oldest first, merges left out), files with +/-, stats, template, labels (from the branch prefix, only those gh lists for the repository) and, with includePatch, the base...HEAD diff cut at 200 KB. Nothing is written; use it as the starting point for git.pr.create.",
  scope: 'workspace',
  input: GitPrDraftInputSchema,
  handler: async (input, ctx): Promise<GitPrDraft> => {
    if (!ctx.workspace) throw new QuiverError('NO_WORKSPACE', 'Open a workspace first');
    return draft(ctx.workspace.path, input);
  },
});

export const draftCommands: CommandDefinition[] = [prDraft];
