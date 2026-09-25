import type { HostApi } from '@quiver/core';
import { TeleportSession } from './session';
import { TunnelManager } from './tunnels';

export interface TeleportRuntime {
  session: TeleportSession;
  tunnels: TunnelManager;
}

let runtime: TeleportRuntime | null = null;

/**
 * One session and one tunnel manager per app. Both the Teleport module and the database
 * driver pool go through here, so a tunnel started from either side is visible to the other.
 */
export function getTeleport(host: HostApi): TeleportRuntime {
  if (runtime) return runtime;
  const tunnels = new TunnelManager({
    tsh: () => session.tshCommand(),
    requireSession: async () => {
      await session.requireSession();
    },
    onChange: () => host.emit('teleport.changed', { reason: 'tunnels' }),
    graceMs: 30_000,
  });
  const session = new TeleportSession({
    getConfig: () => host.config.get().teleport,
    onChange: (reason) => host.emit('teleport.changed', { reason }),
    tunnels: () => tunnels.list(),
  });
  runtime = { session, tunnels };
  return runtime;
}
