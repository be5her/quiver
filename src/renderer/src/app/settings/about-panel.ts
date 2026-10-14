import { Component, computed, inject, signal } from '@angular/core';
import type { UpdateState } from '@quiver/core';
import { AppState, Button, Checkbox, HostBridge } from '@quiver/ui';
import { Download, ExternalLink, RotateCw } from 'lucide';
import { QuiverMark } from '../quiver-mark';
import { Updates } from '../updates';

const RELEASES_URL = 'https://github.com/be5her/quiver/releases';
const ISSUES_URL = 'https://github.com/be5her/quiver/issues';
const PLATFORM_NAMES: Record<string, string> = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };

function describeUpdate(update: UpdateState | null): string {
  if (!update) return '';
  if (!update.supported) return update.reason ?? 'Updates are not available in this build.';
  const when = update.checkedAt ? ` Checked at ${new Date(update.checkedAt).toLocaleTimeString()}.` : '';
  switch (update.status) {
    case 'idle':
      return update.channel === 'beta' && update.betaSupported
        ? 'Quiver looks for a new stable or beta build shortly after launch and every hour. Nothing is downloaded until you ask.'
        : 'Quiver looks for a new release shortly after launch and every six hours. Nothing is downloaded until you ask.';
    case 'checking':
      return 'Checking GitHub Releases…';
    case 'none':
      return `You are on the latest version.${when}`;
    case 'available':
      return `Quiver ${update.version} is available.${update.installable ? ' Download it here; it installs when you restart.' : ` ${update.reason ?? ''}`}`;
    case 'downloading': {
      const rate = update.progress?.bytesPerSecond ? ` at ${(update.progress.bytesPerSecond / 1048576).toFixed(1)} MB/s` : '';
      return `Downloading Quiver ${update.version}: ${update.progress?.percent ?? 0}%${rate}`;
    }
    case 'downloaded':
      return `Quiver ${update.version} is downloaded and installs on the next restart.`;
    case 'error':
      return `${update.error ?? 'The update check failed.'}${when}`;
  }
}

/** The running version, links, and the updater: check, download, restart to install, the beta channel. */
@Component({
  selector: 'q-about-panel',
  imports: [Button, Checkbox, QuiverMark],
  templateUrl: './about-panel.html',
  host: { class: 'flex items-start gap-4' },
})
export class AboutPanel {
  private readonly host = inject(HostBridge);
  protected readonly updates = inject(Updates);

  protected readonly icons = { Download, ExternalLink, RotateCw };
  protected readonly releasesUrl = RELEASES_URL;
  protected readonly issuesUrl = ISSUES_URL;
  protected readonly update = inject(AppState).update;
  protected readonly checking = signal(false);
  protected readonly switching = signal(false);
  protected readonly version = computed(() => this.update()?.current ?? this.host.version);
  protected readonly isBeta = computed(() => /-beta\./.test(this.version()));
  protected readonly platform = PLATFORM_NAMES[this.host.platform] ?? this.host.platform;
  protected readonly hasRelease = computed(() => this.update()?.status === 'available' || this.update()?.status === 'downloaded');
  protected readonly note = computed(() => describeUpdate(this.update()));

  protected async check(): Promise<void> {
    this.checking.set(true);
    try {
      await this.updates.check();
    } finally {
      this.checking.set(false);
    }
  }

  protected async switchChannel(event: Event): Promise<void> {
    this.switching.set(true);
    try {
      await this.updates.setChannel((event.target as HTMLInputElement).checked ? 'beta' : 'stable');
    } finally {
      this.switching.set(false);
    }
  }
}
