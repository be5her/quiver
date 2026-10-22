import { Component, computed, effect, inject, input, linkedSignal, output, signal, untracked } from '@angular/core';
import { FormField, form } from '@angular/forms/signals';
import type { GhStatus, GitPrDraft, GitPullRequest, GitStatus } from '@quiver/core';
import { Badge, Button, Checkbox, Dialogs, EmptyState, HostBridge, Icon, Input, Label, Segment, Segmented, Select, Spinner, TabsState, TextArea, Toasts, invokeResource, type Tab, type TabComponent } from '@quiver/ui';
import { CloudUpload, FilePen, GitPullRequest as GitPullRequestIcon, GitPullRequestCreate, MessageSquare, Plus, RefreshCw } from 'lucide';
import { GitActions } from './git-actions';
import { injectGitChanged, injectPrPolling, tabVisible } from './git-events';
import { REVIEW_LABEL, ago, checkClass, checksSummary, prStateClass, prStateLabel, reviewClass, type PrFilter } from './git-format';

type PrState = 'open' | 'closed' | 'merged' | 'all';
/** The fields of the new pull request form that a draft fills. */
type DraftField = 'title' | 'body' | 'base' | 'labels';
const FILTERS: PrFilter[] = ['all', 'mine', 'review-requested'];

/** gh missing, signed out, or the folder not on GitHub: what to do instead of a list. */
@Component({
  selector: 'q-git-gh-missing',
  imports: [Button, EmptyState],
  template: `
    <q-empty-state [title]="title()" [hint]="hint()" data-testid="git-gh-missing" [attr.data-reason]="reason()">
      <div class="flex flex-col items-center gap-2">
        @if (command(); as cmd) {
          <code class="px-2 py-1 rounded bg-elevated text-xs font-mono select-all">{{ cmd }}</code>
        }
        <button qButton size="sm" variant="secondary" [icon]="icons.RefreshCw" (click)="retry.emit()">Check again</button>
      </div>
    </q-empty-state>
  `,
  host: { class: 'block h-full' },
})
export class GitGhMissing {
  readonly status = input.required<GhStatus>();
  readonly retry = output();

  protected readonly icons = { RefreshCw };
  protected readonly reason = computed(() => {
    const s = this.status();
    return !s.installed ? 'no-gh' : !s.authenticated ? 'signed-out' : 'not-github';
  });
  protected readonly title = computed(() => ({ 'no-gh': 'GitHub CLI not found', 'signed-out': 'Not signed in to GitHub', 'not-github': 'Not a GitHub repository' })[this.reason()]);
  protected readonly hint = computed(
    () =>
      this.status().message ??
      {
        'no-gh': 'Pull requests go through the GitHub CLI (gh) with your own sign-in. Install it from cli.github.com.',
        'signed-out': 'Sign in with the GitHub CLI in a terminal; Quiver uses that sign-in and stores no token.',
        'not-github': 'None of the remotes of this repository is on GitHub.',
      }[this.reason()],
  );
  protected readonly command = computed(() => (this.reason() === 'signed-out' ? 'gh auth login' : null));
}

