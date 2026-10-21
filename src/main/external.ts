import { shell } from 'electron';
import { isSafeExternalUrl } from '@quiver/core';

const refused = new Set<string>();

/**
 * Open a link in the system's handler, only for http, https and mailto: a `file:`, `ms-settings:` or other
 * custom-protocol link from page content (a response preview, a PR body, a log line) could start a local
 * program. Anything else is refused quietly and logged once per URL. Resolves to whether it was opened.
 */
export async function openExternal(url: string): Promise<boolean> {
  if (!isSafeExternalUrl(url)) {
    if (!refused.has(url)) {
      refused.add(url);
      console.warn(`[quiver] refused to open a link with a scheme other than http, https or mailto: ${url}`);
    }
    return false;
  }
  await shell.openExternal(url);
  return true;
}

/** Whether `openExternal` refused this URL, for the smoke test. */
export function externalUrlRefused(url: string): boolean {
  return refused.has(url);
}
