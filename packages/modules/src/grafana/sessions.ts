import { QuiverError, grafanaPartition, normalizeGrafanaUrl, nowIso, type HostApi, type LogsSession, type LogsUser, type WebSessionsApi } from '@quiver/core';

/** Seconds before Grafana's rotation deadline at which the session is renewed ahead of a request. */
const ROTATE_EARLY_S = 30;

const SIGNED_OUT: LogsSession = { state: 'signed-out', user: null, error: null, checkedAt: null };

function hostOf(base: string): string {
  return new URL(base).host;
}

/**
 * Grafana sessions on this machine, one per origin, shared by every connection, workspace and module:
 * signing in for Logs also signs in Redis through the same Grafana, and the reverse. Use the one
 * instance, `grafanaSessions`.
 * Requests carry the session cookie of the sign-in window. Grafana asks clients to renew the session
 * token every few minutes (`grafana_session_expiry`, and 401 with `session.token.rotate`); this does
 * that before a request is due, and once more when a request is refused, before giving up.
 */
export class GrafanaSessions {
  private readonly sessions = new Map<string, LogsSession>();
  private readonly rotations = new Map<string, Promise<boolean>>();

  /** What is known without asking Grafana. */
  session(grafanaUrl: string): LogsSession {
    const base = normalizeGrafanaUrl(grafanaUrl);
    if (!base) return { state: 'unknown', user: null, error: null, checkedAt: null };
    return this.sessions.get(grafanaPartition(base)) ?? { state: 'unknown', user: null, error: null, checkedAt: null };
  }

  /** Ask Grafana who the session belongs to. */
  async check(host: HostApi, grafanaUrl: string): Promise<LogsSession> {
    const base = requireBase(grafanaUrl);
    if (this.session(base).state === 'signing-in') return this.session(base);
    try {
      const user = await this.whoami(host, base);
      return this.set(host, base, user ? { state: 'signed-in', user, error: null, checkedAt: nowIso() } : { ...SIGNED_OUT, checkedAt: nowIso() });
    } catch (err) {
      return this.set(host, base, { ...this.session(base), state: this.session(base).state === 'signed-in' ? 'signed-in' : 'unknown', error: (err as Error).message, checkedAt: nowIso() });
    }
  }

  /** Open Grafana's login page in a window and wait until the user is signed in or closes it. */
  async signIn(host: HostApi, grafanaUrl: string): Promise<LogsSession> {
    const web = requireWeb(host);
    const base = requireBase(grafanaUrl);
    const already = await this.whoami(host, base).catch(() => null);
    if (already) return this.set(host, base, { state: 'signed-in', user: already, error: null, checkedAt: nowIso() });

    this.set(host, base, { state: 'signing-in', user: null, error: null, checkedAt: nowIso() });
    const login = new URL(`${base}/login`);
    let ok: boolean;
    try {
      ok = await web.signIn({
        partition: grafanaPartition(base),
        url: login.href,
        title: `Sign in to Grafana · ${login.host}`,
        // Signed in once Grafana serves a page that is not the login form and knows the user. The host is
        // compared, not the origin: a server that upgrades http to https is still the same Grafana.
        done: async (url) => {
          const at = new URL(url);
          if (at.host !== login.host || at.pathname.startsWith(login.pathname)) return false;
          return (await this.whoami(host, base)) !== null;
        },
      });
    } catch (err) {
      this.set(host, base, { ...SIGNED_OUT, error: (err as Error).message, checkedAt: nowIso() });
      throw new QuiverError('REQUEST_FAILED', (err as Error).message);
    }
    const user = ok ? await this.whoami(host, base).catch(() => null) : null;
    return this.set(host, base, user ? { state: 'signed-in', user, error: null, checkedAt: nowIso() } : { ...SIGNED_OUT, error: ok ? 'Grafana did not keep the session' : null, checkedAt: nowIso() });
  }

  /** End the session on Grafana's side when it still answers, then forget it on this machine. */
  async signOut(host: HostApi, grafanaUrl: string): Promise<LogsSession> {
    const web = requireWeb(host);
    const base = requireBase(grafanaUrl);
    const partition = grafanaPartition(base);
    await web.fetch(partition, `${base}/logout`, { timeoutMs: 10_000 }).catch(() => undefined);
    await web.clear(partition);
    return this.set(host, base, { ...SIGNED_OUT, checkedAt: nowIso() });
  }

