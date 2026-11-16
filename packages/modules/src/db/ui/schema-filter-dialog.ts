import { Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { dbDataCollection, schemaNoun, type DbConnectionSummary } from '@quiver/core';
import { Autofocus, Button, Checkbox, Icon, Input, Spinner, invokeResource } from '@quiver/ui';
import { Search } from 'lucide';
import { DbError } from './db-error';
import { DbSchemaFilterState } from './schema-filter-state';

/**
 * Filter schemas: tick the schemas (PostgreSQL) or databases (MySQL) the tree shows under one connection. The search
 * narrows the list, and Select all / none act on what it shows. Ticking every one removes the filter; otherwise only
 * the ticked ones show, so a schema created later stays hidden until it is ticked here.
 */
@Component({
  selector: 'q-db-schema-filter-dialog',
  imports: [Autofocus, Button, Checkbox, DbError, Icon, Input, Spinner],
  template: `
    @let conn = connection();
    <div class="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[12vh]" (mousedown)="closed.emit()">
      <form
        class="w-[440px] max-w-[92vw] rounded-lg border border-edge bg-canvas shadow-xl p-4 flex flex-col gap-3"
        role="dialog"
        aria-modal="true"
        [attr.aria-label]="'Filter ' + noun()"
        data-testid="db-schema-filter-dialog"
        (mousedown)="$event.stopPropagation()"
        (submit)="apply($event)"
      >
        <div>
          <h2 class="text-sm font-semibold">Filter {{ noun() }} of {{ conn.name }}</h2>
          <p class="text-xs text-muted mt-0.5">
            The tree shows only the ticked {{ noun() }}, on this machine. {{ capitalNoun() }} created later stay hidden until you tick them; ticking them all
            removes the filter. Queries, the schema search and agents still see every one.
          </p>
        </div>
        @if (databases.error(); as error) {
          <q-db-error [error]="error" compact (retry)="databases.reload()" />
        } @else if (databases.value(); as list) {
          <div class="relative">
            <svg [qIcon]="icons.Search" class="size-3.5 text-muted absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"></svg>
            <input
              qInput
              qAutofocus
              class="pl-8"
              [value]="search()"
              [placeholder]="'Search ' + list.length + ' ' + noun()"
              [attr.aria-label]="'Search ' + noun()"
              data-testid="db-schema-filter-search"
              (input)="typed($event)"
              (keydown.enter)="$event.preventDefault()"
            />
          </div>
          <div class="flex items-center gap-3 text-xs">
            <button type="button" class="text-accent hover:underline disabled:opacity-40 disabled:no-underline" [disabled]="!shown().length" data-testid="db-schema-filter-all" (click)="setShown(true)">
              Select all{{ search().trim() ? ' matching' : '' }}
            </button>
            <button type="button" class="text-accent hover:underline disabled:opacity-40 disabled:no-underline" [disabled]="!shown().length" data-testid="db-schema-filter-none" (click)="setShown(false)">
              Select none{{ search().trim() ? ' matching' : '' }}
            </button>
            <span class="ml-auto text-muted" data-testid="db-schema-filter-count">{{ ticked().size }} of {{ list.length }} shown</span>
          </div>
          <div class="max-h-[40vh] overflow-y-auto rounded-md border border-edge py-1" role="group" [attr.aria-label]="capitalNoun()">
            @for (name of shown(); track name) {
              <label class="flex items-center gap-2 px-2.5 h-7 text-[13px] cursor-pointer hover:bg-elevated" data-testid="db-schema-filter-option">
                <input type="checkbox" qCheckbox [checked]="ticked().has(name)" (change)="toggle(name)" />
                <span class="truncate">{{ name }}</span>
              </label>
            } @empty {
              <p class="px-2.5 py-1 text-xs text-muted">{{ list.length ? 'No ' + noun() + ' match' : 'No ' + noun() }}</p>
            }
          </div>
        } @else {
          <div class="flex items-center h-16 justify-center"><svg qSpinner></svg></div>
        }
        <div class="flex items-center gap-2 mt-1">
          @if (hasFilter()) {
            <button qButton type="button" variant="ghost" [disabled]="!filters.ready()" data-testid="db-schema-filter-clear" (click)="clear()">Show all</button>
          }
          <span class="flex-1 text-xs text-muted text-right">
            @if (databases.value() && !ticked().size) {
              Tick at least one.
            }
          </span>
          <button qButton type="button" variant="ghost" (click)="closed.emit()">Cancel</button>
          <button qButton type="submit" variant="primary" [disabled]="!databases.value() || !ticked().size || !filters.ready()" data-testid="db-schema-filter-apply">Apply</button>
        </div>
      </form>
    </div>
  `,
  // On the document: while the list loads or failed to, focus is not in the form, and Escape must still close it.
  host: { class: 'contents', '(document:keydown.escape)': 'closed.emit()' },
})
export class SchemaFilterDialog {
  protected readonly filters = inject(DbSchemaFilterState);

  readonly connection = input.required<DbConnectionSummary>();
  readonly closed = output<void>();

  protected readonly icons = { Search };
  protected readonly databases = invokeResource<string[]>('db.schema.databases', () => ({ connectionId: this.connection().id }), {
    refreshOn: () => [dbDataCollection(this.connection().id)],
  });
  protected readonly noun = computed(() => schemaNoun(this.connection().kind));
  protected readonly capitalNoun = computed(() => this.noun().charAt(0).toUpperCase() + this.noun().slice(1));
  protected readonly hasFilter = computed(() => this.filters.pickedFor(this.connection().id) !== null);
  protected readonly search = signal('');
  protected readonly ticked = signal<ReadonlySet<string>>(new Set());
  protected readonly shown = computed(() => {
    const list = this.databases.value() ?? [];
    const needle = this.search().trim().toLowerCase();
    return needle ? list.filter((name) => name.toLowerCase().includes(needle)) : list;
  });
  private seeded = false;

  constructor() {
    // Once the list is in: the saved picks, or every schema when there is no filter yet.
    effect(() => {
      const list = this.databases.value();
      if (!list || this.seeded) return;
      this.seeded = true;
      const picked = untracked(() => this.filters.pickedFor(this.connection().id));
      this.ticked.set(new Set(picked ? list.filter((name) => picked.includes(name)) : list));
    });
  }

  protected typed(event: Event): void {
    this.search.set((event.target as HTMLInputElement).value);
  }

  protected toggle(name: string): void {
    this.ticked.update((set) => {
      const next = new Set(set);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  /** Tick or untick every schema the search shows. */
  protected setShown(on: boolean): void {
    const shown = this.shown();
    this.ticked.update((set) => {
      const next = new Set(set);
      for (const name of shown) {
        if (on) next.add(name);
        else next.delete(name);
      }
      return next;
    });
  }

  protected apply(event: Event): void {
    event.preventDefault();
    const list = this.databases.value();
    const ticked = this.ticked();
    if (!list || !ticked.size) return;
    // Every one ticked is no filter: schemas created later show too.
    const all = list.every((name) => ticked.has(name));
    this.filters.set(this.connection().id, all ? null : list.filter((name) => ticked.has(name)));
    this.closed.emit();
  }

  protected clear(): void {
    this.filters.set(this.connection().id, null);
    this.closed.emit();
  }
}
