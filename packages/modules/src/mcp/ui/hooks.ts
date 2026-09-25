import type { HostEvents, McpServerSummary } from '@quiver/core';
import { onHostEvent, useInvoke, type UseInvokeResult } from '@quiver/ui';
import { useEffect } from 'react';

type Reason = HostEvents['mcp.changed']['reason'];

/** A query against a connected server that re-runs when the server reports one of the given changes. */
export function useServerQuery<T>(id: string, input: Record<string, unknown>, server: Pick<McpServerSummary, 'id' | 'status'>, reasons: Reason[]): UseInvokeResult<T> {
  const query = useInvoke<T>(id, input, { enabled: server.status === 'connected' });
  const { refresh } = query;
  const key = reasons.join(',');
  useEffect(
    () =>
      onHostEvent('mcp.changed', (p) => {
        if (p.serverId === server.id && key.split(',').includes(p.reason)) void refresh();
      }),
    [server.id, key, refresh],
  );
  return query;
}
