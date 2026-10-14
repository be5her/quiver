import { Service, signal, untracked } from '@angular/core';

/** A UI-side entry for the command palette. Host commands are listed separately, from the registry. */
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

/** The palette's own entries: shell actions plus what each module registers. */
@Service()
export class UiActions {
  private readonly list = signal<UIAction[]>([]);

  readonly actions = this.list.asReadonly();

  /** Add actions, replacing any with the same id; returns the function that removes them again. */
  register(incoming: UIAction[]): () => void {
    const ids = new Set(incoming.map((a) => a.id));
    this.list.update((actions) => [...actions.filter((a) => !ids.has(a.id)), ...incoming]);
    return () => this.list.update((actions) => actions.filter((a) => !ids.has(a.id)));
  }

  find(id: string): UIAction | undefined {
    return untracked(this.list).find((a) => a.id === id);
  }

  /** Run an action by id when it applies right now. */
  run(id: string): void {
    const action = this.find(id);
    if (action && (!action.when || action.when())) void action.run();
  }
}
