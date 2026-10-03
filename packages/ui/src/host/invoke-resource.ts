import { DestroyRef, computed, inject, linkedSignal, resource, untracked, type ResourceSnapshot, type Signal } from '@angular/core';
import { toErrorPayload, type ErrorPayload, type HostEventName } from '@quiver/core';
import { AppState } from '../state/app-state';
import { HostBridge } from './host-bridge';

export interface InvokeResourceOptions {
  /** Explicit workspace, `null` for global. Defaults to the active workspace. */
  workspaceId?: string | null | (() => string | null);
  /** Reload when one of these collections changes in the target workspace. */
  refreshOn?: readonly string[];
  /** Reload when one of these workspace state keys changes. */
  refreshOnState?: readonly string[];
  /** Reload on these host events regardless of workspace, e.g. `teleport.changed`. */
  refreshOnEvents?: readonly HostEventName[];
  /** While false, nothing is requested. */
  enabled?: () => boolean;
}

export interface InvokeResource<T> {
  /** The latest result. It stays while a new one loads and after a failed reload, so lists do not blink. */
  readonly value: Signal<T | undefined>;
  /** The error of the last load, cleared by the next successful one. */
  readonly error: Signal<ErrorPayload | null>;
  readonly isLoading: Signal<boolean>;
  /** Run the command again with the same input. */
  reload(): void;
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * A host command as a `resource()`: it runs whenever the input (read reactively from `input`) or
 * the workspace changes, and again on the store, state and host events named in the options.
 * Call it in an injection context; it stops listening when that context is destroyed.
 */
export function invokeResource<T>(id: string, input: () => unknown = () => ({}), options: InvokeResourceOptions = {}): InvokeResource<T> {
  const host = inject(HostBridge);
  const app = inject(AppState);

  const workspaceId = computed(() => {
    const ws = options.workspaceId;
    return ws === undefined ? app.activeWorkspaceId() : typeof ws === 'function' ? ws() : ws;
  });
  // Compared by content, so an input rebuilt with the same values does not run the command again.
  const params = computed(() => ((options.enabled?.() ?? true) ? { input: input(), workspaceId: workspaceId() } : undefined), { equal: sameJson });
  const ref = resource({
    params,
    loader: ({ params: p }) => host.invoke<T>(id, p.input, p.workspaceId),
  });

  const value = linkedSignal<ResourceSnapshot<T | undefined>, T | undefined>({
    source: ref.snapshot,
    computation: (snapshot, previous) =>
      snapshot.status === 'resolved' || snapshot.status === 'reloading' || snapshot.status === 'local' ? snapshot.value : previous?.value,
  });
  const error = linkedSignal<ResourceSnapshot<T | undefined>, ErrorPayload | null>({
    source: ref.snapshot,
    computation: (snapshot, previous) => (snapshot.status === 'error' ? toErrorPayload(snapshot.error) : snapshot.status === 'resolved' ? null : (previous?.value ?? null)),
  });

  const offs: (() => void)[] = [];
  const collections = options.refreshOn ?? [];
  const stateKeys = options.refreshOnState ?? [];
  if (collections.length) {
    offs.push(host.on('store.changed', (p) => p.workspaceId === untracked(workspaceId) && collections.includes(p.collection) && ref.reload()));
  }
  if (stateKeys.length) {
    offs.push(host.on('state.changed', (p) => p.workspaceId === untracked(workspaceId) && stateKeys.includes(p.key) && ref.reload()));
  }
  for (const event of options.refreshOnEvents ?? []) offs.push(host.on(event, () => ref.reload()));
  inject(DestroyRef).onDestroy(() => offs.forEach((off) => off()));

  return {
    value: value.asReadonly(),
    error: error.asReadonly(),
    isLoading: ref.isLoading,
    reload: () => void ref.reload(),
  };
}
