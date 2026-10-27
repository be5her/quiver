import { Component, DestroyRef, computed, inject } from '@angular/core';
import { clusterLabel, type TeleportRenewalEvent, type TeleportStatus } from '@quiver/core';
import { AppState, HostBridge, Icon, Toasts, injectHostEvent, invokeResource } from '@quiver/ui';
import { RefreshCw } from 'lucide';

/**
 * Keep me logged in, on the window's side. It tells the host whether a Quiver window is in front (a renewal that
 * opens the browser waits for that), announces renewals (a toast, and a system notification when the window is in
 * the background) so a browser window appearing is never a surprise, and shows "Teleport: renewing" in the status
 * bar while one runs or waits. Nothing otherwise.
 */
@Component({
  selector: 'q-teleport-renewal-status-item',
  imports: [Icon],
  template: `
    @if (active(); as text) {
      <button type="button" class="flex items-center gap-1 hover:text-fg" data-testid="teleport-renewal-item" [title]="text + '\nClick to open Teleport'" (click)="open()">
        <svg [qIcon]="icon" class="size-3 animate-spin"></svg>Teleport: renewing
      </button>
    }
  `,
  host: { class: 'contents' },
})
export class TeleportRenewalStatusItem {
  private readonly app = inject(AppState);
  private readonly host = inject(HostBridge);
  private readonly toasts = inject(Toasts);

  protected readonly icon = RefreshCw;
  private readonly status = invokeResource<TeleportStatus>('teleport.status', () => ({}), { workspaceId: null, refreshOnEvents: ['teleport.changed'] });
  /** What is being renewed, or null when nothing is. */
  protected readonly active = computed(() => {
    const busy = (this.status.value()?.clusters ?? []).filter((c) => c.renewal?.running || c.renewal?.waitingForFocus);
    if (!busy.length) return null;
    return busy.map((c) => `${clusterLabel(c)}: ${c.renewal?.running ? 'renewing the certificate' : 'waiting for Quiver to be in front to open the browser'}`).join('\n');
  });

  constructor() {
    const report = () => {
      const focused = document.hasFocus() && document.visibilityState === 'visible';
      this.host.invoke('teleport.window.focus', { focused }, null).catch(() => {});
    };
    window.addEventListener('focus', report);
    window.addEventListener('blur', report);
    document.addEventListener('visibilitychange', report);
    inject(DestroyRef).onDestroy(() => {
      window.removeEventListener('focus', report);
      window.removeEventListener('blur', report);
      document.removeEventListener('visibilitychange', report);
    });
    report();
    injectHostEvent('teleport.changed', (p) => {
      if (p.reason === 'renewal' && p.renewal) this.announce(p.renewal);
    });
  }

  private announce(e: TeleportRenewalEvent): void {
    switch (e.phase) {
      case 'start':
        // A certificate that is still valid is usually reissued without the browser: nothing to say until it is done.
        if (!e.browser) return;
        this.say(e, `Teleport: renewing your certificate for ${e.label}`, 'A browser window opens to sign in.');
        return;
      case 'browser':
        this.say(e, `Teleport: renewing your certificate for ${e.label}`, 'tsh opened a browser window to sign in.');
        return;
      case 'ok':
        this.toasts.notify(`Teleport: certificate for ${e.label} renewed`, 'success');
        return;
      case 'failed':
        this.toasts.notify(`Teleport: renewing the certificate for ${e.label} failed${e.message ? `: ${e.message}` : ''}`, 'error');
        return;
      case 'cancelled':
        this.toasts.notify(`Teleport: renewal for ${e.label} cancelled until you log in again`);
        return;
    }
  }

  /** A toast, and a system notification when no Quiver window is in front. */
  private say(e: TeleportRenewalEvent, title: string, body: string): void {
    this.toasts.notify(`${title}. ${body}`);
    if (!e.background || typeof Notification === 'undefined') return;
    try {
      const notification = new Notification(title, { body });
      notification.onclick = () => {
        window.focus();
        this.open();
      };
    } catch {
      // No notifications here; the toast is shown when the window comes back.
    }
  }

  protected open(): void {
    this.app.setActiveModule('teleport');
  }
}
