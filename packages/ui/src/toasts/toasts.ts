import { Service, signal } from '@angular/core';
import { toErrorPayload } from '@quiver/core';

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'error';
  message: string;
}

/** Short notices in the corner. Errors stay a little longer. */
@Service()
export class Toasts {
  private readonly list = signal<Toast[]>([]);
  private seq = 0;

  readonly toasts = this.list.asReadonly();

  notify(message: string, kind: Toast['kind'] = 'info'): void {
    const id = ++this.seq;
    this.list.update((toasts) => [...toasts, { id, kind, message }]);
    setTimeout(() => this.dismiss(id), kind === 'error' ? 6000 : 3000);
  }

  /** Show what went wrong, whatever was thrown. */
  error(err: unknown): void {
    this.notify(toErrorPayload(err).message, 'error');
  }

  dismiss(id: number): void {
    this.list.update((toasts) => toasts.filter((t) => t.id !== id));
  }

  /** Copy text to the clipboard and say so. */
  copy(text: string, what = 'Copied'): void {
    void navigator.clipboard.writeText(text).then(
      () => this.notify(what, 'success'),
      () => this.notify('Could not copy to the clipboard', 'error'),
    );
  }
}
