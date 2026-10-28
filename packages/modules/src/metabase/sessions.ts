import { QuiverError, metabasePartition, normalizeMetabaseUrl, nowIso, type HostApi, type MetabaseSession, type MetabaseUser, type WebResponse, type WebSessionsApi } from '@quiver/core';

const SIGNED_OUT: MetabaseSession = { state: 'signed-out', user: null, error: null, checkedAt: null };
const UNKNOWN: MetabaseSession = { state: 'unknown', user: null, error: null, checkedAt: null };

const SESSION_COOKIE = 'metabase.SESSION';
/**
 * How long this machine keeps the session cookie: Metabase's default MAX_SESSION_AGE, 14 days. Metabase
 * only gives the cookie an expiry when "Remember me" is ticked on its password form, never after a
 * Google sign-in, and a cookie without one is gone when Quiver quits. A server that ends the session
 * sooner answers 401, which asks for a sign-in as before.
 */
const KEEP_SESSION_S = 14 * 24 * 60 * 60;

export function hostOf(base: string): string {
  return new URL(base).host;
}

/** Metabase's `/api/user/current` as a user: the name it shows, else first and last name. */
export function metabaseUser(body: unknown): MetabaseUser | null {
  if (!body || typeof body !== 'object') return null;
  const u = body as { id?: unknown; email?: unknown; common_name?: unknown; first_name?: unknown; last_name?: unknown };
  if (typeof u.id !== 'number') return null;
  const name = typeof u.common_name === 'string' && u.common_name.trim() ? u.common_name.trim() : [u.first_name, u.last_name].filter((p) => typeof p === 'string' && p.trim()).join(' ');
  return { id: u.id, email: typeof u.email === 'string' ? u.email : '', name };
}

/** The error SIGN_IN_REQUIRED carries for a Metabase address. */
export function signInRequired(base: string, connectionId?: string): QuiverError {
  return new QuiverError(
    'SIGN_IN_REQUIRED',
    `Not signed in to Metabase at ${hostOf(base)}. Ask the user to sign in from Quiver's Metabase view (the connection's Sign in button).`,
    { metabaseUrl: base, connectionId },
  );
}

/**
 * Metabase browser sessions on this machine, one per origin, shared by every connection and workspace.
 * Use the one instance, `metabaseSessions`. Requests carry the session cookie of the sign-in window;
 * Metabase sessions need no renewing, so a refusal means signing in again.
 */
export class MetabaseSessions {
  private readonly sessions = new Map<string, MetabaseSession>();

  /** What is known without asking Metabase. */
  session(metabaseUrl: string): MetabaseSession {
    const base = normalizeMetabaseUrl(metabaseUrl);
    if (!base) return UNKNOWN;
    return this.sessions.get(metabasePartition(base)) ?? UNKNOWN;
  }

  /** Ask Metabase who the session belongs to. */
  async check(host: HostApi, metabaseUrl: string): Promise<MetabaseSession> {
    const base = requireBase(metabaseUrl);
    if (this.session(base).state === 'signing-in') return this.session(base);
    try {
      const user = await this.whoami(host, base);
      return this.set(host, base, user ? { state: 'signed-in', user, error: null, checkedAt: nowIso() } : { ...SIGNED_OUT, checkedAt: nowIso() });
    } catch (err) {
      const known = this.session(base);
      return this.set(host, base, { ...known, state: known.state === 'signed-in' ? 'signed-in' : 'unknown', error: (err as Error).message, checkedAt: nowIso() });
    }
  }

