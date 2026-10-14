import { Component, booleanAttribute, inject, input, linkedSignal, output, signal } from '@angular/core';
import { isValidDotenvKey, type DotenvEntry, type EnvFileContent } from '@quiver/core';
import { Button, HostBridge, Input, Toasts } from '@quiver/ui';
import { Plus } from 'lucide';
import { EnvEntryRow } from './entry-row';

const entryId = (e: DotenvEntry) => `${e.key}:${e.line}`;

/** The keys of a file as a table with secrets masked; values are edited in place, keys added at the bottom. */
@Component({
  selector: 'q-env-keys-view',
  imports: [Button, EnvEntryRow, Input],
  template: `
    @let c = content();
    <div class="flex-1 min-h-0 overflow-auto">
      @if (c.entries.length === 0) {
        <p class="px-3 py-3 text-xs text-muted">No keys yet. Add one below, or paste a whole file in the Text view.</p>
      } @else {
        <table class="w-full text-[12.5px] border-collapse">
          <thead class="sticky top-0 bg-canvas z-10">
            <tr class="text-[11px] uppercase tracking-wide text-muted text-left">
              <th class="px-3 py-1.5 font-medium w-[32%]">Key</th>
              <th class="px-2 py-1.5 font-medium">Value</th>
              <th class="px-2 py-1.5 font-medium w-8"></th>
            </tr>
          </thead>
          <tbody>
            @for (e of c.entries; track entryId(e)) {
              <tr qEnvEntry [path]="c.path" [entry]="e" [shown]="reveal() || revealed().has(entryId(e))" (toggle)="toggle(e)" (changed)="changed.emit()"></tr>
            }
          </tbody>
        </table>
      }
      @if (c.invalid > 0) {
        <p class="px-3 py-2 text-[11px] text-warning">{{ c.invalid }} line{{ c.invalid > 1 ? 's' : '' }} could not be parsed and {{ c.invalid > 1 ? 'are' : 'is' }} kept as is. See the Text view.</p>
      }
    </div>
    <div class="flex items-center gap-2 px-3 py-2 border-t border-edge shrink-0">
      <input qInput [value]="newKey()" placeholder="NEW_KEY" class="w-56 h-7 font-mono text-xs" data-testid="env-add-key" (input)="typedKey($event)" (keydown.enter)="add()" />
      <input qInput [value]="newValue()" placeholder="value" class="h-7 font-mono text-xs" data-testid="env-add-value" (input)="typedValue($event)" (keydown.enter)="add()" />
      <button qButton size="sm" variant="secondary" [icon]="plus" [loading]="adding()" [disabled]="!newKey().trim()" data-testid="env-add" (click)="add()">Add</button>
    </div>
  `,
  host: { class: 'flex flex-col h-full min-h-0' },
})
export class EnvKeysView {
  private readonly host = inject(HostBridge);
  private readonly toasts = inject(Toasts);

  readonly content = input.required<EnvFileContent>();
  readonly reveal = input(false, { transform: booleanAttribute });
  readonly changed = output<void>();

  protected readonly plus = Plus;
  protected readonly entryId = entryId;
  /** Values shown one by one; another file starts with all of them hidden again. */
  protected readonly revealed = linkedSignal<string, Set<string>>({ source: () => this.content().path, computation: () => new Set() });
  protected readonly newKey = signal('');
  protected readonly newValue = signal('');
  protected readonly adding = signal(false);

  protected toggle(e: DotenvEntry): void {
    this.revealed.update((shown) => {
      const next = new Set(shown);
      const id = entryId(e);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  protected typedKey(event: Event): void {
    this.newKey.set((event.target as HTMLInputElement).value.toUpperCase());
  }

  protected typedValue(event: Event): void {
    this.newValue.set((event.target as HTMLInputElement).value);
  }

  protected async add(): Promise<void> {
    const key = this.newKey().trim();
    if (!isValidDotenvKey(key)) {
      this.toasts.notify('Keys use letters, digits, _ . and - only', 'error');
      return;
    }
    if (this.content().entries.some((e) => e.key === key && !e.shadowed)) {
      this.toasts.notify(`${key} already exists; edit it in the table`, 'error');
      return;
    }
    this.adding.set(true);
    try {
      await this.host.invoke('env.file.set', { path: this.content().path, entries: [{ key, value: this.newValue() }] });
      this.changed.emit();
      this.newKey.set('');
      this.newValue.set('');
    } catch (err) {
      this.toasts.error(err);
    } finally {
      this.adding.set(false);
    }
  }
}
