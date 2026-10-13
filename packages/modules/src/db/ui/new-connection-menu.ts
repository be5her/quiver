import { Component, ElementRef, effect, inject, signal } from '@angular/core';
import { DB_KIND_LABELS, parseConnectionUrl, type DbKind } from '@quiver/core';
import { Dialogs, Icon, IconButton, Toasts } from '@quiver/ui';
import { Link2, Plus } from 'lucide';
import { DbActions } from './db-actions';
import { KindIcon } from './kind-icon';

/** The + of the Connections header: pick the kind of the new connection, or paste a URL. */
@Component({
  selector: 'q-db-new-connection-menu',
  imports: [Icon, IconButton, KindIcon],
  template: `
    <button qIconButton label="New connection" size="sm" (click)="open.set(!open())"><svg [qIcon]="icons.Plus" class="size-3.5"></svg></button>
    @if (open()) {
      <div class="absolute right-0 top-full mt-1 z-20 min-w-40 rounded-md border border-edge bg-elevated shadow-lg py-1 normal-case tracking-normal font-normal">
        @for (kind of kinds; track kind) {
          <button type="button" class="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-fg hover:bg-surface" (click)="pick(kind)"><svg [qKindIcon]="kind"></svg> {{ labels[kind] }}</button>
        }
        <div class="my-1 h-px bg-edge"></div>
        <button type="button" class="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-fg hover:bg-surface" data-testid="db-new-from-url" (click)="fromUrl()"><svg [qIcon]="icons.Link2" class="size-3.5 text-muted"></svg> From URL…</button>
      </div>
    }
  `,
  host: { class: 'relative block' },
})
export class NewConnectionMenu {
  private readonly db = inject(DbActions);
  private readonly dialogs = inject(Dialogs);
  private readonly toasts = inject(Toasts);
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);

  protected readonly icons = { Link2, Plus };
  protected readonly kinds: DbKind[] = ['mysql', 'postgres', 'sqlite', 'redis'];
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

  protected async fromUrl(): Promise<void> {
    this.open.set(false);
    const url = await this.dialogs.prompt({ title: 'New connection from a URL', label: 'URL', placeholder: 'mysql://user:password@host:3306/db', confirmLabel: 'Create' });
    if (!url?.trim()) return;
    const parsed = parseConnectionUrl(url);
    if (!parsed) {
      this.toasts.notify('Not a database URL: expected mysql://, postgres://, redis:// or a SQLite file', 'error');
      return;
    }
    this.db.openNewConnectionTab(parsed.connection.kind, { url: url.trim() });
  }
}
