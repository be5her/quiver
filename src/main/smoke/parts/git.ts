import { definePart, runSections } from '../part';
import local from './git/local';
import pr from './git/pr';
import ui from './git/ui';

export default definePart({
  name: 'git',
  summary: 'Git: local repository and pull requests through gh',
  run: (t) => runSections(t, [local, pr, ui]),
});
