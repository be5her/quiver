import { toErrorPayload, type ErrorPayload, type HostEventName } from '@quiver/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke, onHostEvent } from '../host';
import { useAppStore } from '../stores/app';

export interface UseInvokeOptions {
  /** Explicit workspace, `null` for global. Defaults to the active workspace. */
  workspaceId?: string | null;
  /** Re-run when one of these collections changes in the target workspace. */
  refreshOn?: string[];
  /** Re-run when one of these workspace state keys changes. */
  refreshOnState?: string[];
  /** Re-run on these host events regardless of workspace, e.g. `teleport.changed`. */
  refreshOnEvents?: HostEventName[];
  enabled?: boolean;
}

export interface UseInvokeResult<T> {
  data: T | undefined;
  error: ErrorPayload | null;
  loading: boolean;
  refresh(): Promise<void>;
}

/** Small query hook: runs a host command and refreshes on store change events. */
export function useInvoke<T>(id: string, input: unknown = {}, options: UseInvokeOptions = {}): UseInvokeResult<T> {
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId);
  const workspaceId = options.workspaceId === undefined ? activeWorkspaceId : options.workspaceId;
  const enabled = options.enabled ?? true;
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<ErrorPayload | null>(null);
  const [loading, setLoading] = useState(enabled);
  const inputKey = JSON.stringify(input);
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    const mine = ++seq.current;
    setLoading(true);
    try {
      const result = await invoke<T>(id, JSON.parse(inputKey), workspaceId);
      if (mine === seq.current) {
        setData(result);
        setError(null);
      }
    } catch (err) {
      if (mine === seq.current) setError(toErrorPayload(err));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [id, inputKey, workspaceId, enabled]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const collections = options.refreshOn?.join(',') ?? '';
  const stateKeys = options.refreshOnState?.join(',') ?? '';
  useEffect(() => {
    if (!collections && !stateKeys) return;
    const wanted = new Set(collections.split(',').filter(Boolean));
    const wantedState = new Set(stateKeys.split(',').filter(Boolean));
    const offStore = onHostEvent('store.changed', (p) => {
      if (p.workspaceId === workspaceId && wanted.has(p.collection)) void refresh();
    });
    const offState = onHostEvent('state.changed', (p) => {
      if (p.workspaceId === workspaceId && wantedState.has(p.key)) void refresh();
    });
    return () => {
      offStore();
      offState();
    };
  }, [collections, stateKeys, workspaceId, refresh]);

  const eventNames = options.refreshOnEvents?.join(',') ?? '';
  useEffect(() => {
    if (!eventNames) return;
    const offs = eventNames.split(',').map((name) => onHostEvent(name as HostEventName, () => void refresh()));
    return () => offs.forEach((off) => off());
  }, [eventNames, refresh]);

  return { data, error, loading, refresh };
}
