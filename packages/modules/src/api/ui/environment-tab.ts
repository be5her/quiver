import { Component, computed, effect, inject, input, linkedSignal, resource, untracked } from '@angular/core';
import { FormField, form } from '@angular/forms/signals';
import { newEnvironment, toErrorPayload, type Environment, type Variable } from '@quiver/core';
import { Button, Checkbox, HostBridge, Input, KeyValueEditor, Spinner, TabsState, Toasts, injectHostEvent, type Tab, type TabComponent } from '@quiver/ui';
import { Save } from 'lucide';

/**
 * An environment's variables, with the ones marked secret encrypted on this machine. It follows
 * changes made elsewhere (a value edited from its hover card, an agent, the file on disk) unless it
 * has unsaved edits, which saving would then write over.
 */
@Component({
  selector: 'q-environment-tab',
  imports: [Button, Checkbox, FormField, Input, KeyValueEditor, Spinner],
  templateUrl: './environment-tab.html',
  host: { class: 'contents', '(keydown)': 'shortcut($event)' },
})
export class EnvironmentTab implements TabComponent {
  private readonly host = inject(HostBridge);
  private readonly tabs = inject(TabsState);
  private readonly toasts = inject(Toasts);

  readonly tab = input.required<Tab>();
  readonly scope = input.required<string>();

  protected readonly saveIcon = Save;
  protected readonly variableSyntax = '{{name}}';
  private readonly id = computed(() => String(this.tab().data?.['id'] ?? ''));
  private readonly stored = resource({
    params: () => ({ id: this.id() }),
    loader: ({ params }) => this.host.invoke<Environment>('api.environment.get', { id: params.id }),
  });
  protected readonly loaded = computed(() => this.stored.hasValue());
  protected readonly loadError = computed(() => (this.stored.status() === 'error' ? toErrorPayload(this.stored.error()).message : null));
  /** What the fields edit. A newer stored version replaces it while it has no unsaved edits. */
  protected readonly environment = linkedSignal<Environment | undefined, Environment>({
    source: () => (this.stored.hasValue() ? this.stored.value() : undefined),
    computation: (source, previous) => {
      if (!previous?.source) return source ?? previous?.value ?? newEnvironment('');
      const edited = JSON.stringify(previous.value) !== JSON.stringify(previous.source);
      return edited || !source ? previous.value : source;
    },
  });
  protected readonly environmentForm = form(this.environment);
  protected readonly dirty = computed(() => this.loaded() && JSON.stringify(this.environment()) !== JSON.stringify(this.stored.value()));

  constructor() {
    injectHostEvent('store.changed', (p) => {
      if (p.workspaceId !== this.scope() || p.collection !== 'environments' || this.dirty()) return;
      this.stored.reload();
    });

    effect(() => {
      const dirty = this.dirty();
      const tab = this.tab();
      if (tab.dirty !== dirty) untracked(() => this.tabs.updateTab(this.scope(), tab.id, { dirty }));
    });
  }

  protected shortcut(event: KeyboardEvent): void {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      void this.save();
    }
  }

  protected async save(): Promise<void> {
    try {
      const stored = await this.host.invoke<Environment>('api.environment.save', { environment: this.environment() });
      this.stored.set(stored);
      this.environment.set(stored);
      this.tabs.updateTab(this.scope(), this.tab().id, { title: `Env: ${stored.name}` });
      this.toasts.notify('Environment saved', 'success');
    } catch (err) {
      this.toasts.error(err);
    }
  }

  protected secretToggled(update: (patch: Partial<Variable>) => void, event: Event): void {
    update({ secret: (event.target as HTMLInputElement).checked });
  }
}
