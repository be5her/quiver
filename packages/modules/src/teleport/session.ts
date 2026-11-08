import type { ChildProcess } from 'node:child_process';
import {
  QuiverError,
  aggregateState,
  buildClusters,
  clusterLabel,
  findCluster,
  isAutoRenewOn,
  isBrowserLoginLine,
  isInAppSignInOn,
  nextRenewalAt,
  normalizeProxy,
  nowIso,
  parseTshStatus,
  proxiesToAutoRenew,
  proxyAddress,
  sameProxy,
  ssoLoginUrl,
  type TeleportClusterStatus,
  type TeleportConfig,
  type TeleportLoginResult,
  type TeleportRenewalEvent,
  type TeleportRenewalRecord,
  type TeleportRenewalResult,
  type TeleportStatus,
  type TeleportTunnel,
} from '@quiver/core';
import { lineSplitter, resolveTsh, runTsh, spawnTsh, tshErrorMessage, tshNotFound, type TshCommand } from './tsh';

export interface SessionOptions {
  getConfig(): TeleportConfig;
  onChange(reason: 'status' | 'login' | 'renewal', renewal?: TeleportRenewalEvent): void;
  tunnels(): TeleportTunnel[];
  /** How long between two `tsh status` polls; read again for every poll, so it can change while running. */
  pollMs?: number | (() => number);
  /** After an automatic renewal: refresh what still holds the old certificate (tunnels, kubeconfig, port forwards). */
  onRenewed?(proxy: string): Promise<void> | void;
  /**
   * Sign in inside Quiver: open the SSO link tsh printed in a Quiver window with the cluster's saved cookies. It starts
   * hidden and shows itself only when the page waits for the user and `reveal()` allows it; resolves false when it
   * closed without the sign-in (the user closed it, revealing was refused, `signal` aborted). Absent without a window
   * (the CLI), where logins use the system browser.
   */
  signInWindow?(options: { proxy: string; url: string; reveal(): boolean; onReveal(): void; signal: AbortSignal }): Promise<boolean>;
}

const LOGIN_TIMEOUT_MS = 5 * 60_000;
const LOGIN_OUTPUT_TAIL = 40;
const STATUS_FRESH_MS = 20_000;
const DEFAULT_POLL_MS = 60_000;

interface LoginRun {
  proxy: string;
  child: ChildProcess;
  output: string[];
  promise: Promise<TeleportLoginResult>;
  /** The user cancelled it (Cancel in the sidebar, teleport.login.cancel). */
  cancelled: boolean;
  /** tsh printed the line that sends the user to the browser, or the in-app sign-in window showed itself. */
  browser: boolean;
  onBrowser?: () => void;
  /** Sign in inside Quiver: tsh runs with `--browser=none` and its link opens in a Quiver window. */
  inApp: boolean;
  /** Whether the in-app window may show itself now that the sign-in waits for the user. */
  mayReveal: () => boolean;
  /** The in-app window was opened for this run. */
  signInOpened: boolean;
  /** Closes the in-app window. */
  closeSignIn: () => void;
  /** The in-app sign-in needed the user while that was not allowed (no Quiver window in front): tsh was stopped. */
  needsUser: boolean;
}

/**
 * The app-wide Teleport session: where tsh is, what `tsh status` says about every profile,
 * and the one `tsh login` that may be running. Polls status every minute; the UI counts down
 * from each cluster's validUntil. Commands always pass `--proxy`, so the terminal's current
 * profile is never switched behind the user's back except by a login.
 *
 * Keep me logged in: after every status read, a cluster with the setting on whose certificate
 * expires soon or has expired gets `tsh login --proxy` (see `proxiesToAutoRenew`). An expired
 * certificate needs the browser, so that attempt waits until the Quiver window is in front.
 */