/** The pull requests of the workspace's GitHub repository: a list on a filter, or the form for a new one. */
@Component({
  selector: 'q-git-prs-tab',
  imports: [Badge, Button, Checkbox, FormField, GitGhMissing, Icon, Input, Label, Segment, Segmented, Select, Spinner, TextArea],
  template: `
    <div class="flex flex-col h-full min-h-0 w-full" data-testid="git-prs-tab" [attr.data-view]="view()">
      <div class="flex items-center gap-2 px-3 h-10 border-b border-edge shrink-0">
        <svg [qIcon]="icons.GitPullRequestIcon" class="size-4 text-accent shrink-0"></svg>
        <span class="font-medium text-sm">Pull requests</span>
        @if (gh.value()?.repo; as repo) {
          <span class="text-xs text-muted truncate" data-testid="git-prs-repo">{{ repo }}{{ gh.value()?.user ? ' · signed in as ' + gh.value()?.user : '' }}</span>
        }
        <span class="flex-1"></span>
        @if (ready()) {
          <button qButton size="sm" variant="ghost" [icon]="icons.RefreshCw" [loading]="list.isLoading()" data-testid="git-prs-refresh" (click)="refresh()">Refresh</button>
          @if (view() === 'list') {
            <button qButton size="sm" variant="primary" [icon]="icons.GitPullRequestCreate" data-testid="git-pr-new" (click)="view.set('new')">New pull request</button>
          }
        }
      </div>
      @if (gh.value(); as status) {
        @if (!ready()) {
          <q-git-gh-missing [status]="status" (retry)="gh.reload()" />
        } @else if (view() === 'new') {
          <div class="flex-1 min-h-0 overflow-y-auto" data-testid="git-pr-create">
            <div class="max-w-2xl p-4 flex flex-col gap-3">
              <div class="flex items-center gap-2">
                <p class="text-sm font-medium flex-1 min-w-0 truncate">New pull request from <span class="font-mono">{{ local.value()?.branch ?? '…' }}</span></p>
                <button
                  qButton
                  size="sm"
                  variant="secondary"
                  [icon]="icons.FilePen"
                  [loading]="drafting()"
                  title="Fill the title, description, base and labels from the branch's commits and files"
                  data-testid="git-pr-draft-fill"
                  (click)="fillFromDraft(true)"
                >
                  Draft from changes
                </button>
              </div>
              @if (summary(); as s) {
                <div class="flex flex-col gap-1 px-2.5 py-2 rounded border border-edge text-xs" data-testid="git-pr-draft-summary" [attr.data-commits]="s.stats.commits" [attr.data-files]="s.stats.files">
                  @if (s.stats.commits) {
                    <span class="text-muted">
                      {{ s.stats.commits }} commit{{ s.stats.commits === 1 ? '' : 's' }} · {{ s.stats.files }} file{{ s.stats.files === 1 ? '' : 's' }} changed
                      <span class="font-mono"><span class="text-success">+{{ s.stats.additions }}</span>&nbsp;<span class="text-danger">−{{ s.stats.deletions }}</span></span>
                      against <span class="font-mono">{{ s.baseRef }}</span>
                      @if (s.templatePath) {
                        · template <span class="font-mono">{{ s.templatePath }}</span>
                      }
                    </span>
                  } @else {
                    <span class="text-muted">No commits that <span class="font-mono">{{ s.baseRef }}</span> does not have yet.</span>
                  }
                  @for (c of s.commits.slice(0, 5); track c.hash) {
                    <span class="flex gap-2 min-w-0" data-testid="git-pr-draft-commit">
                      <span class="font-mono text-muted shrink-0">{{ c.hash.slice(0, 7) }}</span>
                      <span class="truncate">{{ c.subject }}</span>
                    </span>
                  }
                  @if (s.stats.commits > 5) {
                    <span class="text-muted">and {{ s.stats.commits - 5 }} more</span>
                  }
                </div>
              }
              @if (pushNote(); as note) {
                <div class="flex items-center gap-2 px-2 py-1.5 rounded bg-warning/10 text-warning text-xs" data-testid="git-pr-push-note">
                  <span class="flex-1">{{ note }}</span>
                  <button qButton size="sm" variant="secondary" [icon]="icons.CloudUpload" [loading]="actions.busy().has('push')" (click)="actions.push(local.value())">
                    {{ local.value()?.upstream ? 'Push' : 'Publish branch' }}
                  </button>
                </div>
              }
              <div>
                <label qLabel for="git-pr-title">Title</label>
                <input qInput id="git-pr-title" [formField]="createForm.title" data-testid="git-pr-title" />
              </div>
              <div>
                <label qLabel for="git-pr-body">Description</label>
                <textarea qTextarea id="git-pr-body" rows="8" class="font-sans" placeholder="Markdown" [formField]="createForm.body" data-testid="git-pr-body"></textarea>
              </div>
              <div class="flex items-end gap-3">
                <div class="w-56">
                  <label qLabel for="git-pr-base">Into</label>
                  <input qInput id="git-pr-base" class="font-mono" placeholder="the default branch" [formField]="createForm.base" data-testid="git-pr-base" />
                </div>
                <div class="flex-1 min-w-0">
                  <label qLabel for="git-pr-labels">Labels</label>
                  <input qInput id="git-pr-labels" placeholder="comma-separated, as the repository names them" [formField]="createForm.labels" data-testid="git-pr-labels" />
                </div>
              </div>
              <div class="flex items-center gap-3">
                <label class="flex items-center gap-1.5 text-sm h-8"><input type="checkbox" qCheckbox [formField]="createForm.draft" data-testid="git-pr-draft" /> Draft</label>
                <span class="flex-1"></span>
                <button qButton size="sm" variant="ghost" (click)="showList()">Cancel</button>
                <button qButton size="sm" variant="primary" [icon]="icons.GitPullRequestCreate" [loading]="creating()" [disabled]="!draft().title.trim()" data-testid="git-pr-create-submit" (click)="create()">
                  {{ draft().draft ? 'Create draft' : 'Create pull request' }}
                </button>
              </div>
            </div>
          </div>
        } @else {
          <div class="flex items-center gap-2 pr-3 shrink-0 border-b border-edge">
            <q-segmented [(value)]="filter" class="border-b-0 px-1">
              <button qSegment="all" data-testid="git-prs-filter-all">All</button>
              <button qSegment="mine" data-testid="git-prs-filter-mine">Mine</button>
              <button qSegment="review-requested" data-testid="git-prs-filter-review">Review requested</button>
            </q-segmented>
            <span class="flex-1"></span>
            <select qSelect class="h-7 text-xs" [value]="state()" (change)="pickState($event)" data-testid="git-prs-state">
              <option value="open">Open</option>
              <option value="merged">Merged</option>
              <option value="closed">Closed</option>
              <option value="all">All states</option>
            </select>
          </div>
          <div class="flex-1 min-h-0 overflow-y-auto" data-testid="git-prs-list">
            @if (list.error(); as error) {
              <p class="p-4 text-sm text-danger" data-testid="git-prs-error">{{ error.message }}</p>
            }
            @if (list.isLoading() && !list.value()) {
              <div class="p-4"><svg qSpinner></svg></div>
            }
            @for (pr of list.value() ?? []; track pr.number) {
              <button
                type="button"
                class="w-full flex items-start gap-2.5 px-3 py-2 text-left border-b border-edge/50 hover:bg-elevated"
                data-testid="git-pr-row"
                [attr.data-number]="pr.number"
                [attr.data-checks]="pr.checks.state"
                [attr.data-review]="pr.reviewDecision ?? ''"
                (click)="actions.openPullRequest(pr)"
              >
                <svg [qIcon]="icons.GitPullRequestIcon" class="size-4 mt-0.5 shrink-0" [class]="stateClass(pr)" [attr.aria-label]="stateLabel(pr)"></svg>
                <span class="flex-1 min-w-0 flex flex-col gap-0.5">
                  <span class="flex items-center gap-1.5 min-w-0">
                    <span class="text-[13px] font-medium truncate">{{ pr.title }}</span>
                    @if (pr.draft) {
                      <span qBadge>Draft</span>
                    }
                    @for (l of pr.labels; track l) {
                      <span qBadge class="max-w-28 truncate">{{ l }}</span>
                    }
                  </span>
                  <span class="flex items-center gap-2 text-[11px] text-muted min-w-0">
                    <span>#{{ pr.number }}</span>
                    <span>{{ pr.author }}</span>
                    <span class="font-mono truncate">{{ pr.headRefName }} → {{ pr.baseRefName }}</span>
                    <span class="shrink-0" [title]="pr.updatedAt">updated {{ ago(pr.updatedAt) }}</span>
                  </span>
                </span>
                @if (pr.reviewDecision; as decision) {
                  <span class="text-[11px] shrink-0 mt-0.5" [class]="reviewClass(decision)" data-testid="git-pr-review">{{ reviewLabel[decision] }}</span>
                }
                @if (checks(pr); as summary) {
                  <span class="text-[11px] font-medium shrink-0 mt-0.5 font-mono" [class]="checkClass(pr.checks.state)" [title]="checksTitle(pr)" data-testid="git-pr-checks">{{ summary }}</span>
                }
                @if (pr.state !== 'open') {
                  <span qBadge class="shrink-0" [class]="stateClass(pr)">{{ stateLabel(pr) }}</span>
                }
              </button>
            }
            @if (list.value()?.length === 0) {
              <p class="p-4 text-sm text-muted" data-testid="git-prs-none">{{ noneText() }}</p>
            }
          </div>
        }
      } @else if (gh.error(); as error) {
        <p class="p-4 text-sm text-danger">{{ error.message }}</p>
      } @else {
        <div class="flex items-center justify-center flex-1"><svg qSpinner></svg></div>
      }
    </div>
  `,
  host: { class: 'contents' },
})
export class GitPrsTab implements TabComponent {
  protected readonly actions = inject(GitActions);
  private readonly host = inject(HostBridge);
  private readonly toasts = inject(Toasts);
  private readonly tabs = inject(TabsState);
  private readonly dialogs = inject(Dialogs);

