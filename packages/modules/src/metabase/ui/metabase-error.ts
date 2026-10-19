import { Component, booleanAttribute, computed, inject, input, output, signal } from '@angular/core';
import type { ErrorPayload } from '@quiver/core';
import { Button, cn } from '@quiver/ui';
import { LogIn, Settings2 } from 'lucide';
import { MetabaseActions } from './metabase-actions';

/**
 * Error box for Metabase's views. A browser connection without a session offers "Sign in to Metabase",
 * an API-key connection without a working key "Open connection" to store one; then a retry.
 */
@Component({
  selector: 'q-mb-error',
  imports: [Button],
  template: `
    <pre class="text-danger whitespace-pre-wrap break-words font-mono" [class]="compact() ? 'text-[11px]' : 'text-xs'">{{ error().message }}</pre>
    <div class="flex items-center gap-2">
      @if (signInId(); as connectionId) {
        <button qButton size="sm" variant="primary" [icon]="icons.LogIn" [loading]="busy()" data-testid="mb-error-signin" (click)="signIn(connectionId)">Sign in to Metabase</button>
      }
      @if (keyId(); as connectionId) {
        <button qButton size="sm" variant="primary" [icon]="icons.Settings2" data-testid="mb-error-open-connection" (click)="openConnection(connectionId)">Open connection</button>
      }
      @if (retryable()) {
        <button qButton size="sm" variant="ghost" data-testid="mb-error-retry" (click)="retry.emit()">Retry</button>
      }
    </div>
  `,
  host: { role: 'alert', 'data-testid': 'mb-error', '[attr.data-code]': 'error().code', '[class]': 'classes()' },
})
export class MetabaseError {
  private readonly metabase = inject(MetabaseActions);

  readonly error = input.required<ErrorPayload>();
  /** The connection the view is on, when the error does not name it. */
  readonly connectionId = input<string | null>(null);
  readonly compact = input(false, { transform: booleanAttribute });
  /** Offer a Retry button; the parent re-runs its action on `retry`. */
  readonly retryable = input(true, { transform: booleanAttribute });
  readonly retry = output<void>();

  protected readonly icons = { LogIn, Settings2 };
  protected readonly busy = signal(false);
  private readonly details = computed(() => (this.error().details ?? {}) as { metabaseUrl?: unknown; connectionId?: unknown });
  private readonly errorConnectionId = computed(() => {
    const id = this.details().connectionId;
    return typeof id === 'string' ? id : this.connectionId();
  });
  protected readonly signInId = computed(() => (this.error().code === 'SIGN_IN_REQUIRED' && typeof this.details().metabaseUrl === 'string' ? this.errorConnectionId() : null));
  protected readonly keyId = computed(() => (this.error().code === 'AUTH_REQUIRED' || this.error().code === 'AUTH_FAILED' ? this.errorConnectionId() : null));
  protected readonly classes = computed(() => cn('flex flex-col gap-2 items-start', this.compact() ? 'px-2 py-1' : 'p-3'));

  protected async signIn(connectionId: string): Promise<void> {
    this.busy.set(true);
    try {
      if (await this.metabase.signIn({ id: connectionId })) this.retry.emit();
    } finally {
      this.busy.set(false);
    }
  }

  protected openConnection(connectionId: string): void {
    this.metabase.openConnectionTab({ id: connectionId, name: 'Metabase' });
  }
}
