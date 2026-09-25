import { selectScope, useAppStore } from '@quiver/ui';
import { create } from 'zustand';

/** Expanded tree nodes survive switching modules; keyed by workspace so each project keeps its own. */
export const useTreeStore = create<{ expanded: Record<string, boolean>; toggle(key: string): void; set(key: string, open: boolean): void }>((set, get) => ({
  expanded: {},
  toggle: (key) => set({ expanded: { ...get().expanded, [key]: !get().expanded[key] } }),
  set: (key, open) => set({ expanded: { ...get().expanded, [key]: open } }),
}));

export function useExpanded(key: string): [boolean, () => void] {
  const scope = useAppStore(selectScope);
  const full = `${scope}/${key}`;
  const open = useTreeStore((s) => Boolean(s.expanded[full]));
  const toggle = useTreeStore((s) => s.toggle);
  return [open, () => toggle(full)];
}

/** Expand a node from outside the sidebar, e.g. after Teleport created a connection. */
export function expandNode(key: string): void {
  const scope = selectScope(useAppStore.getState());
  useTreeStore.getState().set(`${scope}/${key}`, true);
}
