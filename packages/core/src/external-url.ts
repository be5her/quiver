/** Schemes the system may open for a link: web pages and mail. Anything else could start a local program. */
export const EXTERNAL_URL_SCHEMES: readonly string[] = ['http:', 'https:', 'mailto:'];

/** Whether a link may be handed to the system to open: an absolute http, https or mailto URL. */
export function isSafeExternalUrl(url: string): boolean {
  try {
    return EXTERNAL_URL_SCHEMES.includes(new URL(url).protocol);
  } catch {
    return false;
  }
}
