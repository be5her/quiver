import { Component, computed, inject, input, linkedSignal, signal } from '@angular/core';
import { FormField, form } from '@angular/forms/signals';
import type { GitBranch, GitTag } from '@quiver/core';
import { Badge, Button, Checkbox, ContextMenu, EmptyState, Icon, IconButton, Input, Spinner, invokeResource, type Tab, type TabComponent } from '@quiver/ui';
import { ArrowDown, ArrowUp, Brush, Check, Cloud, Ellipsis, FolderGit2, GitBranch as GitBranchIcon, RefreshCw, Tag } from 'lucide';
import { GitActions } from './git-actions';
import { GitWorktreeActions } from './worktree-actions';
import { injectGitChanged } from './git-events';
import { ago, cleanupCandidates, refMatches } from './git-format';

/**
 * Every branch and tag of the repository: local branches with their upstream, ahead/behind, last commit and the
 * current, merged and gone badges, then the remote branches and the tags, all under one filter. Each row has a menu
 * (the ⋯ button or a right-click) with what can be done to it; "Clean up" lists the merged and gone local branches
 * to delete in one go.
 */
@Component({
  selector: 'q-git-branches-tab',
  imports: [Badge, Button, Checkbox, EmptyState, FormField, Icon, IconButton, Input, Spinner],
  template: `
    <div class="flex flex-col h-full min-h-0 w-full" data-testid="git-branches-tab" [attr.data-view]="view()">
      <div class="flex items-center gap-2 px-3 h-10 border-b border-edge shrink-0">
        <svg [qIcon]="icons.GitBranchIcon" class="size-4 text-accent shrink-0"></svg>
        <span class="font-medium text-sm whitespace-nowrap shrink-0">Branches and tags</span>
        @if (currentName(); as c) {
          <span class="text-xs text-muted truncate min-w-0">on {{ c }}</span>
        }
        <span class="flex-1"></span>
        @if (view() === 'list') {
          <div class="w-60 shrink min-w-32">
            <input qInput class="h-7 text-xs" placeholder="Filter by name or last commit" [formField]="filterForm.text" data-testid="git-branches-filter" />
          </div>
          <button
            qButton
            size="sm"
            variant="ghost"
            class="shrink-0 whitespace-nowrap"
            [icon]="icons.Brush"
            [disabled]="!candidates().length"
            [title]="candidates().length ? '' : 'No local branch is merged or gone'"
            data-testid="git-branches-cleanup"
            (click)="openCleanup()"
          >
            Clean up{{ candidates().length ? ' (' + candidates().length + ')' : '' }}
          </button>
        }
        <button qButton size="sm" variant="ghost" class="shrink-0" [icon]="icons.RefreshCw" [loading]="branches.isLoading() || tags.isLoading()" data-testid="git-branches-refresh" (click)="reload()">Refresh</button>
      </div>

      @if (branches.error(); as error) {
        <p class="p-4 text-sm text-danger" data-testid="git-branches-error">{{ error.message }}</p>
      } @else if (!branches.value()) {
        <div class="p-4"><svg qSpinner></svg></div>
      } @else if (view() === 'cleanup') {
        <div class="flex-1 min-h-0 overflow-y-auto" data-testid="git-cleanup">
          <div class="max-w-2xl p-4 flex flex-col gap-3">
            <p class="text-sm">Local branches whose commits are all merged into the default branch (or the current one), or whose upstream was deleted on the remote. The ones ticked are deleted; branches on the remote are left alone.</p>
            <div class="flex flex-col border border-edge rounded-md">
              @for (b of candidates(); track b.name) {
                <label class="flex items-center gap-2 px-3 h-8 border-b border-edge/50 last:border-b-0 text-[13px] min-w-0 cursor-pointer hover:bg-elevated" data-testid="git-cleanup-row" [attr.data-name]="b.name">
                  <input type="checkbox" qCheckbox [checked]="picked().has(b.name)" (change)="toggle(b.name)" />
                  <span class="truncate max-w-[45%]">{{ b.name }}</span>
                  @if (b.merged) {
                    <span qBadge class="text-success shrink-0">merged</span>
                  }
                  @if (b.gone) {
                    <span qBadge class="text-warning shrink-0" title="Its upstream was deleted on the remote">gone</span>
                  }
                  <span class="flex-1 truncate text-xs text-muted min-w-0">{{ b.subject }}</span>
                  <span class="text-[11px] text-muted shrink-0">{{ ago(b.date) }}</span>
                </label>
              }
            </div>
            <div class="flex items-center gap-2">
              <span class="text-xs text-muted flex-1">A gone branch that is not merged asks again before it is deleted with force.</span>
              <button qButton size="sm" variant="ghost" data-testid="git-cleanup-cancel" (click)="view.set('list')">Cancel</button>
              <button qButton size="sm" variant="danger" [disabled]="!picked().size" [loading]="cleaning()" data-testid="git-cleanup-delete" (click)="cleanUp()">
                Delete {{ picked().size }} branch{{ picked().size === 1 ? '' : 'es' }}
              </button>
            </div>
          </div>
        </div>
      } @else {
        <div class="flex-1 min-h-0 overflow-y-auto" data-testid="git-branches-list">
          <p class="px-3 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Local · {{ local().length }}</p>
          @for (b of local(); track b.name) {
            <div
              class="group flex items-center gap-2 px-3 h-8 hover:bg-elevated min-w-0"
              data-testid="git-branches-row"
              data-kind="local"
              [attr.data-name]="b.name"
              [attr.data-current]="b.current"
              [attr.data-merged]="b.merged"
              [attr.data-gone]="b.gone"
              [attr.data-worktree]="b.worktreePath ?? null"
              (contextmenu)="branchMenu($event, b)"
              (dblclick)="b.current || actions.checkout(b.name)"
            >
              <svg [qIcon]="b.current ? icons.Check : icons.GitBranchIcon" class="size-3.5 shrink-0" [class]="b.current ? 'text-accent' : 'text-muted'"></svg>
              <span class="text-[13px] truncate max-w-[35%]" [class.font-medium]="b.current" [title]="b.name">{{ b.name }}</span>
              @if (b.current) {
                <span qBadge class="text-accent shrink-0">current</span>
              }
              @if (b.merged) {
                <span qBadge class="text-success shrink-0" title="Its commits are all in the default branch">merged</span>
              }
              @if (b.gone) {
                <span qBadge class="text-warning shrink-0" title="Its upstream was deleted on the remote">gone</span>
              }
              @if (b.worktreePath; as wtPath) {
                <span qBadge class="shrink-0 gap-1 cursor-pointer hover:text-fg" [title]="'Checked out in the worktree at ' + wtPath + '\nClick to open it as a workspace'" data-testid="git-branches-worktree" (click)="worktrees.open(wtPath)">
                  <svg [qIcon]="icons.FolderGit2" class="size-3"></svg>in worktree
                </span>
              }
              @if (b.upstream) {
                <span class="text-[11px] text-muted shrink-0 flex items-center gap-0.5" [title]="'Tracks ' + b.upstream" data-testid="git-branches-upstream">
                  {{ b.upstream }}
                  @if (b.ahead || b.behind) {
                    <svg [qIcon]="icons.ArrowUp" class="size-3"></svg>{{ b.ahead }} <svg [qIcon]="icons.ArrowDown" class="size-3"></svg>{{ b.behind }}
                  }
                </span>
              }
              <span class="flex-1 truncate text-xs text-muted min-w-0" [title]="b.subject">{{ b.subject }}</span>
              <span class="text-[11px] text-muted shrink-0" [title]="b.date">{{ ago(b.date) }}</span>
              <button qIconButton label="Actions" size="sm" data-testid="git-branches-menu" (click)="branchMenu($event, b)"><svg [qIcon]="icons.Ellipsis" class="size-3.5"></svg></button>
            </div>
          } @empty {
            <p class="px-3 py-1 text-xs text-muted">{{ filtering() ? 'No local branch matches.' : 'No local branches yet; the first commit makes one.' }}</p>
          }

          <p class="px-3 pt-4 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Remote · {{ remote().length }}</p>
          @for (b of remote(); track b.name) {
            <div class="group flex items-center gap-2 px-3 h-8 hover:bg-elevated min-w-0" data-testid="git-branches-row" data-kind="remote" [attr.data-name]="b.name" (contextmenu)="branchMenu($event, b)">
              <svg [qIcon]="icons.Cloud" class="size-3.5 shrink-0 text-muted"></svg>
              <span class="text-[13px] truncate max-w-[35%]" [title]="b.name">{{ b.name }}</span>
              @if (b.merged) {
                <span qBadge class="text-success shrink-0">merged</span>
              }
              <span class="flex-1 truncate text-xs text-muted min-w-0" [title]="b.subject">{{ b.subject }}</span>
              <span class="text-[11px] text-muted shrink-0" [title]="b.date">{{ ago(b.date) }}</span>
              <button qIconButton label="Actions" size="sm" data-testid="git-branches-menu" (click)="branchMenu($event, b)"><svg [qIcon]="icons.Ellipsis" class="size-3.5"></svg></button>
            </div>
          } @empty {
            <p class="px-3 py-1 text-xs text-muted">{{ filtering() ? 'No remote branch matches.' : 'No remote branches. Fetch to see them, or add a remote in a terminal.' }}</p>
          }

          <p class="px-3 pt-4 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Tags · {{ tagList().length }}</p>
          @if (tags.error(); as error) {
            <p class="px-3 py-1 text-xs text-danger">{{ error.message }}</p>
          }
          @for (tg of tagList(); track tg.name) {
            <div class="group flex items-center gap-2 px-3 h-8 hover:bg-elevated min-w-0" data-testid="git-branches-row" data-kind="tag" [attr.data-name]="tg.name" (contextmenu)="tagMenu($event, tg)">
              <svg [qIcon]="icons.Tag" class="size-3.5 shrink-0 text-muted"></svg>
              <span class="text-[13px] truncate max-w-[35%]" [title]="tg.name">{{ tg.name }}</span>
              @if (tg.annotated) {
                <span qBadge class="shrink-0" title="An annotated tag, with a message of its own">annotated</span>
              }
              <span class="font-mono text-[11px] text-muted shrink-0">{{ tg.commit.slice(0, 7) }}</span>
              <span class="flex-1 truncate text-xs text-muted min-w-0" [title]="tg.subject">{{ tg.subject }}</span>
              <span class="text-[11px] text-muted shrink-0" [title]="tg.date">{{ ago(tg.date) }}</span>
              <button qIconButton label="Actions" size="sm" data-testid="git-branches-menu" (click)="tagMenu($event, tg)"><svg [qIcon]="icons.Ellipsis" class="size-3.5"></svg></button>
            </div>
          } @empty {
            <p class="px-3 py-1 text-xs text-muted">{{ filtering() ? 'No tag matches.' : 'No tags. Tag a commit from the history.' }}</p>
          }
          @if (!local().length && !remote().length && !tagList().length && filtering()) {
            <q-empty-state title="Nothing matches" hint="The filter looks at names and last commit subjects." />
          }
          <div class="h-3"></div>
        </div>
      }
    </div>
  `,
  host: { class: 'contents' },
})
export class GitBranchesTab implements TabComponent {
  protected readonly actions = inject(GitActions);
  private readonly contextMenu = inject(ContextMenu);

