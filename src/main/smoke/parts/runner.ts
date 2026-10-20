import { definePart, runSections } from '../part';
import tasks from './runner/tasks';
import proc from './runner/proc';
import ui from './runner/ui';

export default definePart({
  name: 'runner',
  summary: 'Process runner: tasks, processes, output',
  run: (t) => runSections(t, [tasks, proc, ui]),
});
