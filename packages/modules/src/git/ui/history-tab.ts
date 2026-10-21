import { Component, computed, inject, input, linkedSignal, signal } from '@angular/core';
import type { GitCommit } from '@quiver/core';
import { Badge, Button, EmptyState, HostBridge, Icon, Spinner, Toasts, invokeResource, type Tab, type TabComponent } from '@quiver/ui';
import { Copy, History, RefreshCw } from 'lucide';
import { GitDiffView } from './diff-view';
import { GitActions } from './git-actions';
import { injectGitChanged } from './git-events';
import { ago, type GitLogPage, type GitShowResult } from './git-format';

/** Commits per page of the list. */
const PAGE = 100;

/** The history of HEAD, paged; a commit picked shows its message, files and diff. */
@Component({
  selector: 'q-git-history-tab',
  imports: [Badge, Button, EmptyState, GitDiffView, Icon, Spinner],
  template: `
    <div class="flex h-full min-h-0 w-full" data-testid="git-history-tab">
      <div class="w-96 shrink-0 border-r border-edge flex flex-col min-h-0">
        <div class="flex items-center gap-2 px-3 h-10 border-b border-edge shrink-0">
          <svg [qIcon]="icons.History" class="size-4 text-accent shrink-0"></svg>
          <span class="font-medium text-sm">History</span>
          <span class="flex-1"></span>
          <button qButton size="sm" variant="ghost" [icon]="icons.RefreshCw" [loading]="first.isLoading()" (click)="first.reload()">Refresh</button>
        </div>
        <div class="flex-1 min-h-0 overflow-y-auto" data-testid="git-log">
          @if (first.error(); as error) {
            <p class="p-3 text-xs text-danger">{{ error.message }}</p>
          }
          @for (c of commits(); track c.hash) {
            <button
              type="button"
              class="w-full flex flex-col gap-0.5 px-3 py-1.5 text-left border-b border-edge/50 hover:bg-elevated"
              [class.bg-elevated]="c.hash === current()"
              data-testid="git-commit-row"
              [attr.data-hash]="c.hash"
              [title]="c.subject"
              (click)="picked.set(c.hash)"
            >
              <span class="flex items-center gap-1.5 min-w-0">
                <span class="truncate text-[13px] flex-1">{{ c.subject }}</span>
                @for (r of c.refs; track r) {
                  <span qBadge class="shrink-0 max-w-32 truncate" [class.text-accent]="r.startsWith('HEAD')">{{ r }}</span>
                }
              </span>
              <span class="flex items-center gap-2 text-[11px] text-muted">
                <span class="font-mono">{{ c.shortHash }}</span>
                <span class="truncate flex-1">{{ c.author }}</span>
                <span class="shrink-0" [title]="c.date">{{ ago(c.date) }}</span>
              </span>
            </button>
          }
          @if (first.value() && !commits().length) {
            <q-empty-state title="No commits yet" hint="Commit from the Git sidebar; the history starts there." />
          }
          @if (hasMore()) {
            <div class="p-2 text-center">
              <button qButton size="sm" variant="ghost" [loading]="loadingMore()" data-testid="git-log-more" (click)="loadMore()">Load older commits</button>
            </div>
          }
        </div>
      </div>
      <div class="flex-1 min-w-0 flex flex-col min-h-0">
        @if (detail.value(); as d) {
          <div class="px-4 py-3 border-b border-edge shrink-0 max-h-[40%] overflow-y-auto" data-testid="git-commit-detail" [attr.data-hash]="d.commit.hash">
            <p class="text-sm font-medium">{{ d.commit.subject }}</p>
            @if (d.commit.body) {
              <p class="text-xs text-fg/90 whitespace-pre-wrap mt-1.5">{{ d.commit.body }}</p>
            }
            <div class="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2 text-[11px] text-muted">
              <span>{{ d.commit.author }} &lt;{{ d.commit.email }}&gt;</span>
              <span [title]="d.commit.date">{{ when(d.commit.date) }}</span>
              <button type="button" class="font-mono flex items-center gap-1 hover:text-fg" title="Copy hash" (click)="toasts.copy(d.commit.hash, 'Hash copied')">
                {{ d.commit.shortHash }} <svg [qIcon]="icons.Copy" class="size-3"></svg>
              </button>
              @if (d.commit.parents.length > 1) {
                <span>Merge of {{ d.commit.parents.length }} parents; changes against the first</span>
              }
              <span>{{ d.files.length }} file{{ d.files.length === 1 ? '' : 's' }}</span>
              <button type="button" class="text-accent hover:underline" data-testid="git-commit-open-tab" (click)="actions.openDiff({ kind: 'commit', ref: d.commit.hash })">Open in a tab</button>
            </div>
          </div>
          <div class="flex-1 min-h-0">
            <q-git-diff-view [files]="d.files" emptyTitle="No file changes" />
          </div>
        } @else if (detail.error(); as error) {
          <p class="p-4 text-sm text-danger">{{ error.message }}</p>
        } @else if (current()) {
          <div class="flex items-center justify-center h-full"><svg qSpinner></svg></div>
        } @else {
          <q-empty-state title="Pick a commit" hint="Its message, files and diff show here." />
        }
      </div>
    </div>
  `,
  host: { class: 'contents' },
})
export class GitHistoryTab implements TabComponent {
  private readonly host = inject(HostBridge);
  protected readonly toasts = inject(Toasts);
  protected readonly actions = inject(GitActions);

  readonly tab = input.required<Tab>();
  readonly scope = input.required<string>();

  protected readonly icons = { Copy, History, RefreshCw };
  protected readonly first = invokeResource<GitLogPage>('git.log', () => ({ limit: PAGE }));
  /** Older pages loaded with "Load older commits"; a reload of the first page starts over. */
  private readonly older = linkedSignal<GitLogPage | undefined, GitLogPage[]>({ source: this.first.value, computation: () => [] });
  protected readonly loadingMore = signal(false);
  protected readonly commits = computed<GitCommit[]>(() => [...(this.first.value()?.commits ?? []), ...this.older().flatMap((p) => p.commits)]);
  protected readonly hasMore = computed(() => {
    const pages = this.older();
    return (pages.length ? pages[pages.length - 1] : this.first.value())?.hasMore ?? false;
  });
  /** The commit picked; the newest until one is. */
  protected readonly picked = signal<string | null>(null);
  protected readonly current = computed(() => {
    const picked = this.picked();
    return picked && this.commits().some((c) => c.hash === picked) ? picked : (this.commits()[0]?.hash ?? null);
  });
  protected readonly detail = invokeResource<GitShowResult>('git.show', () => ({ ref: this.current() }), { enabled: () => Boolean(this.current()) });
  protected readonly ago = ago;

  constructor() {
    // A commit, checkout, pull or reset in or out of Quiver moves HEAD.
    injectGitChanged((p) => p.reason === 'branches' && this.first.reload());
  }

  protected when(iso: string): string {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
  }

  protected async loadMore(): Promise<void> {
    if (this.loadingMore()) return;
    this.loadingMore.set(true);
    try {
      const page = await this.host.invoke<GitLogPage>('git.log', { limit: PAGE, skip: this.commits().length });
      this.older.update((pages) => [...pages, page]);
    } catch (err) {
      this.toasts.error(err);
    } finally {
      this.loadingMore.set(false);
    }
  }
}
