import { Component, computed, inject, input, linkedSignal, output, signal } from '@angular/core';
import type { EnvDiff, EnvFileContent, EnvFileSummary } from '@quiver/core';
import { Button, EmptyState, HostBridge, Label, Select, Spinner, Toasts, invokeResource } from '@quiver/ui';
import { Plus } from 'lucide';
import { defaultAgainst } from './env-format';

type Tone = 'danger' | 'warning' | 'muted';

/** One group of keys of the comparison, with an Add button per key where adding makes sense. */
@Component({
  selector: 'section[qEnvKeyList]',
  imports: [Button],
  template: `
    @let all = keys();
    <h3 class="text-xs font-semibold" [class]="toneClass()">{{ title() }}</h3>
    <p class="text-[11px] text-muted mb-1">{{ hint() }}</p>
    @if (all.length === 0) {
      <p class="text-[11px] text-muted/70">None.</p>
    } @else {
      <ul class="flex flex-col divide-y divide-edge/60 border border-edge rounded-md">
        @for (key of all; track key) {
          <li class="flex items-center justify-between px-2 h-7 font-mono text-xs">
            <span>{{ key }}</span>
            @if (addable()) {
              <button qButton size="sm" variant="ghost" [icon]="plus" iconClass="size-3" [loading]="busy() === key" class="h-6 text-[11px]" (click)="add.emit(key)">Add</button>
            }
          </li>
        }
      </ul>
    }
  `,
})
export class EnvKeyList {
  readonly title = input.required<string>();
  readonly hint = input.required<string>();
  readonly keys = input.required<string[]>();
  readonly tone = input<Tone>('muted');
  readonly addable = input(false);
  readonly busy = input<string | null>(null);
  readonly add = output<string>();

  protected readonly plus = Plus;
  protected readonly toneClass = computed(() => {
    const some = this.keys().length > 0;
    return this.tone() === 'danger' && some ? 'text-danger' : this.tone() === 'warning' && some ? 'text-warning' : 'text-muted';
  });
}

/** Which keys this file lacks, leaves empty or adds compared with another file, and copying the missing ones over. */
@Component({
  selector: 'q-env-compare-view',
  imports: [Button, EmptyState, EnvKeyList, Label, Select, Spinner],
  templateUrl: './compare-view.html',
  host: { class: 'contents' },
})
export class EnvCompareView {
  private readonly host = inject(HostBridge);
  private readonly toasts = inject(Toasts);

  readonly content = input.required<EnvFileContent>();
  readonly files = input.required<EnvFileSummary[]>();
  readonly changed = output<void>();

  protected readonly plus = Plus;
  private readonly initial = computed(() => defaultAgainst(this.content(), this.files()));
  /** The file picked to compare with; until one is picked, the most useful one. */
  private readonly against = linkedSignal<string, string>({ source: this.initial, computation: (initial, previous) => previous?.value || initial });
  protected readonly chosen = computed(() => {
    const against = this.against();
    return against && this.files().some((f) => f.path === against) ? against : this.initial();
  });
  protected readonly diff = invokeResource<EnvDiff>('env.file.diff', () => ({ path: this.content().path, against: this.chosen() }), {
    enabled: () => Boolean(this.chosen()),
    refreshOnEvents: ['env.changed'],
  });
  protected readonly busy = signal<string | null>(null);

  protected pick(event: Event): void {
    this.against.set((event.target as HTMLSelectElement).value);
  }

  protected async add(keys?: string[]): Promise<void> {
    this.busy.set(keys ? keys.join(',') : '*');
    try {
      const out = await this.host.invoke<{ added: string[] }>('env.file.sync', { path: this.content().path, from: this.chosen(), ...(keys ? { keys } : {}) });
      this.toasts.notify(out.added.length ? `Added ${out.added.join(', ')}` : 'Nothing to add', out.added.length ? 'success' : 'info');
      this.changed.emit();
      this.diff.reload();
    } catch (err) {
      this.toasts.error(err);
    } finally {
      this.busy.set(null);
    }
  }
}
