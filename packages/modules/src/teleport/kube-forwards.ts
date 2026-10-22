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

  constructor(private readonly opts: KubeForwardsOptions) {}

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
    if ([...this.live.values()].filter((l) => l.info.state !== 'exited').length >= MAX_FORWARDS) {
      throw new QuiverError('INVALID_INPUT', `${MAX_FORWARDS} port forwards are running already; stop one first`);
    }
    const localPort = spec.localPort ?? (await freePort());
    const args = buildPortForwardArgs({ ...spec, localPort });
    const { tsh, argv, proxy } = await this.opts.runner.commandFor(req.proxy, req.cluster, args);

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
        this.live.delete(info.id);
        this.opts.onChange();
        reject(new QuiverError('REQUEST_FAILED', message, { output: info.output }));
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
        killTree(child);
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
    for (const id of ids) await this.stop(id);
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
    const force = setTimeout(() => {
      killTree(forward.child, 'SIGKILL');
      forward.child.stdout?.destroy();
      forward.child.stderr?.destroy();
    }, STOP_GRACE_MS);
    force.unref?.();
    await Promise.race([forward.closed, new Promise((r) => setTimeout(r, STOP_GRACE_MS * 2).unref?.())]);
    clearTimeout(force);
  }
}