  readonly tab = input.required<Tab>();
  readonly scope = input.required<string>();

  protected readonly icons = { CloudUpload, FilePen, GitPullRequestCreate, GitPullRequestIcon, MessageSquare, Plus, RefreshCw };
  protected readonly gh = invokeResource<GhStatus>('git.pr.status');
  protected readonly ready = computed(() => {
    const s = this.gh.value();
    return Boolean(s?.installed && s.authenticated && s.repo);
  });
  /** The list or the form; the sidebar and the palette ask for one through the tab's data. */
  protected readonly view = linkedSignal<unknown, 'list' | 'new'>({
    source: () => this.tab().data?.['nonce'],
    computation: (_nonce, previous) => {
      const asked = untracked(() => this.tab().data?.['view']);
      return asked === 'new' || asked === 'list' ? asked : (previous?.value ?? 'list');
    },
  });
  protected readonly filter = linkedSignal<unknown, PrFilter>({
    source: () => this.tab().data?.['nonce'],
    computation: (_nonce, previous) => {
      const asked = untracked(() => this.tab().data?.['filter']);
      return FILTERS.find((f) => f === asked) ?? previous?.value ?? 'all';
    },
  });
  protected readonly state = signal<PrState>('open');
  protected readonly list = invokeResource<GitPullRequest[]>('git.pr.list', () => ({ filter: this.filter(), state: this.state() }), { enabled: () => this.ready() && this.view() === 'list' });