  /**
   * A JSON request with the session. A refusal that renewing the token does not cure is SIGN_IN_REQUIRED;
   * any other answer comes back with its status for the caller to judge.
   */
  async request<T = unknown>(host: HostApi, grafanaUrl: string, path: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<{ status: number; body: T }> {
    const web = requireWeb(host);
    const base = requireBase(grafanaUrl);
    const partition = grafanaPartition(base);
    const expiry = Number(await web.cookie(partition, base, 'grafana_session_expiry'));
    if (expiry && expiry - ROTATE_EARLY_S < Date.now() / 1000) await this.rotate(web, base);

    const send = () =>
      web.fetch(partition, `${base}${path}`, {
        method: init.method ?? 'GET',
        headers: { Accept: 'application/json', ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        timeoutMs: init.timeoutMs,
      });
    let res = await send().catch((err: Error) => {
      throw new QuiverError('REQUEST_FAILED', `Grafana at ${hostOf(base)} did not answer: ${err.message}`);
    });
    if (res.status === 401 && (await this.rotate(web, base))) res = await send();
    if (res.status === 401) {
      if (this.session(base).state !== 'signing-in') this.set(host, base, { ...SIGNED_OUT, checkedAt: nowIso() });
      throw new QuiverError('SIGN_IN_REQUIRED', `Not signed in to Grafana at ${hostOf(base)}. Sign in from Quiver: the Logs view, or the database connection that goes through this Grafana.`, { grafanaUrl: base });
    }
    let body: unknown = res.text;
    try {
      body = JSON.parse(res.text);
    } catch {
      // Not JSON: an HTML error page or plain text; the caller sees it as text.
    }
    return { status: res.status, body: body as T };
  }

  private async whoami(host: HostApi, base: string): Promise<LogsUser | null> {
    try {
      const { status, body } = await this.request<{ login?: string; email?: string; name?: string }>(host, base, '/api/user', { timeoutMs: 15_000 });
      if (status !== 200 || !body || typeof body !== 'object') return null;
      return { login: body.login ?? '', email: body.email ?? '', name: body.name ?? '' };
    } catch (err) {
      if (err instanceof QuiverError && err.code === 'SIGN_IN_REQUIRED') return null;
      throw err;
    }
  }

  /** Renew the session token; concurrent callers share one renewal. */
  private rotate(web: WebSessionsApi, base: string): Promise<boolean> {
    const partition = grafanaPartition(base);
    let running = this.rotations.get(partition);
    if (!running) {
      running = (async () => {
        if (!(await web.cookie(partition, base, 'grafana_session'))) return false;
        const res = await web.fetch(partition, `${base}/api/user/auth-tokens/rotate`, { method: 'POST', headers: { Accept: 'application/json' }, timeoutMs: 15_000 });
        return res.status >= 200 && res.status < 300;
      })()
        .catch(() => false)
        .finally(() => this.rotations.delete(partition));
      this.rotations.set(partition, running);
    }
    return running;
  }

  private set(host: HostApi, base: string, session: LogsSession): LogsSession {
    const partition = grafanaPartition(base);
    const before = this.sessions.get(partition);
    this.sessions.set(partition, session);
    if (before?.state !== session.state || before?.user?.login !== session.user?.login || before?.error !== session.error) {
      host.emit('logs.changed', { reason: 'session', grafanaUrl: base });
      host.emit('grafana.changed', { grafanaUrl: base, state: session.state });
    }
    return session;
  }
}

/** The sessions of this machine, shared by the Logs and Databases modules. */
export const grafanaSessions = new GrafanaSessions();

function requireWeb(host: HostApi): WebSessionsApi {
  if (!host.web) throw new QuiverError('REQUEST_FAILED', 'Grafana sign-in needs the Quiver desktop app');
  return host.web;
}

function requireBase(grafanaUrl: string): string {
  const base = normalizeGrafanaUrl(grafanaUrl);
  if (!base) throw new QuiverError('INVALID_INPUT', 'The connection has no Grafana address yet');
  return base;
}