  /** Open Metabase's login page in a window and wait until the user is signed in or closes it. */
  async signIn(host: HostApi, metabaseUrl: string): Promise<MetabaseSession> {
    const web = requireWeb(host);
    const base = requireBase(metabaseUrl);
    const already = await this.whoami(host, base).catch(() => null);
    if (already) await web.keepCookie(metabasePartition(base), base, SESSION_COOKIE, KEEP_SESSION_S).catch(() => false);
    if (already) return this.set(host, base, { state: 'signed-in', user: already, error: null, checkedAt: nowIso() });

    this.set(host, base, { state: 'signing-in', user: null, error: null, checkedAt: nowIso() });
    const login = new URL(`${base}/auth/login`);
    const authPath = new URL(`${base}/auth/`).pathname;
    let ok: boolean;
    try {
      ok = await web.signIn({
        partition: metabasePartition(base),
        url: login.href,
        title: `Sign in to Metabase · ${login.host}`,
        // Signed in once Metabase serves a page outside its sign-in pages and knows the user. The host is
        // compared, not the origin: a server that upgrades http to https is still the same Metabase.
        done: async (url) => {
          const at = new URL(url);
          if (at.host !== login.host || at.pathname.startsWith(authPath)) return false;
          return (await this.whoami(host, base)) !== null;
        },
      });
    } catch (err) {
      this.set(host, base, { ...SIGNED_OUT, error: (err as Error).message, checkedAt: nowIso() });
      throw new QuiverError('REQUEST_FAILED', (err as Error).message);
    }
    const user = ok ? await this.whoami(host, base).catch(() => null) : null;
    if (user) await web.keepCookie(metabasePartition(base), base, SESSION_COOKIE, KEEP_SESSION_S).catch(() => false);
    return this.set(host, base, user ? { state: 'signed-in', user, error: null, checkedAt: nowIso() } : { ...SIGNED_OUT, error: ok ? 'Metabase did not keep the session' : null, checkedAt: nowIso() });
  }

  /** End the session on Metabase's side when it still answers, then forget it on this machine. */
  async signOut(host: HostApi, metabaseUrl: string): Promise<MetabaseSession> {
    const web = requireWeb(host);
    const base = requireBase(metabaseUrl);
    const partition = metabasePartition(base);
    await web.fetch(partition, `${base}/api/session`, { method: 'DELETE', headers: { Accept: 'application/json' }, timeoutMs: 10_000 }).catch(() => undefined);
    await web.clear(partition);
    return this.set(host, base, { ...SIGNED_OUT, checkedAt: nowIso() });
  }

  /**
   * A request with the session, answered as text with its status. A 401 is SIGN_IN_REQUIRED; any
   * other answer comes back for the caller to judge. `body` is sent as is with `contentType`; `binary`
   * answers with `bytes` instead of `text`.
   */
  async fetch(
    host: HostApi,
    metabaseUrl: string,
    path: string,
    init: { method?: string; body?: string; contentType?: string; timeoutMs?: number; binary?: boolean; connectionId?: string } = {},
  ): Promise<WebResponse> {
    const web = requireWeb(host);
    const base = requireBase(metabaseUrl);
    const res = await web
      .fetch(metabasePartition(base), `${base}${path}`, {
        method: init.method ?? 'GET',
        headers: { Accept: 'application/json', ...(init.contentType ? { 'Content-Type': init.contentType } : {}) },
        body: init.body,
        timeoutMs: init.timeoutMs,
        binary: init.binary,
      })
      .catch((err: Error) => {
        throw new QuiverError('REQUEST_FAILED', `Metabase at ${hostOf(base)} did not answer: ${err.message}`);
      });
    if (res.status === 401) {
      if (this.session(base).state !== 'signing-in') this.set(host, base, { ...SIGNED_OUT, checkedAt: nowIso() });
      throw signInRequired(base, init.connectionId);
    }
    return res;
  }

  private async whoami(host: HostApi, base: string): Promise<MetabaseUser | null> {
    try {
      const res = await this.fetch(host, base, '/api/user/current', { timeoutMs: 15_000 });
      if (res.status !== 200) return null;
      return metabaseUser(JSON.parse(res.text));
    } catch (err) {
      if (err instanceof QuiverError && err.code === 'SIGN_IN_REQUIRED') return null;
      if (err instanceof SyntaxError) return null;
      throw err;
    }
  }

  private set(host: HostApi, base: string, session: MetabaseSession): MetabaseSession {
    const partition = metabasePartition(base);
    const before = this.sessions.get(partition);
    this.sessions.set(partition, session);
    if (before?.state !== session.state || before?.user?.id !== session.user?.id || before?.error !== session.error) {
      host.emit('metabase.changed', { reason: 'session', url: base });
    }
    return session;
  }
}

/** The Metabase browser sessions of this machine. */
export const metabaseSessions = new MetabaseSessions();

function requireWeb(host: HostApi): WebSessionsApi {
  if (!host.web) throw new QuiverError('REQUEST_FAILED', 'Metabase sign-in needs the Quiver desktop app; use an API key connection instead');
  return host.web;
}

export function requireBase(metabaseUrl: string): string {
  const base = normalizeMetabaseUrl(metabaseUrl);
  if (!base) throw new QuiverError('INVALID_INPUT', 'The connection has no Metabase address yet');
  return base;
}
