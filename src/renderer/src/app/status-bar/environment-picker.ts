import { Component, ElementRef, Injector, afterNextRender, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import type { Environment } from '@quiver/core';
import { HostBridge, Icon, invokeResource } from '@quiver/ui';
import { Check, ChevronUp, Layers } from 'lucide';

/** The active API environment of the workspace, with a menu that opens above the bar (the native select popup ignores the theme). */
@Component({
  selector: 'q-environment-picker',
  imports: [Icon],
  templateUrl: './environment-picker.html',
  host: { class: 'relative flex items-center' },
})
export class EnvironmentPicker {
  private readonly host = inject(HostBridge);
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  private readonly menu = viewChild<ElementRef<HTMLDivElement>>('menu');

  protected readonly icons = { Check, ChevronUp, Layers };
  protected readonly open = signal(false);
  private readonly environments = invokeResource<Environment[]>('api.environment.list', () => ({}), { refreshOn: ['environments'] });
  private readonly active = invokeResource<{ id: string | null }>('api.environment.active', () => ({}), { refreshOnState: ['api.activeEnvironment'] });
  protected readonly activeId = computed(() => this.active.value()?.id ?? null);
  protected readonly current = computed(() => this.environments.value()?.find((env) => env.id === this.activeId()));
  protected readonly options = computed<{ id: string | null; name: string }[]>(() => [
    { id: null, name: 'No environment' },
    ...(this.environments.value() ?? []).map((env) => ({ id: env.id, name: env.name })),
  ]);

  constructor() {
    effect((onCleanup) => {
      if (!this.open()) return;
      const onDown = (e: MouseEvent) => {
        if (!this.element.nativeElement.contains(e.target as Node)) this.open.set(false);
      };
      const onBlur = () => this.open.set(false);
      document.addEventListener('mousedown', onDown);
      window.addEventListener('blur', onBlur);
      onCleanup(() => {
        document.removeEventListener('mousedown', onDown);
        window.removeEventListener('blur', onBlur);
      });
    });
  }

  protected toggle(): void {
    this.open.update((open) => !open);
    // Focus the active entry so the arrow keys pick up from there.
    if (untracked(this.open)) {
      afterNextRender(
        () => {
          const items = this.items();
          items[Math.max(0, untracked(this.options).findIndex((o) => o.id === untracked(this.activeId)))]?.focus();
        },
        { injector: this.injector },
      );
    }
  }

  protected pick(id: string | null): void {
    this.open.set(false);
    if (id !== untracked(this.activeId)) void this.host.invoke('api.environment.setActive', { id });
  }

  protected navigate(event: KeyboardEvent): void {
    const items = this.items();
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape') this.open.set(false);
    else if (event.key === 'ArrowDown') items[(index + 1) % items.length]?.focus();
    else if (event.key === 'ArrowUp') items[(index - 1 + items.length) % items.length]?.focus();
    else if (event.key === 'Home') items[0]?.focus();
    else if (event.key === 'End') items[items.length - 1]?.focus();
    else return;
    event.preventDefault();
  }

  private items(): HTMLButtonElement[] {
    return [...(this.menu()?.nativeElement.querySelectorAll<HTMLButtonElement>('[role=menuitemradio]') ?? [])];
  }
}
