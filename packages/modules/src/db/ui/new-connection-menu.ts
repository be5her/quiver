import { Component, ElementRef, effect, inject, signal } from '@angular/core';
import { DB_KIND_LABELS, type DbKind } from '@quiver/core';
import { Icon, IconButton } from '@quiver/ui';
import { Plus } from 'lucide';
import { DbActions } from './db-actions';
import { KindIcon } from './kind-icon';

/** The + of the Connections header: pick the kind of the new connection. */
@Component({
  selector: 'q-db-new-connection-menu',
  imports: [Icon, IconButton, KindIcon],
  template: `
    <button qIconButton label="New connection" size="sm" (click)="open.set(!open())"><svg [qIcon]="plus" class="size-3.5"></svg></button>
    @if (open()) {
      <div class="absolute right-0 top-full mt-1 z-20 min-w-36 rounded-md border border-edge bg-elevated shadow-lg py-1 normal-case tracking-normal font-normal">
        @for (kind of kinds; track kind) {
          <button type="button" class="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-fg hover:bg-surface" (click)="pick(kind)"><svg [qKindIcon]="kind"></svg> {{ labels[kind] }}</button>
        }
      </div>
    }
  `,
  host: { class: 'relative block' },
})
export class NewConnectionMenu {
  private readonly db = inject(DbActions);
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);

  protected readonly plus = Plus;
  protected readonly kinds: DbKind[] = ['mysql', 'sqlite', 'redis'];
  protected readonly labels = DB_KIND_LABELS;
  protected readonly open = signal(false);

  constructor() {
    effect((onCleanup) => {
      if (!this.open()) return;
      const onDown = (e: MouseEvent) => {
        if (!this.element.nativeElement.contains(e.target as Node)) this.open.set(false);
      };
      document.addEventListener('mousedown', onDown);
      onCleanup(() => document.removeEventListener('mousedown', onDown));
    });
  }

  protected pick(kind: DbKind): void {
    this.open.set(false);
    this.db.openNewConnectionTab(kind);
  }
}
