import { cookiesFor, expireCookies, storeCookies, type ApiResponse, type HostApi, type JarCookie, type WorkspaceApi } from '@quiver/core';
import type { CookieHooks } from './http';

/** The workspace's cookie jar, per machine under `.quiver/local`. */
export const COOKIES_DOC = 'cookies';

export async function readJar(w: WorkspaceApi): Promise<JarCookie[]> {
  return expireCookies(await w.store.readLocal<JarCookie[]>(COOKIES_DOC, []), Date.now());
}

export async function writeJar(w: WorkspaceApi, host: HostApi, jar: JarCookie[]): Promise<void> {
  await w.store.writeLocal(COOKIES_DOC, jar);
  // writeLocal does not announce itself; the cookie tab and the response pane follow the jar.
  host.emit('store.changed', { workspaceId: w.id, collection: COOKIES_DOC });
}

/**
 * A jar in memory for one send: the cookies each hop carries and the ones each hop's answer sets,
 * and what happened, for the response. \`changed\` says whether it has to be written back.
 */
export function jarSession(initial: JarCookie[]): { hooks: CookieHooks; jar(): JarCookie[]; changed(): boolean; report: NonNullable<ApiResponse['cookieJar']> } {
  let jar = initial;
  let changed = false;
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
        const result = storeCookies(jar, url, setCookies, Date.now());
        jar = result.jar;
        changed ||= result.stored.length > 0 || result.deleted.length > 0;
        report.stored.push(...result.stored);
        report.deleted.push(...result.deleted);
        report.rejected.push(...result.rejected);
      },
    },
    jar: () => jar,
    changed: () => changed,
    report,
  };
}
