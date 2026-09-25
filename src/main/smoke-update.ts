import { writeSync } from 'node:fs';
import type { UpdatesApi } from '@quiver/core';

/**
 * Drives the real updater against a local feed. Used to verify a packaged build:
 *
 *   QUIVER_SMOKE=1 QUIVER_UPDATE_FEED=http://127.0.0.1:8123/ release/win-unpacked/Quiver.exe
 *
 * where the feed serves electron-builder's output for a newer version (latest*.yml plus the
 * installer). Checks, downloads and verifies the update; never installs it.
 */
export async function runUpdateSmoke(updates: UpdatesApi): Promise<number> {
  const failures: string[] = [];
  let passes = 0;
  const check = (name: string, ok: boolean, detail?: unknown) => {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ''}`);
    if (ok) passes++;
    else failures.push(name);
  };

  try {
    const start = updates.state();
    check('update: build with a feed reports supported', start.supported === true && start.status === 'idle', { supported: start.supported, status: start.status, current: start.current });
    const checked = await updates.check('manual');
    check(
      'update: check finds a newer version on the feed',
      checked.status === 'available' && typeof checked.version === 'string' && checked.version !== checked.current,
      { status: checked.status, current: checked.current, version: checked.version, error: checked.error },
    );
    if (checked.status === 'available' && checked.installable) {
      const downloaded = await updates.download();
      check('update: download completes and the checksum verifies', downloaded.status === 'downloaded' && downloaded.version === checked.version, { status: downloaded.status, error: downloaded.error });
    } else if (checked.status === 'available') {
      const refused = await updates.download().then(
        () => false,
        () => true,
      );
      check('update: download is refused where the build cannot replace itself', refused, { reason: checked.reason });
    }
  } catch (err) {
    check(`unexpected error: ${(err as Error).message}`, false);
  }

  const summary = failures.length ? `UPDATE SMOKE FAILED: ${failures.join(', ')}` : `UPDATE SMOKE PASSED (${passes} checks)`;
  try {
    writeSync(1, `${summary}\n`);
  } catch {
    console.log(summary);
  }
  return failures.length ? 1 : 0;
}
