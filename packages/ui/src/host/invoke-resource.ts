import { DestroyRef, computed, inject, linkedSignal, resource, untracked, type ResourceSnapshot, type Signal } from '@angular/core';
import { toErrorPayload, type ErrorPayload, type HostEventName } from '@quiver/core';
import { AppState } from '../state/app-state';
import { HostBridge } from './host-bridge';

export interface InvokeResourceOptions {
  /** Explicit workspace, `null` for global. Defaults to the active workspace. */
  workspaceId?: string | null | (() => string | null);
  /**
   * Reload when one of these collections changes in the target workspace. A function is read when
   * an event arrives, for names that depend on inputs, e.g. `db-schema:<connection id>`.
   */
  refreshOn?: readonly string[] | (() => readonly string[]);
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
  /**
   * `value`, only while it was read for the workspace the resource reads now: undefined while it is another
   * workspace's (the active one changed and its result has not come yet). A view that serves every workspace shows
   * this, so one repository's or project's data never shows in another for a moment.
   */
  readonly current: Signal<T | undefined>;
  /** `error`, only while it is the workspace's the resource reads now; null otherwise. */
  readonly currentError: Signal<ErrorPayload | null>;
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

  // Each result and error is kept with the workspace it was read for. A resolved or failed snapshot always belongs to
  // the current params (the resource drops a load whose params changed), so they say which workspace that is.
  const loadedFor = () => untracked(params)?.workspaceId;
  const latest = linkedSignal<ResourceSnapshot<T | undefined>, { value: T | undefined; workspaceId: string | null | undefined }>({
    source: ref.snapshot,
    computation: (snapshot, previous) =>
      snapshot.status === 'resolved' || snapshot.status === 'reloading' || snapshot.status === 'local'
        ? { value: snapshot.value, workspaceId: loadedFor() }
        : (previous?.value ?? { value: undefined, workspaceId: undefined }),
  });
  const failed = linkedSignal<ResourceSnapshot<T | undefined>, { error: ErrorPayload | null; workspaceId: string | null | undefined }>({
    source: ref.snapshot,
    computation: (snapshot, previous) =>
      snapshot.status === 'error'
        ? { error: toErrorPayload(snapshot.error), workspaceId: loadedFor() }
        : snapshot.status === 'resolved'
          ? { error: null, workspaceId: loadedFor() }
          : (previous?.value ?? { error: null, workspaceId: undefined }),
  });
  const value = computed(() => latest().value);
  const error = computed(() => failed().error);

  const offs: (() => void)[] = [];
  const refreshOn = options.refreshOn ?? [];
  const collections = typeof refreshOn === 'function' ? () => untracked(refreshOn) : () => refreshOn;
  const stateKeys = options.refreshOnState ?? [];
  if (typeof refreshOn === 'function' || refreshOn.length) {
    offs.push(host.on('store.changed', (p) => p.workspaceId === untracked(workspaceId) && collections().includes(p.collection) && ref.reload()));
  }
  if (stateKeys.length) {
    offs.push(host.on('state.changed', (p) => p.workspaceId === untracked(workspaceId) && stateKeys.includes(p.key) && ref.reload()));
  }
  for (const event of options.refreshOnEvents ?? []) offs.push(host.on(event, () => ref.reload()));
  inject(DestroyRef).onDestroy(() => offs.forEach((off) => off()));

  return {
    value,
    error,
    current: computed(() => (latest().workspaceId === workspaceId() ? latest().value : undefined)),
    currentError: computed(() => (failed().workspaceId === workspaceId() ? failed().error : null)),
    isLoading: ref.isLoading,
    reload: () => void ref.reload(),
  };
}
