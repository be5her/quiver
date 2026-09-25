import type { ChildProcess } from 'node:child_process';
import {
  QuiverError,
  aggregateState,
  buildClusters,
  clusterLabel,
  findCluster,
  nowIso,
  parseTshStatus,
  proxyAddress,
  sameProxy,
  type TeleportClusterStatus,
  type TeleportConfig,
  type TeleportLoginResult,
  type TeleportStatus,
  type TeleportTunnel,
} from '@quiver/core';
import { lineSplitter, resolveTsh, runTsh, spawnTsh, tshErrorMessage, tshNotFound, type TshCommand } from './tsh';

export interface SessionOptions {
  getConfig(): TeleportConfig;
  onChange(reason: 'status' | 'login'): void;
  tunnels(): TeleportTunnel[];
  pollMs?: number;
}

const LOGIN_TIMEOUT_MS = 5 * 60_000;
const LOGIN_OUTPUT_TAIL = 40;
const STATUS_FRESH_MS = 20_000;

interface LoginRun {
  proxy: string;
  child: ChildProcess;
  output: string[];
  promise: Promise<TeleportLoginResult>;
}

/**
 * The app-wide Teleport session: where tsh is, what `tsh status` says about every profile,
 * and the one `tsh login` that may be running. Polls status every minute; the UI counts down
 * from each cluster's validUntil. Commands always pass `--proxy`, so the terminal's current
 * profile is never switched behind the user's back except by a login.
 */
