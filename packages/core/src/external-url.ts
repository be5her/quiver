/** Schemes the system may open for a link: web pages and mail. Anything else could start a local program. */
export const EXTERNAL_URL_SCHEMES: readonly string[] = ['http:', 'https:', 'mailto:'];

/**
 * The link to hand to the system, or null when it may not be: an absolute http, https or mailto URL, given back as the
 * URL parser reads it. Hand over this, not the text that was checked: the parser drops spaces and control characters
 * around the link and tabs and line breaks inside it, which the system's handler would read its own way.
 */
export function safeExternalUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    return EXTERNAL_URL_SCHEMES.includes(parsed.protocol) ? parsed.href : null;
  } catch {
    return null;
  }
}

/** Whether a link may be handed to the system to open: an absolute http, https or mailto URL. */
export function isSafeExternalUrl(url: string): boolean {
  return safeExternalUrl(url) !== null;
}

/** The scheme of a link, lower case with its colon (`file:`), for messages; null when it has none. */
export function urlScheme(url: string): string | null {
  const match = /^([a-z][a-z0-9+.-]*):/i.exec(url.trimStart());
  return match ? `${match[1].toLowerCase()}:` : null;
}
