import { Component, booleanAttribute, computed, inject, input, linkedSignal, output, signal, untracked } from '@angular/core';
import { ENV_MASK, type DotenvEntry } from '@quiver/core';
import { Autofocus, Dialogs, HostBridge, Icon, IconButton, Input, Toasts } from '@quiver/ui';
import { Check, Eye, EyeOff, Trash2, X } from 'lucide';

/** One key of the table: click the value to edit it, Enter saves that line only, Escape gives up. */
@Component({
  selector: 'tr[qEnvEntry]',
  imports: [Autofocus, Icon, IconButton, Input],
  templateUrl: './entry-row.html',
  host: {
    class: 'border-t border-edge/60 hover:bg-elevated/60 group align-top',
    '[class.opacity-60]': 'entry().shadowed',
    'data-testid': 'env-entry',
    '[attr.data-key]': 'entry().key',
    '[attr.data-masked]': "masked() ? 'true' : 'false'",
  },
})
export class EnvEntryRow {
  private readonly host = inject(HostBridge);
  private readonly dialogs = inject(Dialogs);
  private readonly toasts = inject(Toasts);

  readonly path = input.required<string>();
  readonly entry = input.required<DotenvEntry>();
  readonly shown = input(false, { transform: booleanAttribute });
  readonly toggle = output<void>();
  readonly changed = output<void>();

  protected readonly icons = { Check, Eye, EyeOff, Trash2, X };
  protected readonly mask = ENV_MASK;
  protected readonly editing = signal(false);
  protected readonly saving = signal(false);
  private readonly value = computed(() => this.entry().value);
  /** What the field holds; it follows the file while the row is not being edited. */
  protected readonly draft = linkedSignal<string, string>({ source: this.value, computation: (value, previous) => (previous && untracked(this.editing) ? previous.value : value) });
  /** The value on screen: the saved one right away, until the reloaded file confirms it. */
  protected readonly display = linkedSignal<string, string>({ source: this.value, computation: (value) => value });
  protected readonly secret = computed(() => this.entry().secret && this.display() !== '');
  protected readonly masked = computed(() => this.secret() && !this.shown());

  protected typed(event: Event): void {
    this.draft.set((event.target as HTMLInputElement).value);
  }

  protected edit(): void {
    this.draft.set(this.display());
    this.editing.set(true);
  }

  protected cancel(): void {
    this.draft.set(this.value());
    this.editing.set(false);
  }

  protected keydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') void this.commit();
    if (event.key === 'Escape') this.cancel();
  }

  protected async commit(): Promise<void> {
    const draft = this.draft();
    if (draft === this.value()) {
      this.editing.set(false);
      return;
    }
    this.saving.set(true);
    try {
      await this.host.invoke('env.file.set', { path: this.path(), entries: [{ key: this.entry().key, value: draft }] });
      this.display.set(draft);
      this.editing.set(false);
      this.changed.emit();
    } catch (err) {
      this.toasts.error(err);
    } finally {
      this.saving.set(false);
    }
  }

  protected async remove(): Promise<void> {
    const key = this.entry().key;
    if (!(await this.dialogs.confirm({ title: `Remove ${key}?`, message: 'Every line defining this key is removed from the file.', danger: true, confirmLabel: 'Remove' }))) return;
    try {
      await this.host.invoke('env.file.unset', { path: this.path(), keys: [key] });
      this.changed.emit();
    } catch (err) {
      this.toasts.error(err);
    }
  }
}
