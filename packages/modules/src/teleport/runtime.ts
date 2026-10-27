import type { HostApi } from '@quiver/core';
import { KubeRunner } from './kube';
import { KubeForwards } from './kube-forwards';
import { TeleportSession } from './session';
import { TunnelManager } from './tunnels';

export interface TeleportRuntime {
  session: TeleportSession;
  tunnels: TunnelManager;
  kube: KubeRunner;
  forwards: KubeForwards;
}

let runtime: TeleportRuntime | null = null;

/**
 * One session, one tunnel manager, one Kubernetes runner and one set of port forwards per app.
 * Both the Teleport module and the database driver pool go through here, so a tunnel started
 * from either side is visible to the other.
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
    onChange: (reason, renewal) => host.emit('teleport.changed', renewal ? { reason, renewal } : { reason }),
    tunnels: () => tunnels.list(),
    // The smoke shortens the poll to see a renewal happen; it sets this in the running process.
    pollMs: () => Number(process.env.QUIVER_TELEPORT_POLL_MS) || 60_000,
    // Everything that holds the old certificate: tunnels restart now, the private kubeconfig is written again by
    // the next query's `tsh kube login`, and port forwards that die of the old certificate restart once.
    onRenewed: async (proxy) => {
      kube.forget(proxy);
      forwards.noteRenewal(proxy);
      await tunnels.restartCluster(proxy);
    },
  });
  const kube = new KubeRunner({
    session,
    dataDir: host.dataDir ?? null,
    onHistory: () => host.emit('teleport.kube.changed', { reason: 'history' }),
    onStream: (runId) => host.emit('teleport.kube.changed', { reason: 'stream', runId }),
  });
  const forwards = new KubeForwards({ runner: kube, onChange: () => host.emit('teleport.kube.changed', { reason: 'forwards' }) });
  runtime = { session, tunnels, kube, forwards };
  return runtime;
}