export class TeleportSession {
  private tsh: TshCommand | null = null;
  private tshSetting: string | null = null;
  private tshVersion: string | null = null;
  private status: TeleportStatus = emptyStatus();
  private loginRun: LoginRun | null = null;
  private lastLogin: { proxy: string | null; output: string[] } = { proxy: null, output: [] };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private chain: Promise<unknown> = Promise.resolve();
  /** Automatic renewals of this app run, by normalized proxy. */
  private readonly renewals = new Map<string, TeleportRenewalRecord>();
  /** The cluster (normalized proxy) a renewal is running for. */
  private renewing: string | null = null;
  /** The `tsh login` of the running renewal, so turning the setting off or removing the cluster can cancel it. */
  private renewalRun: LoginRun | null = null;
  /** The running renewal was given up (setting off, cluster removed, logout): it is not recorded or followed up. */
  private renewalAbandoned = false;
  /** `tsh logout` calls running: no renewal starts meanwhile. */
  private logouts = 0;
  /** The cluster whose renewal waits for the window to come to the front. */
  private waitingForFocus: string | null = null;
  /** Whether a Quiver window is in front; hosts without a window never report, and never wait. */
  private focused = true;
  /**
   * Certificates (`<proxy>|<validUntil>`) whose quiet in-app renewal needed the user: their next attempt waits for the
   * window to be in front, like a renewal that opens the system browser.
   */
  private readonly needsUser = new Set<string>();

  constructor(private readonly opts: SessionOptions) {}

  async start(): Promise<TeleportStatus> {
    this.started = true;
    return this.refresh();
  }

  stop(): void {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.cancelLogin();
  }

  private pollInterval(): number {
    const ms = typeof this.opts.pollMs === 'function' ? this.opts.pollMs() : this.opts.pollMs;
    return ms && ms >= 100 ? ms : DEFAULT_POLL_MS;
  }

