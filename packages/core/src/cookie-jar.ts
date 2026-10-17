import { cookieExpiry, parseSetCookie } from './cookies';

/** A cookie the jar keeps. Times are epoch milliseconds. */
export interface JarCookie {
  name: string;
  value: string;
  /** Lower case, without a leading dot: the host for a host-only cookie, else the Domain attribute. */
  domain: string;
  /** True when the server gave no Domain: the cookie goes to that exact host only. */
  hostOnly: boolean;
  path: string;
  /** Null for a session cookie, kept until the jar is cleared. */
  expiresAt: number | null;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: string;
  createdAt: number;
}

export interface StoreResult {
  jar: JarCookie[];
  /** Names stored or replaced. */
  stored: string[];
  /** Names deleted by an expiry in the past (Max-Age=0). */
  deleted: string[];
  rejected: { name: string; reason: string }[];
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

function isIp(host: string): boolean {
  return IPV4.test(host) || host.includes(':');
}

function isLoopback(host: string): boolean {
  return host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '[::1]' || host === '::1';
}

/** RFC 6265 5.1.3: the host is the domain, or a subdomain of it (never for an IP address). */
export function domainMatches(host: string, domain: string): boolean {
  if (host === domain) return true;
  return !isIp(host) && host.endsWith(`.${domain}`);
}

/** RFC 6265 5.1.4: the default path is the request path up to, not including, its last slash. */
export function defaultCookiePath(requestPath: string): string {
  if (!requestPath.startsWith('/')) return '/';
  const last = requestPath.lastIndexOf('/');
  return last <= 0 ? '/' : requestPath.slice(0, last);
}

/** RFC 6265 5.1.4: the cookie path is the request path, or a prefix of it ending at a slash. */
export function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/';
}

function parsedUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/**
 * Store the Set-Cookie headers a response to \`url\` carried: a cookie replaces the one with the same
 * name, domain and path; one already expired (Max-Age=0, an Expires in the past) deletes it. A Domain
 * the host is not inside, or one without a dot other than the host itself, is rejected.
 */
export function storeCookies(jar: JarCookie[], url: string, setCookies: string[], now: number): StoreResult {
  const result: StoreResult = { jar: [...jar], stored: [], deleted: [], rejected: [] };
  const target = parsedUrl(url);
  if (!target) return result;
  const host = target.hostname.toLowerCase();
  for (const header of setCookies) {
    const parsed = parseSetCookie(header);
    if (!parsed) continue;
    let domain = host;
    let hostOnly = true;
    if (parsed.domain) {
      const wanted = parsed.domain.toLowerCase();
      if (!domainMatches(host, wanted)) {
        result.rejected.push({ name: parsed.name, reason: `Domain ${wanted} does not contain ${host}` });
        continue;
      }
      if (!wanted.includes('.') && wanted !== host) {
        result.rejected.push({ name: parsed.name, reason: `Domain ${wanted} is too broad` });
        continue;
      }
      domain = wanted;
      hostOnly = false;
    }
    const path = parsed.path ?? defaultCookiePath(target.pathname);
    const expiresAt = cookieExpiry(parsed, now);
    const same = (c: JarCookie) => c.name === parsed.name && c.domain === domain && c.path === path;
    const previous = result.jar.find(same);
    result.jar = result.jar.filter((c) => !same(c));
    if (expiresAt !== null && expiresAt <= now) {
      if (previous) result.deleted.push(parsed.name);
      continue;
    }
    result.jar.push({
      name: parsed.name,
      value: parsed.value,
      domain,
      hostOnly,
      path,
      expiresAt,
      secure: parsed.secure,
      httpOnly: parsed.httpOnly,
      ...(parsed.sameSite ? { sameSite: parsed.sameSite } : {}),
      createdAt: previous?.createdAt ?? now,
    });
    result.stored.push(parsed.name);
  }
  return result;
}

/** The jar without cookies that have expired. */
export function expireCookies(jar: JarCookie[], now: number): JarCookie[] {
  return jar.filter((c) => c.expiresAt === null || c.expiresAt > now);
}

/**
 * The cookies a request to \`url\` carries, in the order RFC 6265 asks: longer paths first, then
 * older ones. Secure cookies go only over https, or to a loopback host.
 */
export function cookiesFor(jar: JarCookie[], url: string, now: number): JarCookie[] {
  const target = parsedUrl(url);
  if (!target) return [];
  const host = target.hostname.toLowerCase();
  const secureOk = target.protocol === 'https:' || isLoopback(host);
  return expireCookies(jar, now)
    .filter((c) => (c.hostOnly ? host === c.domain : domainMatches(host, c.domain)) && pathMatches(target.pathname || '/', c.path) && (!c.secure || secureOk))
    .sort((a, b) => b.path.length - a.path.length || a.createdAt - b.createdAt);
}

/**
 * A Cookie header value with the jar's cookies added to the one the request already has; a name
 * the request sets itself keeps the request's value. Null when there is nothing to send.
 */
export function mergeCookieHeader(existing: string | null, cookies: Pick<JarCookie, 'name' | 'value'>[]): string | null {
  const own = (existing ?? '')
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean);
  const names = new Set(own.map((p) => p.split('=')[0].trim()));
  const added = cookies.filter((c) => !names.has(c.name)).map((c) => `${c.name}=${c.value}`);
  const all = [...own, ...added];
  return all.length ? all.join('; ') : null;
}
