import { inject, untracked } from '@angular/core';
import { AppState, defineModuleUI } from '@quiver/ui';
import { GitBranch } from 'lucide';
import { GitDiffTab } from './diff-tab';
import { GitActions } from './git-actions';
import { GitSidebar } from './git-sidebar';
import { GitHistoryTab } from './history-tab';
import { GitPrTab } from './pr-tab';
import { GitPrsTab } from './prs-tab';

export const gitModuleUI = defineModuleUI({
  id: 'git',
  title: 'Git',
  icon: GitBranch,
  order: 35,
  availability: 'workspace',
  sidebar: GitSidebar,
  tabs: {
    'git.diff': GitDiffTab,
    'git.history': GitHistoryTab,
    'git.prs': GitPrsTab,
    'git.pr': GitPrTab,
  },
  actions: () => {
    const git = inject(GitActions);
    const app = inject(AppState);
    const hasWorkspace = () => untracked(app.hasWorkspace);
    return [
      { id: 'git.ui.switchBranch', title: 'Switch branch', group: 'Git', keywords: ['checkout', 'git'], run: () => git.switchBranch(), when: hasWorkspace },
      { id: 'git.ui.newBranch', title: 'New branch', group: 'Git', keywords: ['create', 'git'], run: () => git.newBranch(), when: hasWorkspace },
      { id: 'git.ui.commit', title: 'Commit staged changes', group: 'Git', keywords: ['git', 'commit'], run: () => git.commitFromPalette(), when: hasWorkspace },
      { id: 'git.ui.history', title: 'Git history', group: 'Git', keywords: ['log', 'commits'], run: () => git.openHistory(), when: hasWorkspace },
      { id: 'git.ui.prs', title: 'Open pull requests', group: 'Git', keywords: ['github', 'pr', 'gh'], run: () => git.openPullRequests(), when: hasWorkspace },
      { id: 'git.ui.prsReview', title: 'Pull requests waiting on my review', group: 'Git', keywords: ['github', 'pr', 'review'], run: () => git.openPullRequests({ filter: 'review-requested', view: 'list' }), when: hasWorkspace },
      { id: 'git.ui.prNew', title: 'New pull request', group: 'Git', keywords: ['github', 'pr', 'create'], run: () => git.openPullRequests({ view: 'new' }), when: hasWorkspace },
    ];
  },
});
