import { shell } from 'electron';
import { safeExternalUrl, urlScheme } from '@quiver/core';

/** The latest refused links, for the smoke test; only a few are kept. */
const refused = new Set<string>();
const REFUSED_KEPT = 50;
/** Schemes already logged, so a page full of such links logs once. */
const logged = new Set<string>();

/**
 * Open a link in the system's handler, only for http, https and mailto: a `file:`, `ms-settings:` or other
 * custom-protocol link from page content (a response preview, a PR body, a log line) could start a local
 * program. The link handed over is the one the check parsed (`safeExternalUrl`). Anything else is refused quietly and
 * its scheme logged once, never the link itself: it may carry a token or a whole `data:` page. Resolves to whether it
 * was opened.
 */
export async function openExternal(url: string): Promise<boolean> {
  const href = safeExternalUrl(url);
  if (href === null) {
    refused.delete(url);
    refused.add(url);
    if (refused.size > REFUSED_KEPT) refused.delete(refused.values().next().value!);
    const scheme = urlScheme(url) ?? 'not a URL';
    if (!logged.has(scheme) && logged.size < REFUSED_KEPT) {
      logged.add(scheme);
      console.warn(`[quiver] refused to open a link (${scheme}): only http, https and mailto links open`);
    }
    return false;
  }
  await shell.openExternal(href);
  return true;
}

/** Whether `openExternal` refused this URL lately, for the smoke test. */
export function externalUrlRefused(url: string): boolean {
  return refused.has(url);
}
