/** One `Set-Cookie` header, read the way RFC 6265 describes. */
export interface SetCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  /** The Expires attribute as the server wrote it. */
  expires?: string;
  /** Seconds; Max-Age wins over Expires. */
  maxAge?: number;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: string;
}

/** Null when the header has no `name=value` pair to read. Unknown attributes are ignored. */
export function parseSetCookie(header: string): SetCookie | null {
  const [pair, ...attributes] = header.split(';');
  const eq = pair.indexOf('=');
  if (eq < 0) return null;
  const name = pair.slice(0, eq).trim();
  if (!name) return null;
  let value = pair.slice(eq + 1).trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
  const cookie: SetCookie = { name, value, secure: false, httpOnly: false };
  for (const attribute of attributes) {
    const at = attribute.indexOf('=');
    const key = (at < 0 ? attribute : attribute.slice(0, at)).trim().toLowerCase();
    const val = at < 0 ? '' : attribute.slice(at + 1).trim();
    switch (key) {
      case 'domain':
        if (val) cookie.domain = val.replace(/^\./, '').toLowerCase();
        break;
      case 'path':
        if (val.startsWith('/')) cookie.path = val;
        break;
      case 'expires':
        if (val) cookie.expires = val;
        break;
      case 'max-age':
        if (/^-?\d+$/.test(val)) cookie.maxAge = Number(val);
        break;
      case 'secure':
        cookie.secure = true;
        break;
      case 'httponly':
        cookie.httpOnly = true;
        break;
      case 'samesite':
        if (val) cookie.sameSite = val[0].toUpperCase() + val.slice(1).toLowerCase();
        break;
    }
  }
  return cookie;
}

/**
 * When the cookie expires, in epoch milliseconds: from Max-Age (counted from `now`) or else Expires.
 * Null for a session cookie, or an Expires that cannot be read. Zero or less means delete it now.
 */
export function cookieExpiry(cookie: SetCookie, now: number): number | null {
  if (cookie.maxAge !== undefined) return cookie.maxAge <= 0 ? 0 : now + cookie.maxAge * 1000;
  if (cookie.expires) {
    const at = Date.parse(cookie.expires);
    return Number.isNaN(at) ? null : at;
  }
  return null;
}
