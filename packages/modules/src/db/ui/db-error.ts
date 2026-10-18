import { Component, booleanAttribute, computed, inject, input, output, signal } from '@angular/core';
import type { DbConnection, ErrorPayload } from '@quiver/core';
import { Button, HostBridge, Toasts, cn } from '@quiver/ui';
import { LogIn } from 'lucide';
import { GrafanaSignIn } from './grafana-signin';
import { TeleportLogin } from './teleport-login';

/**
 * Error box for query, table and key views. When the cause is a missing or expired Teleport
 * certificate it offers "Log in again", when it is a missing Grafana session "Sign in", and when a
 * Grafana data source came back under a new uid "Use" it; each asks for a retry afterwards.
 */
@Component({
  selector: 'q-db-error',
  imports: [Button],
  template: `
    <pre class="text-danger whitespace-pre-wrap break-words font-mono" [class]="compact() ? 'text-[11px]' : 'text-xs'">{{ error().message }}</pre>
    <div class="flex items-center gap-2">
      @if (loginRequired()) {
        <button qButton size="sm" variant="primary" [icon]="loginIcon" [loading]="busy()" (click)="relogin()">Log in again</button>
      }
      @if (grafanaUrl(); as url) {
        <button qButton size="sm" variant="primary" [icon]="loginIcon" [loading]="busy()" data-testid="db-grafana-signin" (click)="signIn(url)">Sign in to Grafana</button>
      }
      @if (moved(); as moved) {
        <button qButton size="sm" variant="primary" [loading]="busy()" data-testid="db-grafana-use-moved" (click)="useMoved(moved)">Use {{ moved.name }} ({{ moved.uid }})</button>
      }
      @if (retryable()) {
        <button qButton size="sm" variant="ghost" (click)="retry.emit()">Retry</button>
      }
    </div>
  `,
  host: { role: 'alert', '[class]': 'classes()' },
})
export class DbError {
  private readonly teleport = inject(TeleportLogin);
  private readonly grafana = inject(GrafanaSignIn);
  private readonly host = inject(HostBridge);
  private readonly toasts = inject(Toasts);

  readonly error = input.required<ErrorPayload>();
  readonly compact = input(false, { transform: booleanAttribute });
  /** Offer a Retry button; the parent re-runs its action on `retry`. */
  readonly retryable = input(true, { transform: booleanAttribute });
  readonly retry = output<void>();

  protected readonly loginIcon = LogIn;
  protected readonly busy = signal(false);
  protected readonly loginRequired = computed(() => this.error().code === 'TELEPORT_LOGIN_REQUIRED');
  protected readonly grafanaUrl = computed(() => {
    const details = this.error().details as { grafanaUrl?: unknown } | undefined;
    return this.error().code === 'SIGN_IN_REQUIRED' && typeof details?.grafanaUrl === 'string' ? details.grafanaUrl : null;
  });
  protected readonly moved = computed(() => {
    const details = this.error().details as { connectionId?: unknown; datasourceMoved?: { uid?: unknown; name?: unknown } } | undefined;
    const to = details?.datasourceMoved;
    return typeof details?.connectionId === 'string' && typeof to?.uid === 'string' ? { connectionId: details.connectionId, uid: to.uid, name: String(to.name ?? to.uid) } : null;
  });
  protected readonly classes = computed(() => cn('flex flex-col gap-2 items-start', this.compact() ? 'px-2 py-1' : 'p-3'));

  protected async signIn(grafanaUrl: string): Promise<void> {
    this.busy.set(true);
    try {
      if (await this.grafana.signIn(grafanaUrl)) this.retry.emit();
    } finally {
      this.busy.set(false);
    }
  }

  /** Point the connection at the data source's new uid, keeping the rest of its access. */
  protected async useMoved(moved: { connectionId: string; uid: string; name: string }): Promise<void> {
    this.busy.set(true);
    try {
      const conn = await this.host.invoke<DbConnection>('db.connection.get', { id: moved.connectionId });
      if (conn.access.type !== 'grafana') return;
      await this.host.invoke('db.connection.save', { connection: { ...conn, access: { ...conn.access, datasourceUid: moved.uid, datasourceName: moved.name } } });
      this.toasts.notify(`${conn.name} now uses data source ${moved.name} (${moved.uid})`, 'success');
      this.retry.emit();
    } catch (err) {
      this.toasts.error(err);
    } finally {
      this.busy.set(false);
    }
  }

  protected async relogin(): Promise<void> {
    const details = this.error().details as { proxy?: unknown } | undefined;
    const proxy = typeof details?.proxy === 'string' ? details.proxy || undefined : undefined;
    this.busy.set(true);
    try {
      if (await this.teleport.loginAgain(proxy)) this.retry.emit();
    } finally {
      this.busy.set(false);
    }
  }
}
