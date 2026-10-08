import { Component, booleanAttribute, computed, inject, input } from '@angular/core';
import { envKindLabel, type EnvFileSummary, type EnvProfileGroup } from '@quiver/core';
import { Button, Icon, IconButton, SectionHeader, Spinner, invokeResource } from '@quiver/ui';
import { Plus, RefreshCw, Trash2, TriangleAlert } from 'lucide';
import { EnvActions } from './env-actions';
import { KIND_ICON, WARNING_TITLE } from './env-format';

/** One env file: its kind, whether it is the active profile, git warnings and key count; delete on hover. */
@Component({
  selector: 'q-env-file-row',
  imports: [Icon, IconButton],
  template: `
    @let f = file();
    <svg [qIcon]="icon()" class="size-3.5 shrink-0" [class]="f.kind === 'main' ? 'text-accent' : 'text-muted'"></svg>
    <span class="truncate text-[13px] font-mono">{{ f.name }}</span>
    @if (label(); as label) {
      <span class="text-[10px] text-muted shrink-0 truncate">{{ label }}</span>
    }
    @if (active()) {
      <span class="text-[10px] rounded-full bg-success/15 text-success px-1.5 shrink-0" title=".env currently has this profile's content">active</span>
    }
    <span class="flex-1"></span>
    @if (f.warning) {
      <svg [qIcon]="icons.TriangleAlert" class="size-3.5 shrink-0" [class]="f.warning === 'tracked' ? 'text-danger' : 'text-warning'" [attr.aria-label]="warningTitle[f.warning]"></svg>
    }
    <span class="text-[10px] rounded-full bg-elevated px-1.5 text-muted shrink-0 group-hover:hidden" [title]="f.keys + ' keys, ' + f.secrets + ' secret-looking, ' + f.empty + ' empty'">{{ f.keys }}</span>
    <span class="hidden group-hover:flex items-center">
      <button qIconButton label="Delete file" size="sm" (click)="remove($event)"><svg [qIcon]="icons.Trash2" class="size-3.5"></svg></button>
    </span>
  `,
  host: {
    role: 'button',
    tabindex: '0',
    class: 'group flex items-center gap-1.5 pl-3 pr-1 h-7 cursor-pointer hover:bg-elevated min-w-0',
    'data-testid': 'env-file',
    '[attr.title]': 'title()',
    '[attr.data-path]': 'file().path',
    '[attr.data-kind]': 'file().kind',
    '[attr.data-warning]': "file().warning ?? ''",
    '(click)': 'openTab()',
    '(keydown.enter)': 'openTab()',
  },
})
export class EnvFileRow {
  private readonly env = inject(EnvActions);

  readonly file = input.required<EnvFileSummary>();
  readonly active = input(false, { transform: booleanAttribute });

  protected readonly icons = { Trash2, TriangleAlert };
  protected readonly warningTitle = WARNING_TITLE;
  protected readonly icon = computed(() => KIND_ICON[this.file().kind]);
  protected readonly label = computed(() => envKindLabel(this.file().kind, this.file().profile));
  protected readonly title = computed(() => {
    const f = this.file();
    return `${f.path} · ${f.keys} keys${f.warning ? ` · ${WARNING_TITLE[f.warning]}` : ''}`;
  });

  protected openTab(): void {
    this.env.openFileTab(this.file());
  }

  protected remove(event: Event): void {
    event.stopPropagation();
    void this.env.deleteEnvFile(this.file());
  }
}

/** The project's dotenv files, grouped by folder, with the active profile marked. */
@Component({
  selector: 'q-env-sidebar',
  imports: [Button, EnvFileRow, Icon, IconButton, SectionHeader, Spinner],
  template: `
    <q-section-header title="Env files">
      <button qIconButton label="Rescan the project" size="sm" (click)="files.reload()"><svg [qIcon]="icons.RefreshCw" class="size-3.5"></svg></button>
      <button qIconButton label="New env file" size="sm" (click)="env.createEnvFile()"><svg [qIcon]="icons.Plus" class="size-3.5"></svg></button>
    </q-section-header>
    @if (files.isLoading() && !files.value()) {
      <div class="px-3 py-2"><svg qSpinner></svg></div>
    }
    @for (group of groups(); track group.dir) {
      <div>
        @if (group.dir) {
          <div class="px-3 pt-2 pb-0.5 text-[11px] text-muted font-mono truncate" [title]="group.dir">{{ group.dir }}/</div>
        }
        @for (file of group.files; track file.path) {
          <q-env-file-row [file]="file" [active]="active().has(file.path)" />
        }
      </div>
    }
    @if (files.value() && !rootMain() && rootExample(); as example) {
      <div class="px-3 py-2">
        <button qButton size="sm" variant="secondary" [icon]="icons.Plus" data-testid="env-create-from-example" (click)="env.createEnvFile(example.path, '.env')">Create .env from {{ example.name }}</button>
      </div>
    }
    @if (files.value()?.length === 0) {
      <div class="px-3 py-2 flex flex-col gap-2">
        <p class="text-xs text-muted">No dotenv files in this project yet. Files are found up to four folders deep; node_modules and build output are skipped.</p>
        <div>
          <button qButton size="sm" variant="secondary" [icon]="icons.Plus" (click)="env.createEnvFile()">Create .env</button>
        </div>
      </div>
    }
    @if (files.error(); as error) {
      <p class="px-3 py-2 text-xs text-danger">{{ error.message }}</p>
    }
  `,
  host: { class: 'flex flex-col h-full min-h-0 overflow-y-auto text-sm' },
})
export class EnvSidebar {
  protected readonly env = inject(EnvActions);

  protected readonly icons = { Plus, RefreshCw };
  protected readonly files = invokeResource<EnvFileSummary[]>('env.file.list', () => ({}), { refreshOnEvents: ['env.changed'] });
  private readonly profiles = invokeResource<EnvProfileGroup[]>('env.profile.list', () => ({}), { refreshOnEvents: ['env.changed'] });

  private readonly list = computed(() => this.files.value() ?? []);
  protected readonly groups = computed(() => {
    const groups = new Map<string, EnvFileSummary[]>();
    for (const f of this.list()) groups.set(f.dir, [...(groups.get(f.dir) ?? []), f]);
    return [...groups.entries()].map(([dir, files]) => ({ dir, files }));
  });
  protected readonly active = computed(() => new Set((this.profiles.value() ?? []).flatMap((g) => g.profiles.filter((p) => p.active).map((p) => p.path))));
  protected readonly rootExample = computed(() => this.list().find((f) => f.dir === '' && f.kind === 'example'));
  protected readonly rootMain = computed(() => this.list().some((f) => f.dir === '' && f.kind === 'main'));
}