export class TeleportSession {
  private tsh: TshCommand | null = null;
  private tshSetting: string | null = null;
  private tshVersion: string | null = null;
  private status: TeleportStatus = emptyStatus();
  private loginRun: LoginRun | null = null;
  private lastLogin: { proxy: string | null; output: string[] } = { proxy: null, output: [] };
  private timer: ReturnType<typeof setInterval> | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: SessionOptions) {}

  async start(): Promise<TeleportStatus> {
    const status = await this.refresh();
    this.timer = setInterval(() => {
      if (!this.loginRun) void this.refresh().catch(() => {});
    }, this.opts.pollMs ?? 60_000);
    this.timer.unref?.();
    return status;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.cancelLogin();
  }

  getStatus(): TeleportStatus {
    return {
      ...this.status,
      pins: this.opts.getConfig().pins,
      loginInProgress: this.loginRun !== null,
      loginProxy: this.loginRun?.proxy ?? this.lastLogin.proxy,
      loginOutput: this.loginRun?.output ?? this.lastLogin.output,
      tunnels: this.opts.tunnels(),
    };
  }

  cluster(proxy: string | null | undefined): TeleportClusterStatus | undefined {
    return findCluster(this.status.clusters, proxy);
  }

  /** Resolved tsh command; rediscovers when the setting changed or nothing was found last time. */
  async tshCommand(): Promise<TshCommand> {
    const cmd = this.discover();
    if (!cmd) throw tshNotFound();
    return cmd;
  }

  private discover(): TshCommand | null {
    const setting = this.opts.getConfig().tshPath;
    if (!this.tsh || setting !== this.tshSetting) {
      const previous = this.tsh?.argv.join(' ');
      this.tsh = resolveTsh(setting);
      this.tshSetting = setting;
      if (previous !== this.tsh?.argv.join(' ')) this.tshVersion = null;
    }
    return this.tsh;
  }

  /**
   * Run `tsh status` now and update the snapshot. Runs are serialized so a caller always gets
   * a result computed after it asked, e.g. right after the settings changed.
   */
  refresh(): Promise<TeleportStatus> {
    const run = this.chain.catch(() => {}).then(() => this.doRefresh());
    this.chain = run;
    return run;
  }

  private async doRefresh(): Promise<TeleportStatus> {
    const before = signature(this.status);
    const config = this.opts.getConfig();
    const tsh = this.discover();
    if (!tsh) {
      this.status = { ...emptyStatus(), state: 'no-tsh', clusters: buildClusters(config.proxies, []), checkedAt: nowIso() };
    } else {
      if (this.tshVersion === null) this.tshVersion = await this.readVersion(tsh);
      let clusters: TeleportClusterStatus[];
      let error: string | null = null;
      try {
        const run = await runTsh(tsh, ['status', '--format=json'], { timeoutMs: 15_000 });
        const profiles = parseTshStatus(run.stdout);
        clusters = buildClusters(config.proxies, profiles);
        if (run.code !== 0 && profiles.length === 0 && !/not logged in/i.test(run.stderr)) error = tshErrorMessage(run);
      } catch (err) {
        clusters = buildClusters(config.proxies, []);
        error = (err as Error).message;
      }
      this.status = { ...emptyStatus(), state: aggregateState(clusters), clusters, error, tsh: tsh.argv, tshSource: tsh.source, tshVersion: this.tshVersion, checkedAt: nowIso() };
    }
    if (signature(this.status) !== before) this.opts.onChange('status');
    return this.getStatus();
  }

  private async readVersion(tsh: TshCommand): Promise<string | null> {
    for (const args of [['version', '--client'], ['version']]) {
      try {
        const run = await runTsh(tsh, args, { timeoutMs: 8_000 });
        const match = /v?(\d+\.\d+\.\d+[^\s]*)/.exec(run.stdout);
        if (match) return match[1];
        if (run.code === 0) return run.stdout.trim().split(/\r?\n/)[0] || null;
      } catch {
        // try the next form
      }
    }
    return null;
  }

  /**
   * The cluster a command applies to when the caller named none: the only usable one,
   * else tsh's current profile, else the only known one.
   */
  resolveProxy(proxy?: string | null): string {
    if (proxy?.trim()) return proxyAddress(proxy) ?? proxy.trim();
    const { clusters } = this.status;
    const usable = clusters.filter((c) => c.state === 'logged-in' || c.state === 'expiring');
    if (usable.length === 1) return usable[0].proxy;
    const current = clusters.find((c) => c.current);
    if (current) return current.proxy;
    if (clusters.length === 1) return clusters[0].proxy;
    throw new QuiverError(
      'INVALID_INPUT',
      clusters.length ? `Pick a Teleport cluster with proxy: ${clusters.map((c) => c.proxy).join(', ')}` : 'No Teleport clusters yet. Add a proxy address in Settings > Teleport.',
      { proxies: clusters.map((c) => c.proxy) },
    );
  }

  /** Throw TELEPORT_LOGIN_REQUIRED unless the cluster has a usable certificate. Refreshes when the snapshot is stale. */
  async requireSession(proxy: string): Promise<TeleportClusterStatus> {
    const age = Date.now() - new Date(this.status.checkedAt).getTime();
    const status = age > STATUS_FRESH_MS || this.status.state === 'no-tsh' ? await this.refresh() : this.getStatus();
    if (status.state === 'no-tsh') throw tshNotFound();
    const cluster = findCluster(status.clusters, proxy);
    if (!cluster) throw new QuiverError('TELEPORT_LOGIN_REQUIRED', `Not logged in to Teleport cluster ${proxy || '(current profile)'}. Log in to use it.`, { proxy });
    switch (cluster.state) {
      case 'logged-in':
      case 'expiring':
        return cluster;
      case 'expired':
        throw new QuiverError('TELEPORT_LOGIN_REQUIRED', `Your Teleport certificate for ${clusterLabel(cluster)} has expired. Log in again.`, { proxy: cluster.proxy });
      default:
        throw new QuiverError('TELEPORT_LOGIN_REQUIRED', `Not logged in to ${clusterLabel(cluster)}. Log in to start tunnels.`, { proxy: cluster.proxy });
    }
  }

  private resolveLoginProxy(proxy?: string | null): string {
    if (proxy?.trim()) return proxyAddress(proxy) ?? proxy.trim();
    const configured = this.opts.getConfig().proxies;
    if (configured.length === 1) return configured[0];
    const { clusters } = this.status;
    if (clusters.length === 1) return clusters[0].proxy;
    throw new QuiverError(
      'INVALID_INPUT',
      clusters.length ? `Pick a cluster to log in to with proxy: ${clusters.map((c) => c.proxy).join(', ')}` : 'Set a Teleport proxy address in Settings > Teleport first.',
      { proxies: clusters.map((c) => c.proxy) },
    );
  }

  /**
   * `tsh login --proxy=<addr>`. The cluster's default connector is SSO, so no `--auth` and no
   * stdin: tsh opens the browser and the callback completes the login. Resolves when tsh exits.
   * One login at a time; a second call for the same cluster joins it.
   */
  login(proxyArg?: string | null): Promise<TeleportLoginResult> {
    let proxy: string;
    try {
      proxy = this.resolveLoginProxy(proxyArg);
    } catch (err) {
      return Promise.reject(err);
    }
    if (this.loginRun) {
      if (sameProxy(this.loginRun.proxy, proxy)) return this.loginRun.promise;
      return Promise.reject(new QuiverError('INVALID_INPUT', `A login to ${this.loginRun.proxy} is already in progress. Finish or cancel it first.`));
    }
    const tsh = this.discover();
    if (!tsh) return Promise.reject(tshNotFound());

    const output: string[] = [];
    const child = spawnTsh(tsh, ['login', `--proxy=${proxy}`]);
    const push = (line: string) => {
      if (!line.trim()) return;
      output.push(line);
      if (output.length > LOGIN_OUTPUT_TAIL) output.splice(0, output.length - LOGIN_OUTPUT_TAIL);
      this.opts.onChange('login');
    };
    child.stdout?.on('data', lineSplitter(push));
    child.stderr?.on('data', lineSplitter(push));

    const promise = new Promise<TeleportLoginResult>((resolve) => {
      let settled = false;
      const finish = async (ok: boolean, note?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (note) push(note);
        this.loginRun = null;
        this.lastLogin = { proxy, output: [...output] };
        const status = await this.refresh().catch(() => this.getStatus());
        this.opts.onChange('login');
        const cluster = findCluster(status.clusters, proxy);
        const usable = cluster?.state === 'logged-in' || cluster?.state === 'expiring';
        resolve({ ok: ok && usable, proxy, output: [...output], status: this.getStatus() });
      };
      const timer = setTimeout(() => {
        child.kill();
        void finish(false, `Login timed out after ${LOGIN_TIMEOUT_MS / 60_000} minutes.`);
      }, LOGIN_TIMEOUT_MS);
      child.on('error', (err) => void finish(false, `Could not start tsh: ${err.message}`));
      child.on('close', (code, signal) => void finish(code === 0, code === 0 ? undefined : `tsh login exited with ${signal ?? `code ${code}`}.`));
    });

    this.loginRun = { proxy, child, output, promise };
    this.opts.onChange('login');
    return promise;
  }

  cancelLogin(): boolean {
    if (!this.loginRun) return false;
    this.loginRun.child.kill();
    return true;
  }

  /** `tsh logout` for one cluster (needs the profile's user, tsh insists on both flags) or for all of them. */
  async logout(proxy?: string | null): Promise<TeleportStatus> {
    const tsh = await this.tshCommand();
    let args = ['logout'];
    if (proxy?.trim()) {
      const cluster = findCluster(this.status.clusters, proxy);
      if (!cluster?.user) return this.refresh();
      args = ['logout', `--proxy=${cluster.proxy}`, `--user=${cluster.user}`];
    }
    const run = await runTsh(tsh, args, { timeoutMs: 30_000 });
    if (run.code !== 0 && !/not logged in/i.test(`${run.stderr}${run.stdout}`)) throw new QuiverError('REQUEST_FAILED', `tsh logout failed: ${tshErrorMessage(run)}`);
    this.lastLogin = { proxy: null, output: [] };
    return this.refresh();
  }

  /** Run a tsh subcommand against one cluster; maps "not logged in" style failures to TELEPORT_LOGIN_REQUIRED. */
  async run(args: string[], proxy: string, timeoutMs = 60_000): Promise<string> {
    const cluster = await this.requireSession(proxy);
    const tsh = await this.tshCommand();
    const run = await runTsh(tsh, [...args, `--proxy=${cluster.proxy}`], { timeoutMs });
    if (run.code !== 0) {
      const message = tshErrorMessage(run);
      if (/not logged in|expired|relogin|re-login/i.test(message)) {
        void this.refresh().catch(() => {});
        throw new QuiverError('TELEPORT_LOGIN_REQUIRED', `Teleport session for ${clusterLabel(cluster)} is not usable: ${message}`, { proxy: cluster.proxy });
      }
      throw new QuiverError('REQUEST_FAILED', `tsh ${args[0]} ${args[1] ?? ''} on ${clusterLabel(cluster)} failed: ${message}`.replace(/\s+/g, ' '));
    }
    return run.stdout;
  }
}

function emptyStatus(): TeleportStatus {
  return {
    state: 'logged-out',
    tsh: null,
    tshVersion: null,
    tshSource: null,
    clusters: [],
    loginInProgress: false,
    loginProxy: null,
    loginOutput: [],
    pins: [],
    error: null,
    checkedAt: nowIso(),
    tunnels: [],
  };
}

/** What counts as a change worth broadcasting. */
function signature(s: TeleportStatus): string {
  return JSON.stringify([s.state, s.tsh, s.error, s.clusters.map((c) => [c.proxy, c.state, c.cluster, c.user, c.validUntil, c.kubeCluster, c.current, c.roles])]);
}
