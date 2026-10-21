import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormField, form } from '@angular/forms/signals';
import type { GitDiffFile, GitPrCheckWithLog, GitPullRequestDetail } from '@quiver/core';
import { Badge, Button, Icon, Segment, Segmented, Spinner, TextArea, invokeResource, type Tab, type TabComponent } from '@quiver/ui';
import { CircleCheck, CircleDashed, CircleDot, CircleSlash, CircleX, ExternalLink, GitBranch, GitPullRequest, MessageSquare, RefreshCw } from 'lucide';
import { GitDiffView } from './diff-view';
import { GitActions } from './git-actions';
import { injectGitChanged, injectPrPolling, injectReloadWhenShown, tabVisible } from './git-events';
import { REVIEW_LABEL, ago, checkClass, checksSummary, prStateClass, prStateLabel, reviewClass } from './git-format';

type View = 'conversation' | 'checks' | 'files';

const CHECK_ICON = { success: CircleCheck, failure: CircleX, pending: CircleDot, skipped: CircleSlash, neutral: CircleDashed };

const REVIEW_STATE: Record<string, string> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'requested changes',
  COMMENTED: 'commented',
  DISMISSED: 'review dismissed',
  PENDING: 'review pending',
};

/** One pull request: its description and conversation, its checks with failed logs on demand, and its files. */
@Component({
  selector: 'q-git-pr-tab',
  imports: [Badge, Button, FormField, GitDiffView, Icon, Segment, Segmented, Spinner, TextArea],
  template: `
    @if (pr.value(); as p) {
      <div class="flex flex-col h-full min-h-0 w-full" data-testid="git-pr-tab" [attr.data-number]="p.number">
        <div class="flex items-center gap-2 px-3 h-10 border-b border-edge shrink-0">
          <svg [qIcon]="icons.GitPullRequest" class="size-4 shrink-0" [class]="stateClass(p)"></svg>
          <span class="font-medium text-sm truncate min-w-0" [title]="p.title" data-testid="git-pr-title-text">{{ p.title }}</span>
          <span class="text-sm text-muted shrink-0">#{{ p.number }}</span>
          <span qBadge class="shrink-0" [class]="stateClass(p)" data-testid="git-pr-state">{{ stateLabel(p) }}</span>
          <span class="flex-1"></span>
          <button qButton size="sm" variant="ghost" [icon]="icons.RefreshCw" [loading]="pr.isLoading()" (click)="reload()">Refresh</button>
          <button qButton size="sm" variant="ghost" [icon]="icons.ExternalLink" data-testid="git-pr-open" (click)="actions.prOpen(p.number)">Open in browser</button>
          @if (p.state === 'open') {
            <button qButton size="sm" variant="secondary" [icon]="icons.GitBranch" [loading]="checkingOut()" data-testid="git-pr-checkout" (click)="checkout()">Check out</button>
          }
        </div>
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 text-xs text-muted border-b border-edge shrink-0">
          <span>
            <span class="text-fg">{{ p.author }}</span> wants to merge <span class="font-mono text-fg">{{ p.headRefName }}</span> into
            <span class="font-mono text-fg">{{ p.baseRefName }}</span>
          </span>
          <span class="text-success">+{{ p.additions }}</span><span class="text-danger -ml-2">-{{ p.deletions }}</span>
          @if (p.reviewDecision; as decision) {
            <span [class]="reviewClass(decision)" data-testid="git-pr-review-decision">{{ reviewLabel[decision] }}</span>
          }
          @if (checksText(); as text) {
            <span class="font-mono" [class]="checkClass(p.checks.state)">{{ text }}</span>
          }
          <span [title]="p.updatedAt">updated {{ ago(p.updatedAt) }}</span>
          @for (l of p.labels; track l) {
            <span qBadge>{{ l }}</span>
          }
        </div>
        <q-segmented [(value)]="view" class="shrink-0 px-1">
          <button qSegment="conversation" data-testid="git-pr-view-conversation">Conversation ({{ p.reviews.length + p.comments.length }})</button>
          <button qSegment="checks" data-testid="git-pr-view-checks">Checks{{ p.checks.failed ? ' ✗' + p.checks.failed : '' }}</button>
          <button qSegment="files" data-testid="git-pr-view-files">Files ({{ p.files.length }})</button>
        </q-segmented>
        <div class="flex-1 min-h-0">
          @switch (view()) {
            @case ('conversation') {
              <div class="h-full overflow-y-auto" data-testid="git-pr-conversation">
                <div class="max-w-3xl p-4 flex flex-col gap-3">
                  <div class="rounded-md border border-edge">
                    <div class="px-3 py-1.5 text-xs text-muted border-b border-edge bg-elevated/50"><span class="text-fg font-medium">{{ p.author }}</span> opened {{ ago(p.createdAt) }}</div>
                    <p class="px-3 py-2 text-[13px] whitespace-pre-wrap break-words" data-testid="git-pr-body-text" [class.text-muted]="!p.body">{{ p.body || 'No description.' }}</p>
                  </div>
                  @for (item of timeline(); track $index) {
                    <div class="rounded-md border border-edge" data-testid="git-pr-comment" [attr.data-kind]="item.kind">
                      <div class="px-3 py-1.5 text-xs text-muted border-b border-edge bg-elevated/50 flex items-center gap-1.5">
                        <span class="text-fg font-medium">{{ item.author }}</span>
                        <span [class]="item.kind === 'review' ? reviewStateClass(item.state) : ''">{{ item.what }}</span>
                        <span [title]="item.at">{{ ago(item.at) }}</span>
                      </div>
                      @if (item.body) {
                        <p class="px-3 py-2 text-[13px] whitespace-pre-wrap break-words">{{ item.body }}</p>
                      }
                    </div>
                  }
                  <div class="flex flex-col gap-1.5">
                    <textarea qTextarea rows="4" class="font-sans" placeholder="Leave a comment (Markdown)" [formField]="commentForm.body" data-testid="git-pr-comment-body" (keydown.control.enter)="comment()" (keydown.meta.enter)="comment()"></textarea>
                    <div class="flex justify-end">
                      <button qButton size="sm" variant="primary" [icon]="icons.MessageSquare" [loading]="commenting()" [disabled]="!commentDraft().body.trim()" data-testid="git-pr-comment-submit" (click)="comment()">Comment</button>
                    </div>
                  </div>
                </div>
              </div>
            }
            @case ('checks') {
              <div class="h-full overflow-y-auto" data-testid="git-pr-checks-view">
                <div class="flex items-center gap-2 px-3 py-2 border-b border-edge">
                  <span class="text-xs text-muted flex-1">{{ checksLine() }}</span>
                  @if (failedCount()) {
                    <button qButton size="sm" variant="secondary" [loading]="checks.isLoading() && withLogs()" [disabled]="withLogs()" data-testid="git-pr-failed-logs" (click)="withLogs.set(true)">
                      {{ withLogs() ? 'Failed logs shown' : 'Show failed logs' }}
                    </button>
                  }
                </div>
                @if (checks.error(); as error) {
                  <p class="p-3 text-sm text-danger">{{ error.message }}</p>
                }
                @if (checks.isLoading() && !checks.value()) {
                  <div class="p-3"><svg qSpinner></svg></div>
                }
                @for (c of checks.value() ?? []; track $index) {
                  <div class="border-b border-edge/50" data-testid="git-pr-check" [attr.data-state]="c.state" [attr.data-name]="c.name">
                    <div class="flex items-center gap-2 px-3 h-8">
                      <svg [qIcon]="checkIcon[c.state]" class="size-4 shrink-0" [class]="checkClass(c.state)"></svg>
                      <span class="text-[13px] truncate">{{ c.name }}</span>
                      @if (c.workflow) {
                        <span class="text-[11px] text-muted truncate">{{ c.workflow }}</span>
                      }
                      <span class="flex-1"></span>
                      <span class="text-[11px] text-muted shrink-0">{{ duration(c) }}</span>
                      @if (safeUrl(c.url); as url) {
                        <a [href]="url" target="_blank" rel="noopener" class="text-muted hover:text-fg shrink-0" title="Open the check's page"><svg [qIcon]="icons.ExternalLink" class="size-3.5"></svg></a>
                      }
                    </div>
                    @if (c.log) {
                      <pre class="mx-3 mb-2 p-2 rounded bg-elevated text-[11px] leading-4 font-mono whitespace-pre-wrap break-all max-h-80 overflow-auto" data-testid="git-pr-check-log">{{ c.log }}</pre>
                    } @else if (c.logError) {
                      <p class="mx-3 mb-2 text-[11px] text-muted" data-testid="git-pr-check-log-error">{{ c.logError }}</p>
                    }
                  </div>
                }
                @if (checks.value()?.length === 0) {
                  <p class="p-3 text-sm text-muted">No checks ran on the head commit.</p>
                }
              </div>
            }
            @case ('files') {
              @if (diff.error(); as error) {
                <p class="p-4 text-sm text-danger">{{ error.message }}</p>
              } @else if (diff.value(); as files) {
                <q-git-diff-view [files]="files" />
              } @else {
                <div class="flex items-center justify-center h-full"><svg qSpinner></svg></div>
              }
            }
          }
        </div>
      </div>
    } @else if (pr.error(); as error) {
      <div class="p-4 text-sm text-danger" data-testid="git-pr-error">{{ error.message }}</div>
    } @else {
      <div class="flex items-center justify-center h-full w-full"><svg qSpinner></svg></div>
    }
  `,
  host: { class: 'contents' },
})
export class GitPrTab implements TabComponent {
  protected readonly actions = inject(GitActions);
  readonly tab = input.required<Tab>();
  readonly scope = input.required<string>();