  /** The current branch, for the form: whether it is pushed, and where. */
  protected readonly local = invokeResource<GitStatus>('git.status', () => ({}), { enabled: () => this.view() === 'new' });
  protected readonly draft = signal({ title: '', body: '', base: '', labels: '', draft: false });
  protected readonly createForm = form(this.draft);
  protected readonly creating = signal(false);
  /** `git.pr.draft` of the branch: the commits and files the summary shows. */
  protected readonly summary = signal<GitPrDraft | null>(null);
  protected readonly drafting = signal(false);
  /** What the form filled in by itself: a field still holding it counts as empty, not as text the user typed. */
  private filled: Partial<Record<DraftField, string>> = {};
  protected readonly pushNote = computed(() => {
    const s = this.local.value();
    if (!s) return null;
    if (!s.branch) return 'HEAD is detached; switch to a branch to open a pull request from it.';
    if (!s.upstream) return `${s.branch} is not on GitHub yet. Publish it first; the pull request is opened from what is pushed.`;
    if (s.ahead) return `${s.ahead} commit${s.ahead === 1 ? ' is' : 's are'} not pushed yet; push them first.`;
    return null;
  });

  protected readonly reviewLabel = REVIEW_LABEL;
  protected readonly ago = ago;
  protected readonly checks = (pr: GitPullRequest) => checksSummary(pr.checks);
  protected readonly checkClass = checkClass;
  protected readonly reviewClass = reviewClass;
  protected readonly stateClass = prStateClass;
  protected readonly stateLabel = prStateLabel;
  protected readonly noneText = computed(() => {
    const f = this.filter();
    const state = this.state() === 'all' ? '' : `${this.state()} `;
    return f === 'mine' ? `You have no ${state}pull requests here.` : f === 'review-requested' ? `No ${state}pull requests wait for your review.` : `No ${state}pull requests.`;
  });

  constructor() {
    injectPrPolling(tabVisible(this.tab, this.scope));
    injectGitChanged((p) => {
      if (p.reason === 'prs') this.list.reload();
      else if (this.view() === 'new') this.local.reload();
    });
    // Opening the form drafts it from the branch: empty fields are filled when the branch has commits of its own,
    // else the title and description start from the last commit, the way GitHub fills them for a single commit.
    effect(() => {
      if (this.view() === 'new') untracked(() => void this.fillFromDraft(false));
    });
  }

  /** Whether a field holds text the user typed: not empty, and not what the form filled in itself. */
  private typed(field: DraftField): boolean {
    const value = untracked(this.draft)[field];
    return Boolean(value.trim()) && value !== this.filled[field];
  }

