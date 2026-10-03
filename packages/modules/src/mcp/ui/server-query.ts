import type { HostEvents, McpServerSummary } from '@quiver/core';
import { injectHostEvent, invokeResource, type InvokeResource } from '@quiver/ui';

type Reason = HostEvents['mcp.changed']['reason'];

/**
 * A query against a connected server that runs again when the server reports one of the given
 * changes. Nothing is asked while the server is not connected. Call in an injection context.
 */
export function injectServerQuery<T>(id: string, input: () => Record<string, unknown>, server: () => Pick<McpServerSummary, 'id' | 'status'>, reasons: Reason[]): InvokeResource<T> {
  const query = invokeResource<T>(id, input, { enabled: () => server().status === 'connected' });
  injectHostEvent('mcp.changed', (p) => p.serverId === server().id && reasons.includes(p.reason) && query.reload());
  return query;
}