  protected readonly icons = { ExternalLink, GitBranch, GitPullRequest, MessageSquare, RefreshCw };
  protected readonly checkIcon = CHECK_ICON;
  private readonly number = computed(() => Number(this.tab().data?.['id'] ?? 0));
  protected readonly view = signal<View>('conversation');
  protected readonly pr = invokeResource<GitPullRequestDetail>('git.pr.get', () => ({ number: this.number() }));
  /** Failed logs cost a gh call per failed job, so they are read only when asked for. */
  protected readonly withLogs = signal(false);
  /** The views opened so far: checks and files are read when first shown and then kept, not read again on every switch. */
  private readonly opened = signal<ReadonlySet<View>>(new Set(['conversation']));
  protected readonly checks = invokeResource<GitPrCheckWithLog[]>('git.pr.checks', () => ({ number: this.number(), failedLogs: this.withLogs() }), { enabled: () => this.opened().has('checks') });
  protected readonly diff = invokeResource<GitDiffFile[]>('git.pr.diff', () => ({ number: this.number() }), { enabled: () => this.opened().has('files') });
  protected readonly checkingOut = signal(false);
  protected readonly commentDraft = signal({ body: '' });
  protected readonly commentForm = form(this.commentDraft);
  protected readonly commenting = signal(false);

