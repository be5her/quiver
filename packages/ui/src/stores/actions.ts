import { create } from 'zustand';

/** A UI-side entry for the command palette. Backend commands are listed separately from the registry. */
export interface UIAction {
  id: string;
  title: string;
  group: string;
  description?: string;
  keywords?: string[];
  /** Display only, e.g. "Ctrl+N". Bindings are wired by the shell. */
  shortcut?: string;
  run(): void | Promise<void>;
  /** Hide the action when it does not apply, e.g. no workspace open. */
  when?(): boolean;
}

interface ActionsState {
  actions: UIAction[];
  register(actions: UIAction[]): () => void;
}

export const useActionsStore = create<ActionsState>((set, get) => ({
  actions: [],
  register: (incoming) => {
    const ids = new Set(incoming.map((a) => a.id));
    set({ actions: [...get().actions.filter((a) => !ids.has(a.id)), ...incoming] });
    return () => set({ actions: get().actions.filter((a) => !ids.has(a.id)) });
  },
}));

export function registerActions(actions: UIAction[]): () => void {
  return useActionsStore.getState().register(actions);
}

export function runAction(id: string): void {
  const action = useActionsStore.getState().actions.find((a) => a.id === id);
  if (action && (!action.when || action.when())) void action.run();
}
