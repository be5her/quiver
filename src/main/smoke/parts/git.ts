import { definePart, runSections } from '../part';
import blame from './git/blame';
import conflict from './git/conflict';
import draft from './git/draft';
import local from './git/local';
import manage from './git/manage';
import pr from './git/pr';
import tree from './git/tree';
import ui from './git/ui';
import worktrees from './git/worktrees';

export default definePart({
  name: 'git',
  summary: 'Git: local repository, branch management, pull requests through gh and their drafts, blame, the conflict editor, worktrees and changed files as a tree',
  run: (t) => runSections(t, [local, manage, pr, ui, blame, conflict, draft, worktrees, tree]),
});
