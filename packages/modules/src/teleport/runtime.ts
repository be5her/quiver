import type { HostApi } from '@quiver/core';
import { KubeRunner } from './kube';
import { TeleportSession } from './session';
import { TunnelManager } from './tunnels';

export interface TeleportRuntime {
  session: TeleportSession;
  tunnels: TunnelManager;
  kube: KubeRunner;
}

let runtime: TeleportRuntime | null = null;

/**
 * One session, one tunnel manager and one Kubernetes query runner per app. Both the Teleport
 * module and the database driver pool go through here, so a tunnel started from either side is
 * visible to the other.
 */
export function getTeleport(host: HostApi): TeleportRuntime {
  if (runtime) return runtime;
  const tunnels = new TunnelManager({
    tsh: () => session.tshCommand(),
    requireSession: async (proxy) => (await session.requireSession(proxy)).proxy,
    onChange: () => host.emit('teleport.changed', { reason: 'tunnels' }),
    graceMs: 30_000,
  });
  const session = new TeleportSession({
    getConfig: () => host.config.get().teleport,
    onChange: (reason) => host.emit('teleport.changed', { reason }),
    tunnels: () => tunnels.list(),
  });
  const kube = new KubeRunner({
    session,
    dataDir: host.dataDir ?? null,
    onHistory: () => host.emit('teleport.kube.changed', { reason: 'history' }),
    onStream: (runId) => host.emit('teleport.kube.changed', { reason: 'stream', runId }),
  });
  runtime = { session, tunnels, kube };
  return runtime;
}