  protected readonly reviewLabel = REVIEW_LABEL;
  protected readonly ago = ago;
  protected readonly checkClass = checkClass;
  protected readonly reviewClass = reviewClass;
  protected readonly stateClass = prStateClass;
  protected readonly stateLabel = prStateLabel;

  /** Reviews and comments in the order they were made. */
  protected readonly timeline = computed(() => {
    const p = this.pr.value();
    if (!p) return [];
    const items = [
      ...p.reviews.map((r) => ({ kind: 'review' as const, author: r.author, at: r.submittedAt, body: r.body, state: r.state, what: REVIEW_STATE[r.state] ?? r.state.toLowerCase() })),
      ...p.comments.map((c) => ({ kind: 'comment' as const, author: c.author, at: c.createdAt, body: c.body, state: '', what: 'commented' })),
    ];
    return items.sort((a, b) => a.at.localeCompare(b.at));
  });
  protected readonly checksText = computed(() => {
    const p = this.pr.value();
    return p ? checksSummary(p.checks) : '';
  });
  protected readonly failedCount = computed(() => (this.checks.value() ?? []).filter((c) => c.state === 'failure').length);
  protected readonly checksLine = computed(() => {
    const list = this.checks.value();
    if (!list) return '';
    const count = (state: string) => list.filter((c) => c.state === state).length;
    return `${count('success')} passed · ${count('failure')} failed · ${count('pending')} pending${count('skipped') ? ` · ${count('skipped')} skipped` : ''}`;
  });

  constructor() {
    const visible = tabVisible(this.tab, this.scope);
    injectPrPolling(visible);
    const reloadShown = injectReloadWhenShown(visible, () => this.reload());
    injectGitChanged((p) => {
      if (p.reason === 'prs') reloadShown();
    });
    effect(() => {
      const v = this.view();
      if (!untracked(this.opened).has(v)) this.opened.update((s) => new Set(s).add(v));
    });
  }

  protected reload(): void {
    this.pr.reload();
    if (this.opened().has('checks')) this.checks.reload();
    if (this.opened().has('files')) this.diff.reload();
  }

  protected reviewStateClass(state: string): string {
    return state === 'APPROVED' ? 'text-success' : state === 'CHANGES_REQUESTED' ? 'text-danger' : '';
  }

  protected duration(c: GitPrCheckWithLog): string {
    const start = c.startedAt ? Date.parse(c.startedAt) : NaN;
    const end = c.completedAt ? Date.parse(c.completedAt) : NaN;
    // gh gives year 1 for a check still running.
    if (Number.isNaN(start) || Number.isNaN(end) || end < start) return c.state === 'pending' ? 'running' : '';
    const s = Math.round((end - start) / 1000);
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
  }

  /** Only web addresses become links; they open in the system browser. */
  protected safeUrl(url: string | undefined): string | null {
    return url && /^https:\/\//i.test(url) ? url : null;
  }

  protected async checkout(): Promise<void> {
    this.checkingOut.set(true);
    await this.actions.prCheckout(this.number());
    this.checkingOut.set(false);
  }

  protected async comment(): Promise<void> {
    const body = this.commentDraft().body.trim();
    if (!body || this.commenting()) return;
    this.commenting.set(true);
    const ok = await this.actions.prComment(this.number(), body);
    this.commenting.set(false);
    if (ok) {
      this.commentDraft.set({ body: '' });
      this.pr.reload();
    }
  }
}
