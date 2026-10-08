import { Component, computed, inject, input } from '@angular/core';
import { Icon, IconButton, Toasts } from '@quiver/ui';
import { Copy } from 'lucide';

/** What `tsh login` printed, with a copy button. */
@Component({
  selector: 'q-teleport-login-log',
  imports: [Icon, IconButton],
  template: `
    <pre class="max-h-40 overflow-auto rounded border border-edge bg-surface p-1.5 pr-7 text-[10px] font-mono whitespace-pre-wrap break-all text-muted" data-testid="teleport-login-log">{{ text() }}</pre>
    <button qIconButton label="Copy output" size="sm" class="absolute top-0.5 right-0.5" (click)="copy()"><svg [qIcon]="copyIcon" class="size-3"></svg></button>
  `,
  host: { class: 'block relative mt-1' },
})
export class TeleportLoginLog {
  private readonly toasts = inject(Toasts);

  readonly lines = input.required<string[]>();

  protected readonly copyIcon = Copy;
  protected readonly text = computed(() => this.lines().join('\n'));

  protected copy(): void {
    this.toasts.copy(this.text());
  }
}
