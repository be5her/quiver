import { sameProxy, type DbConnectionSummary, type TeleportClusterStatus } from '@quiver/core';

export const STATE_LABEL: Record<TeleportClusterStatus['state'], string> = {
  'logged-out': 'Logged out',
  expired: 'Certificate expired',
  'logged-in': 'Logged in',
  expiring: 'Expiring soon',
};

export const STATE_DOT: Record<TeleportClusterStatus['state'], string> = {
  'logged-out': 'bg-danger',
  expired: 'bg-danger',
  'logged-in': 'bg-success',
  expiring: 'bg-warning',
};

export const PROTOCOL_COLORS: Record<string, string> = {
  mysql: 'bg-sky-500/15 text-sky-600 dark:text-sky-300',
  redis: 'bg-rose-500/15 text-rose-600 dark:text-rose-300',
  postgres: 'bg-indigo-500/15 text-indigo-600 dark:text-indigo-300',
  mongodb: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-300',
};

/** Logged in, or about to expire: the cluster's resources can be used. */
export function isUsable(cluster: TeleportClusterStatus | undefined): boolean {
  return cluster?.state === 'logged-in' || cluster?.state === 'expiring';
}

/**
 * Whether kubectl in the user's terminals points at this Kubernetes cluster. Read from the cluster's
 * `tsh status`, which the host refreshes after every login and `tsh kube login`, rather than from the
 * cached `tsh kube ls` list, which only loads while the cluster's section is open.
 */
export function isTerminalKube(cluster: TeleportClusterStatus | undefined, name: string): boolean {
  return isUsable(cluster) && cluster?.kubeCluster === name;
}

/** The workspace's connection that goes through the Teleport tunnel to this database, if any. */
export function connectionFor(connections: DbConnectionSummary[] | undefined, proxy: string, database: string): DbConnectionSummary | undefined {
  return connections?.find((c) => c.access.type === 'teleport' && c.access.database === database && (sameProxy(c.access.proxy, proxy) || c.access.proxy === ''));
}
