import type { ChildProcess } from 'node:child_process';
import { QuiverError, buildPortForwardArgs, formatCommandLine, newId, normalizeProxy, nowIso, sameProxy, type KubePortForward, type KubePortForwardSpec } from '@quiver/core';
import type { KubeRunner } from './kube';
import { killTree, lineSplitter, spawnTsh } from './tsh';
import { freePort } from './tunnels';

const OUTPUT_LINES = 50;
const MAX_FORWARDS = 16;
/** How long `kubectl port-forward` may take to say it is listening. */
const START_TIMEOUT_MS = 30_000;
/** How long a stopped forward may take to exit before it is killed harder. */
const STOP_GRACE_MS = 3000;

const WINDOWS = process.platform === 'win32';

/**
 * `killTree` leaves a process that has exited alone. When tsh exits first, kubectl, in tsh's process group, can still
 * hold the port and the pipes (so `close` has not fired): on macOS and Linux the group is signalled directly. The
 * group id stays taken while any member lives, so it cannot name another process's group.
 */
function signalOrphanedGroup(forward: LiveForward, signal: NodeJS.Signals = 'SIGTERM'): void {
  const pid = forward.info.pid;
  if (WINDOWS || !pid || forward.child.exitCode === null) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // The group is gone already.
  }
}

export interface KubeForwardsOptions {
  runner: KubeRunner;
  onChange(): void;
}

export interface KubeForwardRequest {
  proxy: string;
  cluster: string;
  spec: KubePortForwardSpec;
}

interface LiveForward {
  info: KubePortForward;
  child: ChildProcess;
  /** Resolves once the process has exited and its pipes closed. */
  closed: Promise<void>;
}

/**
 * `tsh kubectl port-forward` processes, app-wide like the database tunnels. Each listens on
 * 127.0.0.1 only, runs until stopped, and is stopped as a whole process tree (tsh runs kubectl
 * in a second process) on stop, on logout of its cluster and on quit. A forward whose process
 * exits on its own (the pod went away) stays listed as exited, with its last output, until it is
 * stopped.
 */
export class KubeForwards {
  private readonly live = new Map<string, LiveForward>();
  /** Starts still waiting for kubectl, by target: a second identical start waits for the first instead of racing it. */
  private readonly pending = new Map<string, Promise<KubePortForward>>();
  /** Starts past the cap check that have not settled yet, so concurrent starts to different targets cannot pass the cap together. */
  private starting = 0;
  /** Proxies being logged out (normalized; `*` for all of them), with how many logouts hold each: no forward starts on them meanwhile. */
  private readonly closing = new Map<string, number>();

  constructor(private readonly opts: KubeForwardsOptions) {}

  /**
   * Refuses new forwards on one Teleport cluster (every cluster without `proxy`) until `during` has settled, e.g. a
   * logout that stops the cluster's forwards: a start that was still waiting for its command would otherwise spawn
   * after the stop and keep running on the credentials kubectl had already loaded.
   */
  async refuseStartsWhile<T>(proxy: string | undefined, during: () => Promise<T>): Promise<T> {
    const key = proxy ? normalizeProxy(proxy) : '*';
    this.closing.set(key, (this.closing.get(key) ?? 0) + 1);
    try {
      return await during();
    } finally {
      const left = (this.closing.get(key) ?? 1) - 1;
      if (left > 0) this.closing.set(key, left);
      else this.closing.delete(key);
    }
  }

  private refuseIfClosing(...proxies: string[]): void {
    if (this.closing.has('*') || proxies.some((p) => this.closing.has(normalizeProxy(p)))) {
      throw new QuiverError('REQUEST_FAILED', `Logging out of ${proxies[0]}; start the port forward again after logging in`);
    }
  }

  list(): KubePortForward[] {
    return [...this.live.values()].map((l) => ({ ...l.info, output: [...l.info.output] }));
  }

  /** Start a forward, or return the running (or starting) one for the same target and port. */
  async start(req: KubeForwardRequest): Promise<KubePortForward> {
    const { spec } = req;
    const key = [normalizeProxy(req.proxy), req.cluster, spec.kind, spec.name, spec.namespace, spec.remotePort, spec.localPort ?? ''].join('|');
    const inFlight = this.pending.get(key);
    if (inFlight) return inFlight;
    const started = this.launch(req);
    this.pending.set(key, started);
    const forget = () => {
      if (this.pending.get(key) === started) this.pending.delete(key);
    };
    started.then(forget, forget);
    return started;
  }

  private async launch(req: KubeForwardRequest): Promise<KubePortForward> {
    const { spec } = req;
    this.refuseIfClosing(req.proxy);
    const existing = [...this.live.values()].find(
      (l) =>
        l.info.state !== 'exited' &&
        sameProxy(l.info.proxy, req.proxy) &&
        l.info.cluster === req.cluster &&
        l.info.kind === spec.kind &&
        l.info.name === spec.name &&
        l.info.namespace === spec.namespace &&
        l.info.remotePort === spec.remotePort &&
        (spec.localPort === undefined || l.info.localPort === spec.localPort),
    );
    if (existing) return { ...existing.info };
    // Running ones, plus every start still under way (its entry, once listed, is `starting` and counted here instead).
    if ([...this.live.values()].filter((l) => l.info.state === 'running').length + this.starting >= MAX_FORWARDS) {
      throw new QuiverError('INVALID_INPUT', `${MAX_FORWARDS} port forwards are running already; stop one first`);
    }
    this.starting++;
    try {
      return await this.spawnForward(req);
    } finally {
      this.starting--;
    }
  }

