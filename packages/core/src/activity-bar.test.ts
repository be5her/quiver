import { describe, expect, it } from 'vitest';
import { arrangeActivityBar, defaultActivityBarLayout, moveInActivityBar, toggleInActivityBar } from './activity-bar';

const ids = ['api', 'realtime', 'db', 'teleport', 'tools'];

describe('arrangeActivityBar', () => {
  it('keeps the default order without a layout', () => {
    expect(arrangeActivityBar(ids, defaultActivityBarLayout())).toEqual({ all: ids, visible: ids, hidden: [] });
  });

  it('follows the saved order, appends modules it does not know and ignores stale ids', () => {
    const arranged = arrangeActivityBar(ids, { order: ['db', 'gone', 'api', 'db'], hidden: ['teleport', 'gone'] });
    expect(arranged.all).toEqual(['db', 'api', 'realtime', 'teleport', 'tools']);
    expect(arranged.visible).toEqual(['db', 'api', 'realtime', 'tools']);
    expect(arranged.hidden).toEqual(['teleport']);
  });

  it('never hides everything', () => {
    expect(arrangeActivityBar(['api', 'db'], { order: [], hidden: ['api', 'db'] }).visible).toEqual(['api', 'db']);
  });
});

describe('moveInActivityBar', () => {
  it('moves among the visible modules and leaves hidden ones in place', () => {
    const layout = { order: [], hidden: ['realtime'] };
    const next = moveInActivityBar(ids, layout, 'api', 2);
    expect(next.hidden).toEqual(['realtime']);
    expect(arrangeActivityBar(ids, next).visible).toEqual(['db', 'teleport', 'api', 'tools']);
    expect(next.order).toEqual(['db', 'realtime', 'teleport', 'api', 'tools']);
    expect(arrangeActivityBar(ids, toggleInActivityBar(ids, next, 'realtime', true)).visible).toEqual(['db', 'realtime', 'teleport', 'api', 'tools']);
  });
});

describe('toggleInActivityBar', () => {
  it('hides and shows a module', () => {
    const hidden = toggleInActivityBar(ids, defaultActivityBarLayout(), 'db', false);
    expect(arrangeActivityBar(ids, hidden).visible).toEqual(['api', 'realtime', 'teleport', 'tools']);
    expect(arrangeActivityBar(ids, toggleInActivityBar(ids, hidden, 'db', true)).visible).toEqual(ids);
  });

  it('refuses to hide the last visible module', () => {
    const one = { order: [], hidden: ['realtime', 'db', 'teleport', 'tools'] };
    expect(toggleInActivityBar(ids, one, 'api', false).hidden).toEqual(['realtime', 'db', 'teleport', 'tools']);
  });
});
