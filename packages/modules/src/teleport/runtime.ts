import { QuiverError, isInAppSignInOn, normalizeProxy, teleportSignInPartition, type Caller, type HostApi } from '@quiver/core';
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
    onLoginPrompt: () => void session.refresh().catch(() => {}),
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
    // A database tunnel whose certificate ends logs in by itself in the system browser on its next connection, so it
    // stops first; the next query asks for a login through Quiver (see loginForUse). kubectl gets no such guard of its
    // own: every kube query and port forward starts through requireSession, which refuses an ending certificate.
    onCertificateEnding: async (proxy) => {
      await tunnels.stopCluster(proxy);
    },
    // The smoke shortens the guard to see a certificate end; it sets this in the running process.
    guardMs: () => Number(process.env.QUIVER_TELEPORT_GUARD_MS) || undefined,
    // Sign in inside Quiver needs a window to sign in with; the headless CLI has none and keeps the system browser.
    signInWindow: host.web
      ? ({ proxy, url, reveal, onReveal, signal }) =>
          host.web!.signIn({
            partition: teleportSignInPartition(proxy),
            url,
            title: `Sign in to Teleport · ${normalizeProxy(proxy)}`,
            // tsh finishing is what ends the sign-in (it aborts the signal), whatever page the window ends on.
            done: () => false,
            // The smoke shortens how long saved cookies get before the window shows; it sets this in the running process.
            reveal: { afterMs: Number(process.env.QUIVER_TELEPORT_SIGNIN_REVEAL_MS) || 4_000, allowed: reveal, onReveal },
            signal,
          })
      : undefined,
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

/**
 * Something the user reached for (a database query) found its cluster's certificate ended: log in through Quiver's own
 * login and say whether to try once more. Only for the user's own requests, where a sign-in window may show, and only
 * with Sign in inside Quiver on for that cluster, where the login is usually silent; a login in the system browser
 * stays the user's click ("Log in again"). Everything else (agents, other errors) resolves false at once.
 */
export async function loginForUse(host: HostApi, caller: Caller, err: unknown): Promise<boolean> {
  if (caller !== 'ui' || !host.web) return false;
  if (!(err instanceof QuiverError) || err.code !== 'TELEPORT_LOGIN_REQUIRED') return false;
  const proxy = (err.details as { proxy?: unknown } | undefined)?.proxy;
  if (typeof proxy !== 'string' || !proxy.trim() || !isInAppSignInOn(host.config.get().teleport, proxy)) return false;
  try {
    return (await getTeleport(host).session.login(proxy)).ok;
  } catch {
    return false;
  }
}
