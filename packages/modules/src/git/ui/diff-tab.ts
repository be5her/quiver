import { Component, computed, inject, input, linkedSignal } from '@angular/core';
import type { GitDiffFile, GitStatus } from '@quiver/core';
import { Button, Icon, Spinner, invokeResource, type Tab, type TabComponent } from '@quiver/ui';
import { FileDiff, Plus, RefreshCw } from 'lucide';
import { GitDiffView } from './diff-view';
import { GitActions } from './git-actions';
import { injectGitChanged, injectReloadWhenShown, tabVisible } from './git-events';
import type { DiffBase, DiffSource, GitShowResult, GitStashShowResult } from './git-format';

/** A diff: working or staged changes (one file or all of them), a commit, two refs compared, or a stash. */
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
        @if (follows()) {
          <button qButton size="sm" variant="ghost" [icon]="icons.RefreshCw" [loading]="loading()" (click)="reload()">Refresh</button>
        }
      </div>
      <div class="flex-1 min-h-0">
        @if (error(); as e) {
          <p class="p-4 text-sm text-danger" data-testid="git-diff-error">{{ e.message }}</p>
        } @else if (files(); as list) {
          <q-git-diff-view [files]="list" [base]="base()" [blameAt]="blameAt()" [emptyTitle]="emptyTitle()" [emptyHint]="emptyHint()" [(selected)]="selected" />
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
  /** Working, staged and compared refs move with the repository, and get a Refresh. */
  protected readonly follows = computed(() => this.local() || this.source().kind === 'compare');

  private readonly working = invokeResource<GitDiffFile[]>(
    'git.diff',
    () => {
      const s = this.source();
      if (s.kind === 'compare') return { from: s.from, to: s.to, ...(s.path ? { path: s.path } : {}) };
      return { staged: s.kind === 'staged', ...(s.path ? { path: s.path } : {}) };
    },
    { enabled: this.follows },
  );
  private readonly commit = invokeResource<GitShowResult>('git.show', () => ({ ref: refOf(this.source()) }), { enabled: () => this.source().kind === 'commit' });
  private readonly stash = invokeResource<GitStashShowResult>('git.stash.show', () => ({ index: stashOf(this.source())?.index ?? 0 }), { enabled: () => this.source().kind === 'stash' });
  /** The stash at that index is another one once an older one was dropped or a new one pushed. */
  private readonly stashGone = computed(() => {
    const s = stashOf(this.source());
    const shown = this.stash.value()?.stash;
    return Boolean(s && shown && shown.hash !== s.hash);
  });

  protected readonly files = computed(() => {
    const kind = this.source().kind;
    if (kind === 'commit') return this.commit.value()?.files;
    if (kind === 'stash') return this.stashGone() ? undefined : this.stash.value()?.files;
    return this.working.value();
  });
  protected readonly error = computed(() => {
    const kind = this.source().kind;
    if (kind === 'commit') return this.commit.error();
    if (kind === 'stash') return this.stashGone() ? { message: 'This stash is no longer at this place in the list: it was dropped, or another one was stashed since. Open it again from the sidebar.' } : this.stash.error();
    return this.working.error();
  });
  protected readonly loading = computed(() => this.working.isLoading());
  /** The file picked in a diff of several; a tab opened on one path starts there. */
  protected readonly selected = linkedSignal(() => this.source().path);

  /** Where the old side of each file is, for the whole-file view: the index, HEAD, the commit's parent, the ref compared from, the stash's base. */
  protected readonly base = computed<DiffBase | null>(() => {
    const s = this.source();
    switch (s.kind) {
      case 'working':
        return { index: true };
      case 'staged':
        return { ref: 'HEAD' };
      case 'compare':
        return { ref: s.from };
      case 'stash':
        return { ref: `${s.hash}^1` };
      case 'commit': {
        const parent = this.commit.value()?.commit.parents[0];
        // A root commit only adds files, which need no old side.
        return parent ? { ref: parent } : this.commit.value() ? { ref: s.ref } : null;
      }
    }
  });

  /** Where Blame opens a file: the working tree for local changes, the commit shown, the ref compared to; a stash has none. */
  protected readonly blameAt = computed<string | null | undefined>(() => {
    const s = this.source();
    if (s.kind === 'commit') return s.ref;
    if (s.kind === 'compare') return s.to;
    return s.kind === 'stash' ? undefined : null;
  });

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
    if (s.kind === 'compare') return `${s.from} → ${s.to}`;
    if (s.kind === 'stash') return `Stash: ${this.stash.value()?.stash.message ?? `stash@{${s.index}}`}`;
    return s.path ?? (s.kind === 'staged' ? 'Staged changes' : 'Working changes');
  });
  protected readonly subheading = computed(() => {
    const s = this.source();
    if (s.kind === 'staged') return 'index against HEAD';
    if (s.kind === 'working') return 'working tree against the index';
    // A two-dot diff: also what `from` has and `to` has not, shown as removed.
    if (s.kind === 'compare') return `${s.to} against ${s.from}`;
    if (s.kind === 'stash') return this.stash.value()?.stash.branch ? `made on ${this.stash.value()?.stash.branch}` : '';
    return '';
  });
  protected readonly emptyTitle = computed(() => (this.untracked() ? 'Untracked file' : 'No changes'));
  protected readonly emptyHint = computed(() => {
    if (this.untracked()) return 'Git does not track this file yet, so it has no diff. Stage it to see it as an added file.';
    const kind = this.source().kind;
    if (kind === 'compare') return 'Both refs have the same files.';
    return kind === 'working' ? 'Nothing here differs from the index. Staged changes have their own diff.' : kind === 'staged' ? 'Nothing staged here.' : null;
  });

  /** Reloads now when the tab is on screen, else once it is shown. */
  protected readonly reloadShown = injectReloadWhenShown(tabVisible(this.tab, this.scope), () => this.reload());

  constructor() {
    injectGitChanged((p) => {
      if (p.reason === 'status' && this.local()) this.reloadShown();
      if (p.reason === 'branches' && this.source().kind === 'compare') this.reloadShown();
      if (p.reason === 'stashes' && this.source().kind === 'stash') this.stash.reload();
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

function stashOf(s: DiffSource): { index: number; hash: string } | null {
  return s.kind === 'stash' ? s : null;
}
