import { Component, ElementRef, computed, effect, inject, input, output, signal } from '@angular/core';
import type { LogsFieldCount, LogsFilter } from '@quiver/core';
import { Autofocus, Button, Icon, IconButton, Input, Spinner, invokeResource } from '@quiver/ui';
import { ArrowLeft, Plus } from 'lucide';

/** The query a picker counts fields and values against: the last one that ran. */
export interface LogsScope {
  id: string;
  query: string;
  filters: LogsFilter[];
  from: string;
  to: string;
}

/** "+ Filter": pick a field, then one of its most common values, to keep or to leave out. */
@Component({
  selector: 'q-logs-filter-picker',
  imports: [Autofocus, Button, Icon, IconButton, Input, Spinner],
  template: `
    <button qButton size="sm" variant="ghost" [icon]="icons.Plus" data-testid="logs-add-filter" [disabled]="!scope()" (click)="toggle()">Filter</button>
    @if (open()) {
      <div class="absolute left-0 top-full mt-1 z-30 w-80 rounded-md border border-edge bg-elevated shadow-lg flex flex-col max-h-96" data-testid="logs-filter-picker">
        <div class="flex items-center gap-1 p-1.5 border-b border-edge">
          @if (field(); as f) {
            <button qIconButton label="Back to fields" size="sm" (click)="field.set(null); search.set('')"><svg [qIcon]="icons.ArrowLeft" class="size-3.5"></svg></button>
            <span class="text-xs font-mono truncate">{{ f }}</span>
          }
          <input qInput class="h-7 text-xs flex-1" [placeholder]="field() ? 'Search values' : 'Search fields'" [value]="search()" (input)="typed($event)" qAutofocus data-testid="logs-filter-search" />
        </div>
        <div class="overflow-y-auto flex-1 py-1">
          @if (loading()) {
            <div class="px-3 py-2"><svg qSpinner></svg></div>
          } @else if (failed(); as message) {
            <p class="px-3 py-2 text-xs text-danger">{{ message }}</p>
          } @else if (field()) {
            @for (v of shownValues(); track v.name) {
              <div class="group flex items-center gap-2 px-3 h-7 hover:bg-surface text-xs" data-testid="logs-filter-value" [attr.data-value]="v.name">
                <button type="button" class="flex-1 min-w-0 text-left truncate font-mono" [title]="'Keep only ' + (v.name || '(empty)')" (click)="pick(v.name, false)">{{ v.name || '(empty)' }}</button>
                <span class="text-[10px] text-muted shrink-0">{{ v.hits.toLocaleString() }}</span>
                <button type="button" class="text-[10px] text-muted hover:text-danger shrink-0 opacity-0 group-hover:opacity-100" [title]="'Leave out ' + (v.name || '(empty)')" (click)="pick(v.name, true)">exclude</button>
              </div>
            } @empty {
              <p class="px-3 py-2 text-xs text-muted">No values in this range.</p>
            }
          } @else {
            @for (f of shownFields(); track f.name) {
              <button type="button" class="w-full flex items-center gap-2 px-3 h-7 hover:bg-surface text-xs" data-testid="logs-filter-field" [attr.data-field]="f.name" (click)="field.set(f.name); search.set('')">
                <span class="flex-1 min-w-0 text-left truncate font-mono">{{ f.name }}</span>
                <span class="text-[10px] text-muted">{{ f.hits.toLocaleString() }}</span>
              </button>
            } @empty {
              <p class="px-3 py-2 text-xs text-muted">No fields in this range.</p>
            }
          }
        </div>
      </div>
    }
  `,
  host: { class: 'relative block' },
})
export class LogsFilterPicker {
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly scope = input<LogsScope | null>(null);
  readonly add = output<LogsFilter>();

  protected readonly icons = { ArrowLeft, Plus };
  protected readonly open = signal(false);
  protected readonly field = signal<string | null>(null);
  protected readonly search = signal('');

  private readonly fields = invokeResource<LogsFieldCount[]>('logs.fields', () => this.scope(), { enabled: () => this.open() && Boolean(this.scope()) });
  private readonly values = invokeResource<LogsFieldCount[]>('logs.values', () => ({ ...this.scope(), field: this.field(), limit: 100 }), {
    enabled: () => this.open() && Boolean(this.scope()) && Boolean(this.field()),
  });

  private readonly needle = computed(() => this.search().trim().toLowerCase());
  protected readonly shownFields = computed(() => (this.fields.value() ?? []).filter((f) => f.name.toLowerCase().includes(this.needle())));
  protected readonly shownValues = computed(() => (this.values.value() ?? []).filter((v) => v.name.toLowerCase().includes(this.needle())));
  protected readonly loading = computed(() => (this.field() ? this.values.isLoading() && !this.values.value() : this.fields.isLoading() && !this.fields.value()));
  protected readonly failed = computed(() => (this.field() ? this.values.error() : this.fields.error())?.message ?? null);

  constructor() {
    effect((onCleanup) => {
      if (!this.open()) return;
      const onDown = (e: MouseEvent) => {
        if (!this.element.nativeElement.contains(e.target as Node)) this.open.set(false);
      };
      const onKey = (e: KeyboardEvent) => e.key === 'Escape' && this.open.set(false);
      document.addEventListener('mousedown', onDown);
      document.addEventListener('keydown', onKey);
      onCleanup(() => {
        document.removeEventListener('mousedown', onDown);
        document.removeEventListener('keydown', onKey);
      });
    });
  }

  protected toggle(): void {
    this.open.update((o) => !o);
    this.field.set(null);
    this.search.set('');
  }

  protected typed(event: Event): void {
    this.search.set((event.target as HTMLInputElement).value);
  }

  protected pick(value: string, exclude: boolean): void {
    const field = this.field();
    if (!field) return;
    this.open.set(false);
    this.add.emit({ field, value, exclude });
  }
}
