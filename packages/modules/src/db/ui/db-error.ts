import { Component, booleanAttribute, computed, inject, input, output, signal } from '@angular/core';
import type { ErrorPayload } from '@quiver/core';
import { Button, cn } from '@quiver/ui';
import { LogIn } from 'lucide';
import { TeleportLogin } from './teleport-login';

/**
 * Error box for query, table and key views. When the cause is a missing or expired Teleport
 * certificate it offers "Log in again" and asks for a retry afterwards.
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
      @if (retryable()) {
        <button qButton size="sm" variant="ghost" (click)="retry.emit()">Retry</button>
      }
    </div>
  `,
  host: { role: 'alert', '[class]': 'classes()' },
})
export class DbError {
  private readonly teleport = inject(TeleportLogin);

  readonly error = input.required<ErrorPayload>();
  readonly compact = input(false, { transform: booleanAttribute });
  /** Offer a Retry button; the parent re-runs its action on `retry`. */
  readonly retryable = input(true, { transform: booleanAttribute });
  readonly retry = output<void>();

  protected readonly loginIcon = LogIn;
  protected readonly busy = signal(false);
  protected readonly loginRequired = computed(() => this.error().code === 'TELEPORT_LOGIN_REQUIRED');
  protected readonly classes = computed(() => cn('flex flex-col gap-2 items-start', this.compact() ? 'px-2 py-1' : 'p-3'));

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
