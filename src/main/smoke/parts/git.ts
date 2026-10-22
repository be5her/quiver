import { definePart, runSections } from '../part';
import local from './git/local';
import manage from './git/manage';
import pr from './git/pr';
import ui from './git/ui';

export default definePart({
  name: 'git',
  summary: 'Git: local repository, branch management and pull requests through gh',
  run: (t) => runSections(t, [local, manage, pr, ui]),
});
