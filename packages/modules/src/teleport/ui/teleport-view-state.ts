import { DestroyRef, Service, inject, signal, untracked, type Signal } from '@angular/core';
import type { TeleportDatabase, TeleportKubeCluster } from '@quiver/core';

/**
 * What the Teleport sidebar keeps across switching modules: which clusters are collapsed, and the
 * resource lists the cluster sections loaded, so the Pinned section can show protocol and state.
 */
@Service()
export class TeleportViewState {
  private readonly collapsedState = signal<Record<string, boolean>>({});
  private readonly dbState = signal<Record<string, TeleportDatabase[]>>({});
  private readonly kubeState = signal<Record<string, TeleportKubeCluster[]>>({});

  readonly collapsed = this.collapsedState.asReadonly();
  readonly dbs = this.dbState.asReadonly();
  readonly kubes = this.kubeState.asReadonly();

  toggle(proxy: string): void {
    this.collapsedState.update((collapsed) => ({ ...collapsed, [proxy]: !collapsed[proxy] }));
  }

  setDbs(proxy: string, dbs: TeleportDatabase[]): void {
    if (untracked(this.dbState)[proxy] !== dbs) this.dbState.update((all) => ({ ...all, [proxy]: dbs }));
  }

  setKubes(proxy: string, kubes: TeleportKubeCluster[]): void {
    if (untracked(this.kubeState)[proxy] !== kubes) this.kubeState.update((all) => ({ ...all, [proxy]: kubes }));
  }
}

/** The current time, ticking every `intervalMs`, for countdowns. Call in an injection context. */
export function clock(intervalMs: number): Signal<Date> {
  const now = signal(new Date());
  const timer = setInterval(() => now.set(new Date()), intervalMs);
  inject(DestroyRef).onDestroy(() => clearInterval(timer));
  return now.asReadonly();
}