  readonly tab = input.required<Tab>();
  readonly scope = input.required<string>();

  protected readonly worktrees = inject(GitWorktreeActions);
  protected readonly icons = { ArrowDown, ArrowUp, Brush, Check, Cloud, Ellipsis, FolderGit2, GitBranchIcon, RefreshCw, Tag };
  protected readonly branches = invokeResource<GitBranch[]>('git.branch.list');
  protected readonly tags = invokeResource<GitTag[]>('git.tag.list');
  protected readonly ago = ago;

  protected readonly filterForm = form(signal({ text: '' }));
  private readonly filter = computed(() => this.filterForm.text().value());
  protected readonly filtering = computed(() => Boolean(this.filter().trim()));
  protected readonly view = signal<'list' | 'cleanup'>('list');

  private readonly all = computed(() => this.branches.value() ?? []);
  protected readonly currentName = computed(() => this.all().find((b) => b.current)?.name ?? null);
  protected readonly local = computed(() => this.all().filter((b) => !b.remote && refMatches(b, this.filter())));
  protected readonly remote = computed(() => this.all().filter((b) => b.remote && refMatches(b, this.filter())));
  protected readonly tagList = computed(() => (this.tags.value() ?? []).filter((t) => refMatches(t, this.filter())));
  protected readonly candidates = computed(() => cleanupCandidates(this.all()));
  /** Ticked in Clean up: every merged branch to begin with; a gone one only when ticked, since it may hold unmerged work. */
  protected readonly picked = linkedSignal<GitBranch[], ReadonlySet<string>>({
    source: this.candidates,
    computation: (list, previous) => (previous ? new Set(list.filter((b) => previous.value.has(b.name)).map((b) => b.name)) : new Set(list.filter((b) => b.merged).map((b) => b.name))),
  });
  protected readonly cleaning = signal(false);

  constructor() {
    // Commits, checkouts, fetches and tags all move refs.
    injectGitChanged((p) => {
      // Worktrees added, removed or switched change which branches are checked out elsewhere.
      if (p.reason === 'branches' || p.reason === 'worktrees') this.reload();
    });
  }

  protected reload(): void {
    this.branches.reload();
    this.tags.reload();
  }

  protected openCleanup(): void {
    this.picked.set(new Set(this.candidates().filter((b) => b.merged).map((b) => b.name)));
    this.view.set('cleanup');
  }

  protected toggle(name: string): void {
    this.picked.update((s) => {
      const next = new Set(s);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  protected async cleanUp(): Promise<void> {
    this.cleaning.set(true);
    const done = await this.actions.cleanUp([...this.picked()]);
    this.cleaning.set(false);
    if (done) this.view.set('list');
  }

  protected branchMenu(event: MouseEvent, b: GitBranch): void {
    this.contextMenu.open(event, this.actions.branchMenu(b));
  }

  protected tagMenu(event: MouseEvent, t: GitTag): void {
    this.contextMenu.open(event, this.actions.tagMenu(t, this.all()));
  }
}