  /** Put values in the form, remembering them as filled in by the form. */
  private fill(values: Partial<Record<DraftField, string>>): void {
    Object.assign(this.filled, values);
    this.draft.update((d) => ({ ...d, ...values }));
  }

  /**
   * Fill the form from `git.pr.draft`. From the button (`asked`): the title, description, base and labels, after
   * asking when that replaces a title or description the user typed. On opening: only the fields still empty, and
   * only when the branch has commits against the base.
   */
  protected async fillFromDraft(asked: boolean): Promise<void> {
    if (this.drafting()) return;
    this.drafting.set(true);
    const base = untracked(this.draft).base.trim();
    let result: GitPrDraft;
    try {
      result = await this.host.invoke<GitPrDraft>('git.pr.draft', asked && base ? { base } : {});
    } catch (err) {
      this.drafting.set(false);
      this.summary.set(null);
      if (asked) this.toasts.error(err);
      else await this.fillFromLastCommit();
      return;
    }
    this.drafting.set(false);
    this.summary.set(result);
    const labels = result.labels.join(', ');
    if (!asked) {
      if (!result.commits.length) return this.fillFromLastCommit();
      const values: Partial<Record<DraftField, string>> = {};
      if (!this.typed('title')) values.title = result.title;
      if (!this.typed('body')) values.body = result.body;
      if (!this.typed('base')) values.base = result.base;
      if (!this.typed('labels') && labels) values.labels = labels;
      this.fill(values);
      return;
    }
    const current = untracked(this.draft);
    const replaced = (['title', 'body'] as const).filter((f) => this.typed(f) && current[f] !== result[f]);
    if (replaced.length) {
      const what = replaced.length === 2 ? 'title and description' : replaced[0] === 'title' ? 'title' : 'description';
      const ok = await this.dialogs.confirm({ title: `Replace the ${what} you wrote?`, message: `The ${what} you wrote ${replaced.length === 2 ? 'are' : 'is'} replaced by the draft from the branch's commits and files.`, confirmLabel: 'Replace' });
      if (!ok) return;
    }
    this.fill({ title: result.title, body: result.body, base: result.base, ...(labels ? { labels } : {}) });
  }

  /** The title and description from the branch's last commit, into the fields still empty. */
  private async fillFromLastCommit(): Promise<void> {
    if (this.typed('title')) return;
    const message = await this.actions.lastMessage();
    if (this.typed('title') || !message) return;
    const [title, ...rest] = message.split('\n');
    this.fill({ title: title.trim(), ...(this.typed('body') ? {} : { body: rest.join('\n').trim() }) });
  }

  protected checksTitle(pr: GitPullRequest): string {
    const c = pr.checks;
    return `${c.passed} passed, ${c.failed} failed, ${c.pending} pending`;
  }

  protected pickState(event: Event): void {
    this.state.set((event.target as HTMLSelectElement).value as PrState);
  }

  protected refresh(): void {
    this.gh.reload();
    this.list.reload();
    void this.host.invoke('git.pr.refresh', { force: true }).catch(() => {});
  }

  /** Back to the list, also in the tab's saved data, so the tab does not reopen on the form. */
  protected showList(): void {
    this.view.set('list');
    const tab = untracked(this.tab);
    if (tab.data?.['view'] === 'new') this.tabs.updateTab(untracked(this.scope), tab.id, { data: { ...tab.data, view: 'list' } });
  }

  protected async create(): Promise<void> {
    const d = this.draft();
    if (!d.title.trim() || this.creating()) return;
    this.creating.set(true);
    try {
      const labels = d.labels
        .split(',')
        .map((l) => l.trim())
        .filter(Boolean);
      const pr = await this.host.invoke<GitPullRequest>('git.pr.create', { title: d.title.trim(), body: d.body, draft: d.draft, labels, ...(d.base.trim() ? { base: d.base.trim() } : {}) });
      this.toasts.notify(`Opened #${pr.number}`, 'success');
      this.draft.set({ title: '', body: '', base: '', labels: '', draft: false });
      this.filled = {};
      this.summary.set(null);
      this.showList();
      this.actions.openPullRequest(pr);
    } catch (err) {
      this.toasts.error(err);
    } finally {
      this.creating.set(false);
    }
  }
}
