import { QuiverError, type HostEventMessage, type HostEventName, type HostEvents } from '@quiver/core';
import { useAppStore } from './stores/app';

/**
 * Run a host command. `workspaceId` defaults to the active workspace;
 * pass `null` to run a global command explicitly without one.
 */
export async function invoke<T = unknown>(id: string, input: unknown = {}, workspaceId?: string | null): Promise<T> {
  const ws = workspaceId === undefined ? useAppStore.getState().activeWorkspaceId : workspaceId;
  const res = await window.quiver.invoke(id, input, ws);
  if (!res.ok) throw new QuiverError(res.error.code, res.error.message, res.error.details);
  return res.result as T;
}

type AnyListener = (message: HostEventMessage) => void;
const listeners = new Set<AnyListener>();
let bridgeAttached = false;

/** One IPC subscription fans out to every UI listener, so hooks can subscribe freely. */
export function onHostEvent<E extends HostEventName>(event: E, listener: (payload: HostEvents[E]) => void): () => void {
  if (!bridgeAttached) {
    bridgeAttached = true;
    window.quiver.onEvent((message) => {
      for (const l of [...listeners]) l(message);
    });
  }
  const wrapped: AnyListener = (message) => {
    if (message.event === event) listener(message.payload as HostEvents[E]);
  };
  listeners.add(wrapped);
  return () => {
    listeners.delete(wrapped);
  };
}

export const isMac = (): boolean => window.quiver?.platform === 'darwin';
export const modKey = (): string => (isMac() ? '⌘' : 'Ctrl');
