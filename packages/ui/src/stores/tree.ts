import { create } from 'zustand';
import { selectScope, useAppStore } from './app';

/**
 * Which sidebar nodes and sections are open, per workspace. Kept here so it survives
 * switching modules, and persisted per machine by the shell so it survives restarts too.
 * Only nodes the user toggled are stored; the rest fall back to the default each caller gives.
 */
interface TreeState {
  scopes: Record<string, { expanded: Record<string, boolean>; hydrated?: boolean }>;
  set(scope: string, key: string, open: boolean): void;
  hydrate(scope: string, expanded: Record<string, boolean>): void;
}

export const useTreeStore = create<TreeState>((set, get) => ({
  scopes: {},
  set: (scope, key, open) => {
    const current = get().scopes[scope];
    set({ scopes: { ...get().scopes, [scope]: { ...current, expanded: { ...current?.expanded, [key]: open } } } });
  },
  // Toggles made before the saved state arrived win over it.
  hydrate: (scope, expanded) => {
    const current = get().scopes[scope];
    set({ scopes: { ...get().scopes, [scope]: { expanded: { ...expanded, ...current?.expanded }, hydrated: true } } });
  },
}));

/** Open state of a sidebar node or section, `defaultOpen` until the user toggles it. */
export function useExpanded(key: string, defaultOpen = false): [boolean, () => void] {
  const scope = useAppStore(selectScope);
  const stored = useTreeStore((s) => s.scopes[scope]?.expanded[key]);
  const open = stored ?? defaultOpen;
  return [open, () => useTreeStore.getState().set(scope, key, !open)];
}

/** Expand a node from outside the sidebar, e.g. after Teleport created a connection. */
export function expandNode(key: string): void {
  useTreeStore.getState().set(selectScope(useAppStore.getState()), key, true);
}
