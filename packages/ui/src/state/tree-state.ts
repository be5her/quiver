import { Service, inject, signal, untracked } from '@angular/core';
import { AppState } from './app-state';

interface TreeScope {
  expanded: Record<string, boolean>;
  hydrated?: boolean;
}

/**
 * Which sidebar nodes and sections are open, per workspace. Kept here so it survives switching
 * modules, and persisted per machine by the shell so it survives restarts too. Only nodes the user
 * toggled are stored; the rest fall back to the default each caller gives.
 */
@Service()
export class TreeState {
  private readonly app = inject(AppState);
  private readonly state = signal<Record<string, TreeScope>>({});

  readonly scopes = this.state.asReadonly();

  set(scope: string, key: string, open: boolean): void {
    this.state.update((scopes) => ({ ...scopes, [scope]: { ...scopes[scope], expanded: { ...scopes[scope]?.expanded, [key]: open } } }));
  }

  /** Toggles made before the saved state arrived win over it. */
  hydrate(scope: string, expanded: Record<string, boolean>): void {
    this.state.update((scopes) => ({ ...scopes, [scope]: { expanded: { ...expanded, ...scopes[scope]?.expanded }, hydrated: true } }));
  }

  /** Open state of a sidebar node or section in the current workspace, `defaultOpen` until the user toggles it. Reactive. */
  isExpanded(key: string, defaultOpen = false): boolean {
    return this.state()[this.app.scope()]?.expanded[key] ?? defaultOpen;
  }

  toggle(key: string, defaultOpen = false): void {
    this.set(untracked(this.app.scope), key, !untracked(() => this.isExpanded(key, defaultOpen)));
  }

  /** Expand a node from outside the sidebar, e.g. after Teleport created a connection. */
  expand(key: string): void {
    this.set(untracked(this.app.scope), key, true);
  }
}
