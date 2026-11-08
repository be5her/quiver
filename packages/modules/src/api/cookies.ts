import { QuiverError, cookiesFor, expireCookies, storeCookies, type ApiResponse, type HostApi, type JarCookie, type WorkspaceApi } from '@quiver/core';
import type { CookieHooks } from './http';

/** The workspace's cookie jar, per machine under `.quiver/local`. */
export const COOKIES_DOC = 'cookies';

/** The file: the jar's JSON encrypted with the OS keychain, like OAuth tokens. A jar written before that is a plain array, read once and rewritten encrypted. */
interface JarDoc {
  cipher: string;
}

/**
 * Jars kept in memory, by workspace, by a host that cannot read the one on disk because the app encrypted it
 * there (the headless CLI): the run gets its own jar, and the app's cookies are neither read nor replaced.
 */
const sealedJars = new Map<string, JarCookie[]>();

/** Whether the jar on disk is one this host cannot decrypt, though the app on this machine can. */
function sealed(host: HostApi, doc: JarDoc | JarCookie[]): boolean {
  if (Array.isArray(doc) || !doc || typeof doc.cipher !== 'string') return false;
  try {
    host.secrets.decrypt(doc.cipher);
    return false;
  } catch (err) {
    return err instanceof QuiverError && err.code === 'SECRET_UNAVAILABLE';
  }
}

export async function readJar(w: WorkspaceApi, host: HostApi): Promise<JarCookie[]> {
  const doc = await w.store.readLocal<JarDoc | JarCookie[]>(COOKIES_DOC, []);
  let jar: unknown = [];
  if (Array.isArray(doc)) jar = doc;
  else if (doc && typeof doc.cipher === 'string') {
    try {
      jar = JSON.parse(host.secrets.decrypt(doc.cipher));
    } catch (err) {
      // Sealed for the app on this machine: this run's own jar. Otherwise written on another machine, or by
      // another user: there is no reading it, and the next write replaces it.
      jar = err instanceof QuiverError && err.code === 'SECRET_UNAVAILABLE' ? (sealedJars.get(w.id) ?? []) : [];
    }
  }
  return expireCookies(Array.isArray(jar) ? (jar as JarCookie[]) : [], Date.now());
}

async function writeJar(w: WorkspaceApi, host: HostApi, jar: JarCookie[]): Promise<void> {
  if (sealed(host, await w.store.readLocal<JarDoc | JarCookie[]>(COOKIES_DOC, []))) sealedJars.set(w.id, jar);
  else await w.store.writeLocal<JarDoc>(COOKIES_DOC, { cipher: host.secrets.encrypt(JSON.stringify(jar)) });
  // writeLocal does not announce itself; the cookie tab and the response pane follow the jar.
  host.emit('store.changed', { workspaceId: w.id, collection: COOKIES_DOC });
}

const jarWrites = new Map<string, Promise<void>>();

/**
 * Change the jar under a per-workspace lock: `change` gets the jar as it is on disk now and returns
 * the one to keep (null to leave it). Two sends finishing together each add their cookies to the
 * other's, rather than the later one writing over the earlier.
 */
export async function updateJar(w: WorkspaceApi, host: HostApi, change: (jar: JarCookie[]) => JarCookie[] | null): Promise<void> {
  const previous = jarWrites.get(w.id) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      const changed = change(await readJar(w, host));
      if (changed) await writeJar(w, host, changed);
    });
  jarWrites.set(w.id, next);
  try {
    await next;
  } finally {
    if (jarWrites.get(w.id) === next) jarWrites.delete(w.id);
  }
}

/**
 * A jar in memory for one send: the cookies each hop carries and the ones each hop's answer sets,
 * and what happened, for the response. `changed` says whether anything was set, and `apply` puts
 * what the answers set onto a jar, in order, as they were stored here.
 */
export function jarSession(initial: JarCookie[]): { hooks: CookieHooks; apply(jar: JarCookie[]): JarCookie[]; changed(): boolean; report: NonNullable<ApiResponse['cookieJar']> } {
  let jar = initial;
  let changed = false;
  const stores: { url: string; setCookies: string[]; at: number }[] = [];
  const report: NonNullable<ApiResponse['cookieJar']> = { sent: [], stored: [], deleted: [], rejected: [] };
  return {
    hooks: {
      cookiesFor(url) {
        const cookies = cookiesFor(jar, url, Date.now());
        for (const c of cookies) if (!report.sent.includes(c.name)) report.sent.push(c.name);
        return cookies;
      },
      store(url, setCookies) {
        if (!setCookies.length) return;
        const at = Date.now();
        const result = storeCookies(jar, url, setCookies, at);
        jar = result.jar;
        changed ||= result.stored.length > 0 || result.deleted.length > 0;
        if (result.stored.length || result.deleted.length) stores.push({ url, setCookies, at });
        report.stored.push(...result.stored);
        report.deleted.push(...result.deleted);
        report.rejected.push(...result.rejected);
      },
    },
    apply: (target) => stores.reduce((acc, s) => storeCookies(acc, s.url, s.setCookies, s.at).jar, target),
    changed: () => changed,
    report,
  };
}
