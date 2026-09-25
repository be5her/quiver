import type { ChildProcess } from 'node:child_process';
import { QuiverError, nowIso, parseTshStatus, type TeleportConfig, type TeleportLoginResult, type TeleportStatus, type TeleportTunnel } from '@quiver/core';
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
  child: ChildProcess;
  output: string[];
  promise: Promise<TeleportLoginResult>;
}

/**
 * The app-wide Teleport session: where tsh is, what `tsh status` says, and the one
 * `tsh login` that may be running. Polls status every minute; the UI counts down from validUntil.
 */
export class TeleportSession {
  private tsh: TshCommand | null = null;
  private tshSetting: string | null = null;
  private tshVersion: string | null = null;
  private status: TeleportStatus = emptyStatus();
  private loginRun: LoginRun | null = null;
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
    return { ...this.status, loginInProgress: this.loginRun !== null, loginOutput: this.loginRun?.output ?? this.status.loginOutput, tunnels: this.opts.tunnels() };
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
   * a result computed after it asked, e.g. right after the tsh path setting changed.
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
    const loginOutput = this.status.loginOutput;
    if (!tsh) {
      this.status = { ...emptyStatus(), state: 'no-tsh', proxy: config.proxy || null, loginOutput, checkedAt: nowIso() };
    } else {
      if (this.tshVersion === null) this.tshVersion = await this.readVersion(tsh);
      let next: TeleportStatus;
      try {
        const run = await runTsh(tsh, ['status', '--format=json'], { timeoutMs: 15_000 });
        const parsed = parseTshStatus(run.stdout);
        const failedForAnotherReason = run.code !== 0 && parsed.state === 'logged-out' && !/not logged in/i.test(run.stderr);
        next = {
          ...emptyStatus(),
          ...parsed,
          proxy: config.proxy || parsed.proxy,
          error: failedForAnotherReason ? tshErrorMessage(run) : null,
        };
      } catch (err) {
        next = { ...emptyStatus(), state: 'logged-out', proxy: config.proxy || null, error: (err as Error).message };
      }
      this.status = { ...next, tsh: tsh.argv, tshSource: tsh.source, tshVersion: this.tshVersion, loginOutput, checkedAt: nowIso() };
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

  /** Throw TELEPORT_LOGIN_REQUIRED unless there is a usable certificate. Refreshes when the snapshot is stale. */
  async requireSession(): Promise<TeleportStatus> {
    const age = Date.now() - new Date(this.status.checkedAt).getTime();
    const status = age > STATUS_FRESH_MS || this.status.state === 'no-tsh' ? await this.refresh() : this.getStatus();
    switch (status.state) {
      case 'logged-in':
      case 'expiring':
        return status;
      case 'no-tsh':
        throw tshNotFound();
      case 'expired':
        throw new QuiverError('TELEPORT_LOGIN_REQUIRED', `Your Teleport certificate for ${status.cluster ?? status.proxy ?? 'the cluster'} has expired. Log in again.`);
      default:
        throw new QuiverError('TELEPORT_LOGIN_REQUIRED', 'Not logged in to Teleport. Log in to start tunnels.');
    }
  }

  /**
   * `tsh login --proxy=<addr>`. The cluster's default connector is SSO, so no `--auth` and no
   * stdin: tsh opens the browser and the callback completes the login. Resolves when tsh exits.
   */
  login(proxyOverride?: string): Promise<TeleportLoginResult> {
    if (this.loginRun) return this.loginRun.promise;
    const proxy = proxyOverride?.trim() || this.opts.getConfig().proxy.trim() || this.status.proxy;
    if (!proxy) return Promise.reject(new QuiverError('INVALID_INPUT', 'Set the Teleport proxy address in Settings > Teleport first.'));
    let tsh: TshCommand;
    try {
      tsh = this.discover() ?? (() => {
        throw tshNotFound();
      })();
    } catch (err) {
      return Promise.reject(err);
    }

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
        const status = await this.refresh().catch(() => this.getStatus());
        this.status.loginOutput = [...output];
        this.opts.onChange('login');
        resolve({ ok: ok && (status.state === 'logged-in' || status.state === 'expiring'), output: [...output], status: this.getStatus() });
      };
      const timer = setTimeout(() => {
        child.kill();
        void finish(false, `Login timed out after ${LOGIN_TIMEOUT_MS / 60_000} minutes.`);
      }, LOGIN_TIMEOUT_MS);
      child.on('error', (err) => void finish(false, `Could not start tsh: ${err.message}`));
      child.on('close', (code, signal) => void finish(code === 0, code === 0 ? undefined : `tsh login exited with ${signal ?? `code ${code}`}.`));
    });

    this.loginRun = { child, output, promise };
    this.opts.onChange('login');
    return promise;
  }

  cancelLogin(): boolean {
    if (!this.loginRun) return false;
    this.loginRun.child.kill();
    return true;
  }

  async logout(): Promise<TeleportStatus> {
    const tsh = await this.tshCommand();
    const run = await runTsh(tsh, ['logout'], { timeoutMs: 30_000 });
    if (run.code !== 0 && !/not logged in/i.test(`${run.stderr}${run.stdout}`)) throw new QuiverError('REQUEST_FAILED', `tsh logout failed: ${tshErrorMessage(run)}`);
    this.status.loginOutput = [];
    return this.refresh();
  }

  /** Run a tsh subcommand that needs a live session; maps "not logged in" style failures to TELEPORT_LOGIN_REQUIRED. */
  async run(args: string[], timeoutMs = 60_000): Promise<string> {
    await this.requireSession();
    const tsh = await this.tshCommand();
    const run = await runTsh(tsh, args, { timeoutMs });
    if (run.code !== 0) {
      const message = tshErrorMessage(run);
      if (/not logged in|expired|relogin|re-login/i.test(message)) {
        void this.refresh().catch(() => {});
        throw new QuiverError('TELEPORT_LOGIN_REQUIRED', `Teleport session is not usable: ${message}`);
      }
      throw new QuiverError('REQUEST_FAILED', `tsh ${args[0]} ${args[1] ?? ''} failed: ${message}`.trim());
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
    proxy: null,
    cluster: null,
    user: null,
    roles: [],
    validUntil: null,
    kubeCluster: null,
    profiles: [],
    loginInProgress: false,
    loginOutput: [],
    error: null,
    checkedAt: nowIso(),
    tunnels: [],
  };
}

/** What counts as a change worth broadcasting. */
function signature(s: TeleportStatus): string {
  return JSON.stringify([s.state, s.tsh, s.proxy, s.cluster, s.user, s.validUntil, s.kubeCluster, s.error, s.roles]);
}
