import { inject, untracked } from '@angular/core';
import { AppState, defineModuleUI } from '@quiver/ui';
import { GitBranch } from 'lucide';
import { GitBlameTab } from './blame-tab';
import { GitBranchesTab } from './branches-tab';
import { GitConflictTab } from './conflict-tab';
import { GitDiffTab } from './diff-tab';
import { GitActions } from './git-actions';
import { GitSidebar } from './git-sidebar';
import { GitStatusItem } from './git-status-item';
import { GitHistoryTab } from './history-tab';
import { GitPrTab } from './pr-tab';
import { GitPrsTab } from './prs-tab';
import { GitWorktreeActions } from './worktree-actions';

export const gitModuleUI = defineModuleUI({
  id: 'git',
  title: 'Git',
  icon: GitBranch,
  order: 35,
  availability: 'workspace',
  sidebar: GitSidebar,
  statusItems: [GitStatusItem],
  tabs: {
    'git.diff': GitDiffTab,
    'git.history': GitHistoryTab,
    'git.branches': GitBranchesTab,
    'git.prs': GitPrsTab,
    'git.pr': GitPrTab,
    'git.blame': GitBlameTab,
    'git.conflict': GitConflictTab,
  },
  actions: () => {
    const git = inject(GitActions);
    const worktrees = inject(GitWorktreeActions);
    const app = inject(AppState);
    const hasWorkspace = () => untracked(app.hasWorkspace);
    return [
      { id: 'git.ui.switchBranch', title: 'Switch branch', group: 'Git', keywords: ['checkout', 'git'], run: () => git.switchBranch(), when: hasWorkspace },
      { id: 'git.ui.newBranch', title: 'New branch', group: 'Git', keywords: ['create', 'git'], run: () => git.newBranch(), when: hasWorkspace },
      { id: 'git.ui.commit', title: 'Commit staged changes', group: 'Git', keywords: ['git', 'commit'], run: () => git.commitFromPalette(), when: hasWorkspace },
      { id: 'git.ui.history', title: 'Git history', group: 'Git', keywords: ['log', 'commits'], run: () => git.openHistory(), when: hasWorkspace },
      { id: 'git.ui.branches', title: 'Branches', group: 'Git', keywords: ['git', 'tags', 'clean up', 'delete'], run: () => git.openBranches(), when: hasWorkspace },
      { id: 'git.ui.stash', title: 'Stash changes', group: 'Git', keywords: ['git', 'stash', 'shelve'], run: () => git.stashChanges(), when: hasWorkspace },
      { id: 'git.ui.merge', title: 'Merge branch into current', group: 'Git', keywords: ['git', 'merge'], run: () => git.mergeOrRebaseFromPalette('merge'), when: hasWorkspace },
      { id: 'git.ui.rebase', title: 'Rebase onto', group: 'Git', keywords: ['git', 'rebase'], run: () => git.mergeOrRebaseFromPalette('rebase'), when: hasWorkspace },
      // The same ids as the host commands, which they wrap with the banner's questions.
      { id: 'git.operation.continue', title: 'Continue merge or rebase', group: 'Git', keywords: ['git', 'cherry-pick', 'revert'], run: () => git.operationFromPalette('continue'), when: hasWorkspace },
      { id: 'git.operation.skip', title: 'Skip commit in rebase', group: 'Git', keywords: ['git', 'cherry-pick', 'revert'], run: () => git.operationFromPalette('skip'), when: hasWorkspace },
      { id: 'git.operation.abort', title: 'Abort merge or rebase', group: 'Git', keywords: ['git', 'cherry-pick', 'revert'], run: () => git.operationFromPalette('abort'), when: hasWorkspace },
      { id: 'git.ui.deleteBranch', title: 'Delete branch', group: 'Git', keywords: ['git', 'remove', 'branch'], run: () => git.deleteBranchFromPalette(), when: hasWorkspace },
      { id: 'git.ui.prs', title: 'Open pull requests', group: 'Git', keywords: ['github', 'pr', 'gh'], run: () => git.openPullRequests(), when: hasWorkspace },
      { id: 'git.ui.prsReview', title: 'Pull requests waiting on my review', group: 'Git', keywords: ['github', 'pr', 'review'], run: () => git.openPullRequests({ filter: 'review-requested', view: 'list' }), when: hasWorkspace },
      { id: 'git.ui.prNew', title: 'New pull request', group: 'Git', keywords: ['github', 'pr', 'create'], run: () => git.openPullRequests({ view: 'new' }), when: hasWorkspace },
      { id: 'git.ui.blame', title: 'Blame file', group: 'Git', keywords: ['git', 'blame', 'annotate', 'who changed'], run: () => git.blameFromPalette(), when: hasWorkspace },
      { id: 'git.ui.newWorktree', title: 'New worktree', group: 'Git', keywords: ['git', 'worktree', 'branch', 'folder'], run: () => void worktrees.newWorktree(), when: hasWorkspace },
    ];
  },
});
