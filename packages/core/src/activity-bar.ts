import { moveItem } from './arrays';

/** How the user arranged the activity bar: module ids in their order, and the hidden ones. */
export interface ActivityBarLayout {
  order: string[];
  hidden: string[];
}

export function defaultActivityBarLayout(): ActivityBarLayout {
  return { order: [], hidden: [] };
}

/**
 * Apply a layout to the modules that exist. `all` is every module in the user's order: the ones
 * the layout names first, then any it does not know (new modules) in their default order.
 * `visible` is `all` without the hidden ones. Unknown ids in the layout are ignored.
 */
export function arrangeActivityBar(ids: readonly string[], layout: ActivityBarLayout): { all: string[]; visible: string[]; hidden: string[] } {
  const known = new Set(ids);
  const ordered = layout.order.filter((id, i) => known.has(id) && layout.order.indexOf(id) === i);
  const all = [...ordered, ...ids.filter((id) => !ordered.includes(id))];
  const hiddenSet = new Set(layout.hidden.filter((id) => known.has(id)));
  // Never hide everything: the bar would be left with no way back but the reset.
  if (hiddenSet.size >= all.length) hiddenSet.clear();
  const visible = all.filter((id) => !hiddenSet.has(id));
  return { all, visible, hidden: all.filter((id) => hiddenSet.has(id)) };
}

/**
 * Move a visible module to index `to` among the visible ones. Hidden modules keep their places
 * in the full order, so one shown again comes back where it was.
 */
export function moveInActivityBar(ids: readonly string[], layout: ActivityBarLayout, id: string, to: number): ActivityBarLayout {
  const { all, visible, hidden } = arrangeActivityBar(ids, layout);
  const from = visible.indexOf(id);
  if (from < 0) return { order: all, hidden };
  const moved = moveItem(visible, from, to);
  let next = 0;
  return { order: all.map((m) => (hidden.includes(m) ? m : moved[next++])), hidden };
}

/** Show or hide one module. Hiding the last visible module is refused (returns the layout as is). */
export function toggleInActivityBar(ids: readonly string[], layout: ActivityBarLayout, id: string, show: boolean): ActivityBarLayout {
  const { all, visible, hidden } = arrangeActivityBar(ids, layout);
  if (!all.includes(id)) return layout;
  if (show) return { order: all, hidden: hidden.filter((h) => h !== id) };
  if (hidden.includes(id) || (visible.length === 1 && visible[0] === id)) return { order: all, hidden };
  return { order: all, hidden: [...hidden, id] };
}
