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

function minutesBetween(from: string, to: Date): number {
  return Math.round((to.getTime() - new Date(from).getTime()) / 60_000);
}

function ago(iso: string, now: Date): string {
  const minutes = minutesBetween(iso, now);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'} ago`;
}

/** The line under a cluster's user about its last automatic renewal, or null before the first one. */
export function renewalLine(cluster: TeleportClusterStatus, now: Date): { text: string; tone: string } | null {
  const r = cluster.renewal;
  if (!r) return null;
  if (r.running) return { text: 'renewing the certificate…', tone: 'text-muted' };
  if (r.waitingForFocus) return { text: 'renews when Quiver is in front (opens the browser)', tone: 'text-warning' };
  if (!r.lastAttemptAt) return null;
  switch (r.lastResult) {
    case 'ok':
      return { text: `renewed ${ago(r.lastAttemptAt, now)}`, tone: 'text-muted' };
    case 'cancelled':
      return { text: 'renewal cancelled; log in to renew this certificate', tone: 'text-muted' };
    case 'failed': {
      const wait = r.nextEligibleAt ? -minutesBetween(r.nextEligibleAt, now) : 0;
      const retry = !cluster.autoRenew ? '' : wait >= 1 ? `, retrying in ${wait} minute${wait === 1 ? '' : 's'}` : ', retrying soon';
      return { text: `renewal failed: ${r.lastError ?? 'tsh login failed'}${retry}`, tone: 'text-danger' };
    }
    default:
      return null;
  }
}

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
