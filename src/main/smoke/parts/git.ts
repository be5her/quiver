import { definePart, runSections } from '../part';
import conflict from './git/conflict';
import local from './git/local';
import manage from './git/manage';
import pr from './git/pr';
import ui from './git/ui';

export default definePart({
  name: 'git',
  summary: 'Git: local repository, branch management, pull requests through gh and the conflict editor',
  run: (t) => runSections(t, [local, manage, pr, ui, conflict]),
});
