import { Component, computed, inject, input, linkedSignal } from '@angular/core';
import type { GitDiffFile, GitStatus } from '@quiver/core';
import { Button, Icon, Spinner, invokeResource, type Tab, type TabComponent } from '@quiver/ui';
import { FileDiff, Plus, RefreshCw } from 'lucide';
import { GitDiffView } from './diff-view';
import { GitActions } from './git-actions';
import { injectGitChanged, injectReloadWhenShown, tabVisible } from './git-events';
import type { DiffSource, GitShowResult } from './git-format';

/** A diff: working or staged changes (one file or all of them), or a commit. */
@Component({
  selector: 'q-git-diff-tab',
  imports: [Button, GitDiffView, Icon, Spinner],
  template: `
    <div class="flex flex-col h-full min-h-0 w-full" data-testid="git-diff-tab" [attr.data-kind]="source().kind" [attr.data-path]="source().path ?? ''">
      <div class="flex items-center gap-2 px-3 h-10 border-b border-edge shrink-0">
        <svg [qIcon]="icons.FileDiff" class="size-4 text-accent shrink-0"></svg>
        <span class="font-medium text-sm truncate min-w-0" [title]="heading()">{{ heading() }}</span>
        <span class="text-xs text-muted truncate">{{ subheading() }}</span>
        <span class="flex-1"></span>
        @if (untracked()) {
          <button qButton size="sm" variant="secondary" [icon]="icons.Plus" data-testid="git-diff-stage" (click)="stageUntracked()">Stage</button>
        }
        @if (local()) {
          <button qButton size="sm" variant="ghost" [icon]="icons.RefreshCw" [loading]="loading()" (click)="reload()">Refresh</button>
        }
      </div>
      <div class="flex-1 min-h-0">
        @if (error(); as e) {
          <p class="p-4 text-sm text-danger" data-testid="git-diff-error">{{ e.message }}</p>
        } @else if (files(); as list) {
          <q-git-diff-view [files]="list" [emptyTitle]="emptyTitle()" [emptyHint]="emptyHint()" [(selected)]="selected" />
        } @else {
          <div class="flex items-center justify-center h-full"><svg qSpinner></svg></div>
        }
      </div>
    </div>
  `,
  // Edits to working files are not watched; coming back to the window picks them up.
  host: { class: 'contents', '(window:focus)': 'local() && reloadShown()' },
})
export class GitDiffTab implements TabComponent {
  private readonly actions = inject(GitActions);

  readonly tab = input.required<Tab>();
  readonly scope = input.required<string>();

  protected readonly icons = { FileDiff, Plus, RefreshCw };
  protected readonly source = computed(() => (this.tab().data?.['source'] ?? { kind: 'working' }) as DiffSource);
  /** Working or staged: the diff follows the repository. A commit never changes. */
  protected readonly local = computed(() => this.source().kind === 'working' || this.source().kind === 'staged');

  private readonly working = invokeResource<GitDiffFile[]>(
    'git.diff',
    () => {
      const s = this.source();
      return { staged: s.kind === 'staged', ...(s.path ? { path: s.path } : {}) };
    },
    { enabled: this.local },
  );
  private readonly commit = invokeResource<GitShowResult>('git.show', () => ({ ref: refOf(this.source()) }), { enabled: () => this.source().kind === 'commit' });

  protected readonly files = computed(() => {
    const kind = this.source().kind;
    return kind === 'commit' ? this.commit.value()?.files : this.working.value();
  });
  protected readonly error = computed(() => {
    const kind = this.source().kind;
    return kind === 'commit' ? this.commit.error() : this.working.error();
  });
  protected readonly loading = computed(() => this.working.isLoading());
  /** The file picked in a diff of several; a tab opened on one path starts there. */
  protected readonly selected = linkedSignal(() => this.source().path);

  /** A working file with nothing to diff may be one git does not track yet. */
  private readonly status = invokeResource<GitStatus>('git.status', () => ({}), {
    enabled: () => this.source().kind === 'working' && Boolean(this.source().path) && this.working.value()?.length === 0,
  });
  protected readonly untracked = computed(() => {
    const path = this.source().path;
    return Boolean(path && this.status.value()?.files.some((f) => f.path === path && f.index === '?'));
  });

  protected readonly heading = computed(() => {
    const s = this.source();
    if (s.kind === 'commit') {
      const c = this.commit.value()?.commit;
      return c ? `${c.shortHash} ${c.subject}` : `Commit ${s.ref.slice(0, 10)}`;
    }
    return s.path ?? (s.kind === 'staged' ? 'Staged changes' : 'Working changes');
  });
  protected readonly subheading = computed(() => {
    const kind = this.source().kind;
    return kind === 'staged' ? 'index against HEAD' : kind === 'working' ? 'working tree against the index' : '';
  });
  protected readonly emptyTitle = computed(() => (this.untracked() ? 'Untracked file' : 'No changes'));
  protected readonly emptyHint = computed(() => {
    if (this.untracked()) return 'Git does not track this file yet, so it has no diff. Stage it to see it as an added file.';
    const kind = this.source().kind;
    return kind === 'working' ? 'Nothing here differs from the index. Staged changes have their own diff.' : kind === 'staged' ? 'Nothing staged here.' : null;
  });

  /** Reloads now when the tab is on screen, else once it is shown. */
  protected readonly reloadShown = injectReloadWhenShown(tabVisible(this.tab, this.scope), () => this.reload());

  constructor() {
    injectGitChanged((p) => {
      if (p.reason === 'status' && this.local()) this.reloadShown();
    });
  }

  protected reload(): void {
    this.working.reload();
    this.status.reload();
  }

  protected async stageUntracked(): Promise<void> {
    const path = this.source().path;
    if (!path) return;
    await this.actions.stage([path]);
    this.actions.openDiff({ kind: 'staged', path });
  }
}

function refOf(s: DiffSource): string {
  return s.kind === 'commit' ? s.ref : '';
}