  /** The next poll is a full interval after the last status read, whoever asked for that one. */
  private scheduleNext(): void {
    if (!this.started) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.loginRun) this.scheduleNext();
      else void this.refresh().catch(() => {});
    }, this.pollInterval());
    this.timer.unref?.();
  }

  getStatus(): TeleportStatus {
    const config = this.opts.getConfig();
    return {
      ...this.status,
      clusters: this.status.clusters.map((c) => this.withRenewal(c, config)),
      pins: config.pins,
      loginInProgress: this.loginRun !== null,
      loginProxy: this.loginRun?.proxy ?? this.lastLogin.proxy,
      loginOutput: this.loginRun?.output ?? this.lastLogin.output,
      tunnels: this.opts.tunnels(),
    };
  }

  private withRenewal(c: TeleportClusterStatus, config: TeleportConfig): TeleportClusterStatus {
    const key = normalizeProxy(c.proxy);
    const record = this.renewals.get(key);
    const waiting = this.waitingForFocus === key;
    const renewal = record || waiting
      ? {
          lastAttemptAt: record?.lastAttemptAt ?? null,
          lastResult: record?.lastResult ?? null,
          lastError: record?.lastError ?? null,
          nextEligibleAt: nextRenewalAt(record, c),
          running: this.renewing === key,
          waitingForFocus: waiting,
        }
      : null;
    return { ...c, autoRenew: isAutoRenewOn(config, c.proxy), inAppSignIn: isInAppSignInOn(config, c.proxy), renewal };
  }

  /** Logins to this cluster sign in inside Quiver: the setting is on and this host has a window to do it in. */
  private inAppFor(proxy: string): boolean {
    return Boolean(this.opts.signInWindow) && isInAppSignInOn(this.opts.getConfig(), proxy);
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
    this.scheduleNext();
    this.considerRenewal();
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

  // ---------- keep me logged in ----------

  /** The renderer tells the host whether a Quiver window is in front; a renewal that waits for it starts on its return. */
  setFocused(focused: boolean): void {
    const was = this.focused;
    this.focused = focused;
    if (focused && !was && this.waitingForFocus) void this.refresh().catch(() => {});
  }

  /**
   * Give up the renewal running for this cluster (the user turned Keep me logged in off, removed the cluster or is
   * logging out of it): its `tsh login` is cancelled, and the attempt is neither recorded nor followed by a refresh.
   * A login the user started is never touched. Without a proxy, any running renewal.
   */
  abandonRenewal(proxy?: string | null): void {
    if (this.waitingForFocus && (!proxy || this.waitingForFocus === normalizeProxy(proxy))) {
      this.waitingForFocus = null;
      this.opts.onChange('renewal');
    }
    if (!this.renewing || (proxy && this.renewing !== normalizeProxy(proxy))) return;
    this.renewalAbandoned = true;
    if (this.renewalRun && this.loginRun === this.renewalRun) this.cancelLogin();
  }

  /**
   * Forget a cluster's renewal attempts (Keep me logged in turned off, the cluster removed): turned on again, it starts
   * fresh, without the spacing or a cancel of an earlier attempt held against it. A running renewal is given up too.
   */
  forgetRenewals(proxy: string): void {
    this.abandonRenewal(proxy);
    const key = normalizeProxy(proxy);
    if (this.renewing !== key) this.renewals.delete(key);
    for (const k of [...this.needsUser]) if (k.startsWith(`${key}|`)) this.needsUser.delete(k);
    this.opts.onChange('renewal');
  }

  /** Wait until no `tsh login` runs, automatic or not (e.g. before logging in on launch). */
  async whenLoginDone(): Promise<void> {
    while (this.loginRun) await this.loginRun.promise.catch(() => {});
  }

  /** Start the renewal that is due, if any. Runs after every status read, the poll's and everyone else's. */
  private considerRenewal(): void {
    if (!this.started || this.status.state === 'no-tsh' || this.logouts > 0) return;
    const config = this.opts.getConfig();
    const [proxy] = proxiesToAutoRenew(config, this.status.clusters, { loginRunning: this.loginRun !== null || this.renewing !== null, records: Object.fromEntries(this.renewals) });
    const waitedFor = this.waitingForFocus;
    // While a login runs nothing is due, but a renewal waiting for the window keeps waiting.
    if (this.loginRun || this.renewing) return;
    this.waitingForFocus = null;
    const cluster = proxy ? this.cluster(proxy) : undefined;
    if (!cluster) {
      if (waitedFor) this.opts.onChange('renewal');
      return;
    }
    // An expired certificate cannot be reissued without SSO: tsh opens the browser, which must not appear behind the user's back.
    // Signing in inside Quiver is tried quietly first, since the saved cookies usually complete it without a window; one
    // that needed the user waits for the window to be in front like the browser.
    const browser = cluster.state === 'expired';
    const inApp = this.inAppFor(cluster.proxy);
    const waitsForUser = inApp ? this.needsUser.has(certificateKey(cluster)) : browser;
    if (waitsForUser && !this.focused) {
      this.waitingForFocus = normalizeProxy(cluster.proxy);
      if (waitedFor !== this.waitingForFocus) {
        console.log(`[quiver] teleport certificate for ${clusterLabel(cluster)} expired; renewing when the Quiver window is in front`);
        this.opts.onChange('renewal');
      }
      return;
    }
    void this.renew(cluster, browser, inApp);
  }

  private async renew(cluster: TeleportClusterStatus, browser: boolean, inApp: boolean): Promise<void> {
    const key = normalizeProxy(cluster.proxy);
    const label = clusterLabel(cluster);
    const announce = (phase: TeleportRenewalEvent['phase'], extra: Partial<TeleportRenewalEvent> = {}) =>
      this.opts.onChange('renewal', { proxy: cluster.proxy, label, phase, browser, background: !this.focused, ...(inApp ? { inApp: true } : {}), ...extra });
    const record: TeleportRenewalRecord = { lastAttemptAt: nowIso(), lastResult: null, lastError: null, validUntil: cluster.validUntil };
    this.renewing = key;
    this.renewalAbandoned = false;
    this.renewals.set(key, record);
    console.log(`[quiver] teleport certificate for ${label} ${cluster.state === 'expired' ? 'expired' : 'expires soon'}, renewing with tsh login (${record.lastAttemptAt})`);
    announce('start');

    let result: TeleportRenewalResult = 'failed';
    let error: string | null = null;
    let needsUser = false;
    try {
      // A still valid certificate is usually reissued without the browser; if tsh opens it anyway, say so at once. In
      // Quiver, the sign-in window says so when it shows, which it only does while a Quiver window is in front.
      const run = this.spawnLogin(cluster.proxy, {
        onBrowser: browser && !inApp ? undefined : () => announce('browser', { browser: true }),
        mayReveal: () => this.focused,
      });
      this.renewalRun = run;
      const outcome = await run.promise;
      const after = findCluster(outcome.status.clusters, cluster.proxy);
      const usable = after?.state === 'logged-in' || after?.state === 'expiring';
      // A new certificate is a renewal whatever else happened: tsh may have written it just before it was stopped (the
      // window closed or was refused between the callback and tsh exiting).
      const renewed = usable && Boolean(after.validUntil) && after.validUntil !== cluster.validUntil;
      needsUser = !renewed && run.needsUser && !run.cancelled;
      if (renewed) result = 'ok';
      else if (run.cancelled) result = 'cancelled';
      else if (!outcome.ok) error = lastMessage(outcome.output) ?? 'tsh login failed';
      else error = 'tsh kept the certificate that is about to expire';
    } catch (err) {
      error = (err as Error).message;
    }
    this.renewalRun = null;
    this.renewing = null;
    // Quitting (stop() cancels the login), or the user turned the setting off, removed the cluster or logged out of
    // it meanwhile: not the user cancelling this certificate's renewal, and nothing to refresh.
    if (!this.started || this.renewalAbandoned || !isAutoRenewOn(this.opts.getConfig(), cluster.proxy)) {
      this.renewalAbandoned = false;
      this.renewals.delete(key);
      console.log(`[quiver] teleport renewal for ${label} given up (${this.started ? 'turned off, removed or logged out' : 'stopping'})`);
      if (this.started) {
        this.opts.onChange('renewal');
        this.considerRenewal();
      }
      return;
    }
    if (needsUser) {
      // Not a failure: the identity provider wants the user (a login form, a consent screen) and no Quiver window was in
      // front to show it in. The attempt is not counted; the next one waits for the window, then shows it.
      this.renewals.delete(key);
      this.needsUser.add(certificateKey(cluster));
      console.log(`[quiver] teleport renewal for ${label} needs you to sign in; renewing when the Quiver window is in front`);
      this.opts.onChange('renewal');
      this.considerRenewal();
      return;
    }
    this.renewals.set(key, { ...record, lastResult: result, lastError: result === 'failed' ? error : null });
    if (result === 'ok') {
      for (const k of [...this.needsUser]) if (k.startsWith(`${key}|`)) this.needsUser.delete(k);
      try {
        await this.opts.onRenewed?.(cluster.proxy);
      } catch (err) {
        console.warn(`[quiver] teleport: refreshing tunnels after renewing ${label} failed: ${(err as Error).message}`);
      }
    }
    console.log(`[quiver] teleport renewal for ${label}: ${result}${error ? ` (${error})` : ''}`);
    announce(result, error ? { message: error } : {});
    // Another cluster may be due too, one after the other.
    this.considerRenewal();
  }

  // ---------- commands ----------

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
    try {
      // The user asked for this login: its sign-in window may show whenever the page waits for them.
      return this.spawnLogin(proxy, { mayReveal: () => true }).promise;
    } catch (err) {
      return Promise.reject(err);
    }
  }

  /**
   * Spawn `tsh login` for a cluster; the caller checked that no login runs. Throws when tsh is missing. With Sign in
   * inside Quiver, tsh gets `--browser=none` and the link it prints opens in a Quiver window instead.
   */
  private spawnLogin(proxy: string, options: { onBrowser?: () => void; mayReveal: () => boolean }): LoginRun {
    const tsh = this.discover();
    if (!tsh) throw tshNotFound();

    const inApp = this.inAppFor(proxy);
    const output: string[] = [];
    const child = spawnTsh(tsh, ['login', `--proxy=${proxy}`, ...(inApp ? ['--browser=none'] : [])]);
    const run: LoginRun = {
      proxy,
      child,
      output,
      promise: Promise.resolve(null as unknown as TeleportLoginResult),
      cancelled: false,
      browser: false,
      onBrowser: options.onBrowser,
      inApp,
      mayReveal: options.mayReveal,
      signInOpened: false,
      closeSignIn: () => {},
      needsUser: false,
    };
    const push = (line: string) => {
      if (!line.trim()) return;
      output.push(line);
      if (output.length > LOGIN_OUTPUT_TAIL) output.splice(0, output.length - LOGIN_OUTPUT_TAIL);
      if (run.inApp) {
        const url = run.signInOpened ? null : ssoLoginUrl(line);
        if (url) this.openSignIn(run, url, push);
        else if (!run.signInOpened && !run.browser && /^https?:\/\/\S+$/i.test(line.trim())) {
          // A link that is not tsh's listener on this machine (a bind address set elsewhere): Quiver does not open it, but
          // says so, so the login does not sit waiting with nothing to do.
          run.browser = true;
          output.push('Quiver opens only links to tsh on this machine; open the link above in your browser to sign in.');
        }
      } else if (!run.browser && isBrowserLoginLine(line)) {
        run.browser = true;
        run.onBrowser?.();
      }
      this.opts.onChange('login');
    };
    child.stdout?.on('data', lineSplitter(push));
    child.stderr?.on('data', lineSplitter(push));

    run.promise = new Promise<TeleportLoginResult>((resolve) => {
      let settled = false;
      const finish = async (ok: boolean, note?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (note) push(note);
        run.closeSignIn();
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
      child.on('close', (code, signal) => {
        const note = run.cancelled
          ? 'Login cancelled.'
          : run.needsUser
            ? 'The sign-in needs you; it continues when the Quiver window is in front.'
            : `tsh login exited with ${signal ?? `code ${code}`}.`;
        void finish(code === 0, code === 0 ? undefined : note);
      });
    });

    this.loginRun = run;
    this.opts.onChange('login');
    return run;
  }

  /**
   * Open tsh's SSO link in the cluster's sign-in window. tsh finishing closes the window; the window closing first stops
   * tsh: closed by the user it is a cancel, refused because nobody is looking it is `needsUser`.
   */
  private openSignIn(run: LoginRun, url: string, push: (line: string) => void): void {
    const signInWindow = this.opts.signInWindow;
    if (!signInWindow) return;
    run.signInOpened = true;
    const controller = new AbortController();
    run.closeSignIn = () => controller.abort();
    // 'failed': the window could not open; neither a cancel (which would hold off renewals of this certificate) nor a
    // sign-in that needs the user, so the attempt counts as failed and is retried after the usual spacing.
    const stop = (reason: 'cancelled' | 'needs-user' | 'failed', note?: string) => {
      if (controller.signal.aborted || this.loginRun !== run || run.child.exitCode !== null) return;
      if (reason === 'cancelled') run.cancelled = true;
      else if (reason === 'needs-user') run.needsUser = true;
      if (note) push(note);
      run.child.kill();
    };
    let refused = false;
    void signInWindow({
      proxy: run.proxy,
      url,
      signal: controller.signal,
      reveal: () => {
        const allowed = run.mayReveal();
        refused = !allowed;
        return allowed;
      },
      onReveal: () => {
        run.browser = true;
        run.onBrowser?.();
        this.opts.onChange('login');
      },
    }).then(
      (ok) => {
        if (ok) return;
        if (refused) stop('needs-user');
        else stop('cancelled', 'Sign-in window closed.');
      },
      (err: Error) => stop('failed', `Could not open the sign-in window: ${err.message}`),
    );
  }

  cancelLogin(): boolean {
    if (!this.loginRun) return false;
    this.loginRun.cancelled = true;
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
    // No renewal starts while tsh logs out, and one running for that cluster is given up: logging out wins.
    this.logouts++;
    let run: Awaited<ReturnType<typeof runTsh>>;
    try {
      this.abandonRenewal(proxy?.trim() ? proxy : null);
      run = await runTsh(tsh, args, { timeoutMs: 30_000 });
    } finally {
      this.logouts--;
    }
    if (run.code !== 0 && !/not logged in/i.test(`${run.stderr}${run.stdout}`)) throw new QuiverError('REQUEST_FAILED', `tsh logout failed: ${tshErrorMessage(run)}`);
    this.lastLogin = { proxy: null, output: [] };
    return this.refresh();
  }

  /** Run a tsh subcommand against one cluster; maps "not logged in" style failures to TELEPORT_LOGIN_REQUIRED. */
  async run(args: string[], proxy: string, timeoutMs = 60_000, env?: Record<string, string>): Promise<string> {
    const cluster = await this.requireSession(proxy);
    const tsh = await this.tshCommand();
    const run = await runTsh(tsh, [...args, `--proxy=${cluster.proxy}`], { timeoutMs, env });
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

/** One certificate of one cluster, so a decision about it ends when tsh has a new one. */
function certificateKey(cluster: Pick<TeleportClusterStatus, 'proxy' | 'validUntil'>): string {
  return `${normalizeProxy(cluster.proxy)}|${cluster.validUntil ?? ''}`;
}

/** The line of tsh's output that says why it failed: the last error, else the last line. */
function lastMessage(output: string[]): string | null {
  const line = output.findLast((l) => /error|failed|denied|timed out|cancel/i.test(l)) ?? output.at(-1);
  return line ? line.replace(/^ERROR:\s*/i, '').trim() : null;
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