  private async spawnForward(req: KubeForwardRequest): Promise<KubePortForward> {
    const { spec } = req;
    const localPort = spec.localPort ?? (await freePort());
    const args = buildPortForwardArgs({ ...spec, localPort });
    const { tsh, argv, proxy } = await this.opts.runner.commandFor(req.proxy, req.cluster, args);
    // A logout may have begun while the command was looked up.
    this.refuseIfClosing(req.proxy, proxy);

    let child: ChildProcess;
    try {
      child = spawnTsh(tsh, argv.slice(tsh.argv.length), { tree: true });
    } catch (err) {
      throw new QuiverError('REQUEST_FAILED', `Could not start tsh kubectl port-forward: ${(err as Error).message}`);
    }
    const info: KubePortForward = {
      id: newId(),
      proxy,
      cluster: req.cluster,
      kind: spec.kind,
      name: spec.name,
      namespace: spec.namespace,
      remotePort: spec.remotePort,
      localPort,
      url: `http://127.0.0.1:${localPort}`,
      command: formatCommandLine(argv, { windows: WINDOWS }),
      pid: child.pid ?? null,
      state: 'starting',
      exitCode: null,
      output: [],
      startedAt: nowIso(),
    };
    let closedResolve!: () => void;
    const forward: LiveForward = { info, child, closed: new Promise((r) => (closedResolve = r)) };
    this.live.set(info.id, forward);

    return new Promise<KubePortForward>((resolve, reject) => {
      let settled = false;
      const fail = (message: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new QuiverError('REQUEST_FAILED', message, { output: info.output }));
        // Listed until its process has gone, so stop, logout and quit still reach one that is slow to die.
        void this.end(forward).finally(() => {
          if (this.live.get(info.id) !== forward) return;
          this.live.delete(info.id);
          this.opts.onChange();
        });
      };
      const keep = (line: string) => {
        if (!line.trim()) return;
        info.output.push(line);
        if (info.output.length > OUTPUT_LINES) info.output.splice(0, info.output.length - OUTPUT_LINES);
      };
      child.stdout?.on(
        'data',
        lineSplitter((line) => {
          keep(line);
          // "Forwarding from 127.0.0.1:18080 -> 80": kubectl is listening.
          if (!settled && /^Forwarding from 127\.0\.0\.1:\d+/.test(line)) {
            settled = true;
            clearTimeout(timer);
            info.state = 'running';
            this.opts.onChange();
            resolve({ ...info, output: [...info.output] });
          }
        }),
      );
      child.stderr?.on('data', lineSplitter(keep));
      const timer = setTimeout(() => {
        fail(`kubectl port-forward did not start listening within ${START_TIMEOUT_MS / 1000}s`);
      }, START_TIMEOUT_MS);
      timer.unref?.();
      child.on('error', (err) => fail(`Could not start tsh kubectl port-forward (${tsh.argv[0]}): ${err.message}`));
      child.on('close', (code) => {
        info.state = 'exited';
        info.exitCode = code;
        info.pid = null;
        closedResolve();
        if (!settled) {
          fail(`kubectl port-forward exited${code === null ? '' : ` with code ${code}`}: ${info.output.at(-1) ?? 'no output'}`);
          return;
        }
        if (this.live.get(info.id) === forward) this.opts.onChange();
      });
    });
  }

  /** Drop a forward from the list, then stop it and every process tsh started for it. */
  async stop(id: string): Promise<boolean> {
    const forward = this.live.get(id);
    if (!forward) return false;
    this.live.delete(id);
    this.opts.onChange();
    await this.end(forward);
    return true;
  }

  /** Forwards of one Teleport cluster, e.g. on its logout. */
  async stopCluster(proxy: string): Promise<number> {
    const ids = [...this.live.values()].filter((l) => sameProxy(l.info.proxy, proxy)).map((l) => l.info.id);
    await Promise.all(ids.map((id) => this.stop(id)));
    return ids.length;
  }

  async stopAll(): Promise<void> {
    const all = [...this.live.values()];
    this.live.clear();
    if (all.length) this.opts.onChange();
    await Promise.all(all.map((f) => this.end(f)));
  }

  private async end(forward: LiveForward): Promise<void> {
    if (forward.info.state === 'exited') return;
    killTree(forward.child);
    signalOrphanedGroup(forward);
    const force = setTimeout(() => {
      killTree(forward.child, 'SIGKILL');
      signalOrphanedGroup(forward, 'SIGKILL');
      forward.child.stdout?.destroy();
      forward.child.stderr?.destroy();
    }, STOP_GRACE_MS);
    force.unref?.();
    await Promise.race([forward.closed, new Promise((r) => setTimeout(r, STOP_GRACE_MS * 2).unref?.())]);
    clearTimeout(force);
  }
}
