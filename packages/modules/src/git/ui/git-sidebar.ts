import { Component, DestroyRef, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { FormField, form } from '@angular/forms/signals';
import type { GitBranch, GitFileChange, GitStash, GitStatus } from '@quiver/core';
import { AppState, Button, Checkbox, ContextMenu, EmptyState, HostBridge, Icon, IconButton, SectionHeader, Spinner, TextArea, TreeState, invokeResource } from '@quiver/ui';
import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Check,
  CloudUpload,
  Download,
  GitBranch as GitBranchIcon,
  GitPullRequest,
  History,
  ListTree,
  Minus,
  PackageOpen,
  Plus,
  RefreshCw,
  Trash2,
  Undo2,
} from 'lucide';
import { GitActions } from './git-actions';
import { injectGitChanged } from './git-events';
import { ago, codeClass, codeWord, errorReason, groupChanges, splitPath } from './git-format';

/** How often the status is read while the sidebar is open: edits to working files are not watched by the host. */
const STATUS_EVERY_MS = 5000;

type Group = 'conflicts' | 'staged' | 'unstaged' | 'untracked';

const GROUP_TITLE: Record<Group, string> = { conflicts: 'Merge conflicts', staged: 'Staged changes', unstaged: 'Changes', untracked: 'Untracked' };

/** One group of changed files, with stage or unstage per file and for the whole group. */
@Component({
  selector: 'q-git-change-group',
  imports: [Icon, IconButton],
  template: `
    <div
      class="group flex items-center gap-1 pl-2 pr-1 h-7 cursor-pointer hover:bg-elevated"
      role="button"
      tabindex="0"
      data-testid="git-group"
      [attr.data-group]="group()"
      (click)="toggle()"
      (keydown.enter)="toggle()"
    >
      <svg [qIcon]="open() ? icons.ChevronDown : icons.ChevronRight" class="size-3.5 text-muted shrink-0"></svg>
      <span class="text-[11px] font-semibold uppercase tracking-wide text-muted flex-1 truncate">{{ title() }}</span>
      <span class="hidden group-hover:flex items-center">
        @if (discardable()) {
          <button qIconButton [label]="group() === 'untracked' ? 'Delete all' : 'Discard all'" size="sm" data-testid="git-discard-all" (click)="discardAll($event)"><svg [qIcon]="icons.Undo2" class="size-3.5"></svg></button>
        }
        @if (group() === 'staged') {
          <button qIconButton label="Unstage all" size="sm" data-testid="git-unstage-all" (click)="all($event)"><svg [qIcon]="icons.Minus" class="size-3.5"></svg></button>
        } @else {
          <button qIconButton [label]="group() === 'conflicts' ? 'Mark all resolved' : 'Stage all'" size="sm" data-testid="git-stage-all" (click)="all($event)"><svg [qIcon]="icons.Plus" class="size-3.5"></svg></button>
        }
      </span>
      <span class="text-[10px] text-muted bg-elevated rounded-full px-1.5 group-hover:hidden">{{ files().length }}</span>
    </div>
    @if (open()) {
      @for (f of files(); track f.path) {
        <div
          class="group flex items-center gap-1.5 pl-7 pr-1 h-6 cursor-pointer hover:bg-elevated min-w-0"
          role="button"
          tabindex="0"
          data-testid="git-file"
          [attr.data-path]="f.path"
          [attr.data-group]="group()"
          [title]="tooltip(f)"
          (click)="opened.emit(f)"
          (keydown.enter)="opened.emit(f)"
          (contextmenu)="fileMenu($event, f)"
        >
          <span class="truncate text-[13px]">{{ name(f.path) }}</span>
          <span class="truncate text-[11px] text-muted flex-1 min-w-0">{{ dir(f.path) }}</span>
          <span class="hidden group-hover:flex items-center">
            @if (discardable()) {
              <button qIconButton [label]="group() === 'untracked' ? 'Delete' : 'Discard changes'" size="sm" data-testid="git-discard" (click)="discardOne($event, f)"><svg [qIcon]="icons.Undo2" class="size-3.5"></svg></button>
            }
            @if (group() === 'staged') {
              <button qIconButton label="Unstage" size="sm" data-testid="git-unstage" (click)="one($event, f)"><svg [qIcon]="icons.Minus" class="size-3.5"></svg></button>
            } @else {
              <button qIconButton [label]="group() === 'conflicts' ? 'Mark resolved' : 'Stage'" size="sm" data-testid="git-stage" (click)="one($event, f)"><svg [qIcon]="icons.Plus" class="size-3.5"></svg></button>
            }
          </span>
          <span class="font-mono text-[11px] font-bold w-3 text-center shrink-0" [class]="codeClass(code(f))">{{ code(f) }}</span>
        </div>
      }
    }
  `,
  host: { class: 'block' },
})
export class GitChangeGroup {
  private readonly tree = inject(TreeState);
  private readonly actions = inject(GitActions);
  private readonly contextMenu = inject(ContextMenu);

  readonly group = input.required<Group>();
  readonly files = input.required<GitFileChange[]>();
  readonly opened = output<GitFileChange>();

  protected readonly icons = { ChevronDown, ChevronRight, Minus, Plus, Undo2 };
  protected readonly title = computed(() => GROUP_TITLE[this.group()]);
  /** Working changes go back to the index and untracked files are deleted; staged changes are unstaged instead, and conflicts resolved. */
  protected readonly discardable = computed(() => this.group() === 'unstaged' || this.group() === 'untracked');
  protected readonly open = computed(() => this.tree.isExpanded(`git/changes/${this.group()}`, true));
  protected readonly codeClass = codeClass;

  protected toggle(): void {
    this.tree.toggle(`git/changes/${this.group()}`, true);
  }

  protected code(f: GitFileChange): string {
    if (this.group() === 'staged') return f.index;
    if (this.group() === 'untracked') return 'U';
    if (this.group() === 'conflicts') return '!';
    return f.worktree;
  }

  protected tooltip(f: GitFileChange): string {
    const what = this.group() === 'staged' ? codeWord(f.index) : this.group() === 'conflicts' ? 'Conflict: click to resolve it' : codeWord(f.worktree);
    return `${f.origPath ? `${f.origPath} → ` : ''}${f.path} · ${what}`;
  }

  protected name(p: string): string {
    return splitPath(p).name;
  }

  protected dir(p: string): string {
    return splitPath(p).dir;
  }

  protected one(event: Event, f: GitFileChange): void {
    event.stopPropagation();
    void (this.group() === 'staged' ? this.actions.unstage(withOrigin([f])) : this.actions.stage([f.path]));
  }

  protected all(event: Event): void {
    event.stopPropagation();
    void (this.group() === 'staged' ? this.actions.unstage(withOrigin(this.files())) : this.actions.stage(this.files().map((f) => f.path)));
  }

  protected discardOne(event: Event, f: GitFileChange): void {
    event.stopPropagation();
    void this.actions.discard([f.path], this.group() === 'untracked');
  }

  protected discardAll(event: Event): void {
    event.stopPropagation();
    void this.actions.discard(this.files().map((f) => f.path), this.group() === 'untracked');
  }

  /** Right-click on a file: open its changes, or blame it (as committed, at HEAD, when it was deleted). Git cannot blame an untracked file. */
  protected fileMenu(event: MouseEvent, f: GitFileChange): void {
    const deleted = (this.group() === 'staged' ? f.index : f.worktree) === 'D';
    this.contextMenu.open(event, [
      { label: 'Open changes', testId: 'git-menu-open', select: () => this.opened.emit(f) },
      { label: 'Blame', testId: 'git-menu-blame', disabled: this.group() === 'untracked', select: () => this.actions.openBlame(f.path, deleted ? 'HEAD' : undefined) },
    ]);
  }
}

/** The paths to unstage: a staged rename's old path too, or its deletion would stay staged. */
function withOrigin(files: GitFileChange[]): string[] {
  return files.flatMap((f) => (f.origPath ? [f.path, f.origPath] : [f.path]));
}

/** The workspace repository: branch and remote, the operation in progress, the commit box, the changed files, the stashes and the branches. */
@Component({
  selector: 'q-git-sidebar',
  imports: [Button, Checkbox, EmptyState, FormField, GitChangeGroup, Icon, IconButton, SectionHeader, Spinner, TextArea],
  template: `
    @if (statusError(); as error) {
      @if (!current()) {
        <q-empty-state [title]="errorTitle()" [hint]="error.message" data-testid="git-not-repo">
          <button qButton size="sm" variant="secondary" [icon]="icons.RefreshCw" (click)="reloadAll()">Try again</button>
        </q-empty-state>
      }
    }
    @if (!current() && !statusError()) {
      <div class="px-3 py-2"><svg qSpinner></svg></div>
    }
    @if (current(); as s) {
      <!-- Branch and remote -->
      <div class="flex items-center gap-1.5 px-3 h-9 border-b border-edge shrink-0" data-testid="git-branch-bar">
        <svg [qIcon]="icons.GitBranchIcon" class="size-4 text-accent shrink-0"></svg>
        <button
          type="button"
          class="font-medium text-[13px] truncate min-w-0 flex-1 hover:underline text-left"
          [title]="branchTitle()"
          data-testid="git-current-branch"
          (click)="actions.switchBranch()"
        >
          {{ s.branch ?? 'detached at ' + (s.head ?? '').slice(0, 7) }}
        </button>
        @if (s.upstream) {
          <span class="text-[11px] text-muted shrink-0 flex items-center gap-0.5" data-testid="git-ahead-behind" [attr.data-ahead]="s.ahead" [attr.data-behind]="s.behind" [title]="s.upstream">
            <svg [qIcon]="icons.ArrowUp" class="size-3"></svg>{{ s.ahead }} <svg [qIcon]="icons.ArrowDown" class="size-3"></svg>{{ s.behind }}
          </span>
        }
        <button qIconButton label="Fetch" size="sm" data-testid="git-fetch" [disabled]="busy().has('fetch')" (click)="actions.fetch()">
          @if (busy().has('fetch')) {
            <svg qSpinner class="size-3.5"></svg>
          } @else {
            <svg [qIcon]="icons.RefreshCw" class="size-3.5"></svg>
          }
        </button>
        <button qIconButton [label]="s.behind ? 'Pull ' + s.behind : 'Pull'" size="sm" data-testid="git-pull" [disabled]="busy().has('pull') || !s.upstream" (click)="actions.pull()">
          @if (busy().has('pull')) {
            <svg qSpinner class="size-3.5"></svg>
          } @else {
            <svg [qIcon]="icons.Download" class="size-3.5"></svg>
          }
        </button>
        <button qIconButton [label]="s.upstream ? (s.ahead ? 'Push ' + s.ahead : 'Push') : 'Publish branch'" size="sm" data-testid="git-push" [disabled]="busy().has('push') || !s.branch" (click)="actions.push(s)">
          @if (busy().has('push')) {
            <svg qSpinner class="size-3.5"></svg>
          } @else {
            <svg [qIcon]="icons.CloudUpload" class="size-3.5"></svg>
          }
        </button>
      </div>
      @if (s.operation; as op) {
        <div class="mx-3 mt-2 px-2 py-1.5 rounded bg-warning/10 text-warning text-xs flex flex-col gap-1.5" data-testid="git-operation" [attr.data-operation]="op">
          <span>{{ operationText() }}</span>
          <div class="flex items-center gap-1.5">
            <button qButton size="sm" variant="secondary" [disabled]="groups().conflicts.length > 0" [title]="groups().conflicts.length ? 'Resolve and stage the conflicts first' : ''" data-testid="git-operation-continue" (click)="actions.operation('continue', op)">
              Continue
            </button>
            @if (op === 'rebase') {
              <button qButton size="sm" variant="ghost" data-testid="git-operation-skip" (click)="actions.operation('skip', op)">Skip commit</button>
            }
            <span class="flex-1"></span>
            <button qButton size="sm" variant="ghost" data-testid="git-operation-abort" (click)="actions.operation('abort', op)">Abort</button>
          </div>
        </div>
      }

      <!-- Commit box -->
      <div class="flex flex-col gap-1.5 px-3 py-2 border-b border-edge" data-testid="git-commit-box">
        <textarea
          qTextarea
          rows="3"
          class="resize-y min-h-14 text-[13px] font-sans"
          [placeholder]="'Message (' + modKey + '+Enter to commit on ' + (s.branch ?? 'HEAD') + ')'"
          [formField]="commitForm.message"
          data-testid="git-commit-message"
          (keydown.control.enter)="commit()"
          (keydown.meta.enter)="commit()"
        ></textarea>
        <div class="flex items-center gap-2">
          <label class="flex items-center gap-1.5 text-xs text-muted" title="Replace the last commit with what is staged and this message">
            <input type="checkbox" qCheckbox [formField]="commitForm.amend" data-testid="git-commit-amend" /> Amend
          </label>
          <span class="flex-1"></span>
          <button qButton size="sm" variant="primary" [icon]="icons.Check" [loading]="committing()" [disabled]="!canCommit()" [title]="commitHint()" data-testid="git-commit" (click)="commit()">
            {{ draft().amend ? 'Amend' : 'Commit' }}
          </button>
        </div>
      </div>

      <!-- Changes -->
      <q-section-header title="Changes">
        <button qIconButton label="Refresh" size="sm" data-testid="git-refresh" (click)="reloadAll()"><svg [qIcon]="icons.RefreshCw" class="size-3.5"></svg></button>
      </q-section-header>
      @let g = groups();
      @if (g.conflicts.length) {
        <q-git-change-group group="conflicts" [files]="g.conflicts" (opened)="actions.openConflict($event.path)" />
      }
      @if (g.staged.length) {
        <q-git-change-group group="staged" [files]="g.staged" (opened)="openFile($event, 'staged')" />
      }
      @if (g.unstaged.length) {
        <q-git-change-group group="unstaged" [files]="g.unstaged" (opened)="openFile($event, 'working')" />
      }
      @if (g.untracked.length) {
        <q-git-change-group group="untracked" [files]="g.untracked" (opened)="openFile($event, 'untracked')" />
      }
      @if (!s.files.length) {
        <p class="px-3 py-1 text-xs text-muted" data-testid="git-clean">Nothing to commit; the working tree is clean.</p>
      }

      <!-- Stashes -->
      <q-section-header title="Stashes" class="mt-2">
        <button qIconButton label="Stash changes" size="sm" data-testid="git-stash-push" [disabled]="!s.files.length" (click)="actions.stashChanges()"><svg [qIcon]="icons.Archive" class="size-3.5"></svg></button>
        <button qIconButton [label]="stashesOpen() ? 'Hide stashes' : 'Show stashes'" size="sm" (click)="tree.toggle('git/stashes', true)">
          <svg [qIcon]="stashesOpen() ? icons.ChevronDown : icons.ChevronRight" class="size-3.5"></svg>
        </button>
      </q-section-header>
      @if (stashesOpen()) {
        @if (stashes.error(); as error) {
          <p class="px-3 py-1 text-xs text-danger">{{ error.message }}</p>
        }
        <!-- Only the workspace on screen's stashes, as with the status. -->
        @for (st of stashes.current() ?? []; track st.hash) {
          <div
            class="group flex items-center gap-1.5 pl-3 pr-1 h-6 cursor-pointer hover:bg-elevated min-w-0"
            role="button"
            tabindex="0"
            data-testid="git-stash"
            [attr.data-index]="st.index"
            [attr.data-message]="st.message"
            [title]="st.message + (st.branch ? '\nOn ' + st.branch : '') + '\nClick to see its changes'"
            (click)="actions.openStash(st)"
            (keydown.enter)="actions.openStash(st)"
            (contextmenu)="stashMenu($event, st)"
          >
            <svg [qIcon]="icons.Archive" class="size-3.5 shrink-0 text-muted"></svg>
            <span class="truncate text-[13px] flex-1">{{ st.message }}</span>
            <span class="text-[10px] text-muted shrink-0 group-hover:hidden">{{ ago(st.date) }}</span>
            <span class="hidden group-hover:flex items-center">
              <button qIconButton label="Apply" size="sm" data-testid="git-stash-apply" (click)="stashAction($event, st, 'apply')"><svg [qIcon]="icons.ArchiveRestore" class="size-3.5"></svg></button>
              <button qIconButton label="Pop (apply and drop)" size="sm" data-testid="git-stash-pop" (click)="stashAction($event, st, 'pop')"><svg [qIcon]="icons.PackageOpen" class="size-3.5"></svg></button>
              <button qIconButton label="Drop" size="sm" data-testid="git-stash-drop" (click)="stashAction($event, st, 'drop')"><svg [qIcon]="icons.Trash2" class="size-3.5"></svg></button>
            </span>
          </div>
        } @empty {
          <p class="px-3 py-1 text-xs text-muted" data-testid="git-stashes-empty">No stashes. Stash changes to set them aside without committing.</p>
        }
      }

      <!-- Branches -->
      <q-section-header title="Branches" class="mt-2">
        <button qIconButton label="All branches and tags" size="sm" data-testid="git-branches-open" (click)="actions.openBranches()"><svg [qIcon]="icons.ListTree" class="size-3.5"></svg></button>
        <button qIconButton label="New branch" size="sm" data-testid="git-new-branch" (click)="actions.newBranch()"><svg [qIcon]="icons.Plus" class="size-3.5"></svg></button>
        <button qIconButton [label]="branchesOpen() ? 'Hide branches' : 'Show branches'" size="sm" (click)="tree.toggle('git/branches', true)">
          <svg [qIcon]="branchesOpen() ? icons.ChevronDown : icons.ChevronRight" class="size-3.5"></svg>
        </button>
      </q-section-header>
      @if (branchesOpen()) {
        @if (branches.error(); as error) {
          <p class="px-3 py-1 text-xs text-danger">{{ error.message }}</p>
        }
        @for (b of localBranches(); track b.name) {
          <div
            class="group flex items-center gap-1.5 pl-3 pr-2 h-6 cursor-pointer hover:bg-elevated min-w-0"
            role="button"
            tabindex="0"
            data-testid="git-branch"
            [attr.data-name]="b.name"
            [attr.data-current]="b.current"
            [title]="b.name + (b.subject ? '\n' + b.subject : '')"
            (click)="switchTo(b)"
            (keydown.enter)="switchTo(b)"
            (contextmenu)="branchMenu($event, b)"
          >
            <svg [qIcon]="b.current ? icons.Check : icons.GitBranchIcon" class="size-3.5 shrink-0" [class]="b.current ? 'text-accent' : 'text-muted'"></svg>
            <span class="truncate text-[13px] flex-1" [class.font-medium]="b.current">{{ b.name }}</span>
            @if (b.ahead || b.behind) {
              <span class="text-[10px] text-muted shrink-0">↑{{ b.ahead }} ↓{{ b.behind }}</span>
            }
          </div>
        }
        @if (remoteCount()) {
          <p class="px-3 py-1 text-[11px] text-muted">
            {{ remoteCount() }} remote branch{{ remoteCount() === 1 ? '' : 'es' }}:
            <button type="button" class="underline hover:text-fg" (click)="actions.switchBranch()">switch to one…</button>
          </p>
        }
      }

      <!-- Views -->
      <q-section-header title="Views" class="mt-2" />
      <button type="button" class="flex items-center gap-2 px-3 h-7 text-[13px] hover:bg-elevated text-left" data-testid="git-open-branches" (click)="actions.openBranches()">
        <svg [qIcon]="icons.ListTree" class="size-3.5 text-muted"></svg> Branches and tags
      </button>
      <button type="button" class="flex items-center gap-2 px-3 h-7 text-[13px] hover:bg-elevated text-left" data-testid="git-open-history" (click)="actions.openHistory()">
        <svg [qIcon]="icons.History" class="size-3.5 text-muted"></svg> History
      </button>
      <button type="button" class="flex items-center gap-2 px-3 h-7 text-[13px] hover:bg-elevated text-left" data-testid="git-open-prs" (click)="actions.openPullRequests()">
        <svg [qIcon]="icons.GitPullRequest" class="size-3.5 text-muted"></svg> Pull requests
      </button>
      <div class="h-3 shrink-0"></div>
    }
  `,
  host: { class: 'flex flex-col h-full min-h-0 overflow-y-auto text-sm', 'data-testid': 'git-sidebar', '(window:focus)': 'status.reload()' },
})
export class GitSidebar {
  protected readonly actions = inject(GitActions);
  protected readonly tree = inject(TreeState);
  private readonly contextMenu = inject(ContextMenu);
  private readonly app = inject(AppState);
  protected readonly modKey = inject(HostBridge).modKey;

  protected readonly icons = { Archive, ArchiveRestore, ArrowDown, ArrowUp, Check, ChevronDown, ChevronRight, CloudUpload, Download, GitBranchIcon, GitPullRequest, History, ListTree, PackageOpen, RefreshCw, Plus, Trash2 };
  protected readonly status = invokeResource<GitStatus>('git.status');
  // The same sidebar serves every workspace with Git on screen, so another repository's files never show here.
  /** The status of the workspace on screen, once read. */
  protected readonly current = this.status.current;
  protected readonly statusError = this.status.currentError;
  protected readonly branchesOpen = computed(() => this.tree.isExpanded('git/branches', true));
  protected readonly branches = invokeResource<GitBranch[]>('git.branch.list', () => ({}), { enabled: () => this.branchesOpen() && Boolean(this.current()) });
  protected readonly busy = this.actions.busy;
  protected readonly stashesOpen = computed(() => this.tree.isExpanded('git/stashes', true));
  protected readonly stashes = invokeResource<GitStash[]>('git.stash.list', () => ({}), { enabled: () => this.stashesOpen() && Boolean(this.current()) });
  protected readonly ago = ago;
  /** What the operation banner says: what is in progress and what is left to do. */
  protected readonly operationText = computed(() => {
    const op = this.current()?.operation;
    const n = this.groups().conflicts.length;
    if (!op) return '';
    return n ? `A ${op} is in progress, with conflicts in ${n} file${n === 1 ? '' : 's'}. Resolve and stage them, then Continue, or Abort.` : `A ${op} is in progress and nothing is left in conflict. Continue to go on, or Abort.`;
  });

  protected readonly groups = computed(() => groupChanges(this.current()?.files ?? []));
  protected readonly localBranches = computed(() => (this.branches.value() ?? []).filter((b) => !b.remote));
  protected readonly remoteCount = computed(() => (this.branches.value() ?? []).filter((b) => b.remote && !b.name.endsWith('/HEAD')).length);
  protected readonly branchTitle = computed(() => {
    const s = this.current();
    if (!s) return '';
    return [s.branch ? `On ${s.branch}` : `Detached at ${s.head}`, s.upstream ? `tracking ${s.upstream}: ${s.ahead} ahead, ${s.behind} behind` : 'no upstream', 'Click to switch branch'].join('\n');
  });
  protected readonly errorTitle = computed(() => {
    const reason = errorReason(this.statusError());
    return reason === 'no-git' ? 'Git was not found' : reason === 'not-a-repo' ? 'Not a git repository' : 'Git could not read this folder';
  });

  /** What the commit box edits. */
  protected readonly draft = signal({ message: '', amend: false });
  protected readonly commitForm = form(this.draft);
  protected readonly committing = signal(false);
  private readonly staged = computed(() => this.groups().staged.length);
  protected readonly canCommit = computed(() => {
    if (this.committing() || !this.draft().message.trim()) return false;
    // A conflict left unresolved would fail the commit anyway; an amend may only change the message.
    return !this.groups().conflicts.length && (this.staged() > 0 || this.draft().amend);
  });
  protected readonly commitHint = computed(() => {
    if (this.groups().conflicts.length) return 'Resolve and stage the conflicts first';
    if (!this.staged() && !this.draft().amend) return 'Stage changes to commit them';
    if (!this.draft().message.trim()) return 'Write a message';
    return '';
  });

  constructor() {
    injectGitChanged((p) => {
      if (p.reason === 'status') this.status.reload();
      if (p.reason === 'branches') {
        this.status.reload();
        this.branches.reload();
      }
      if (p.reason === 'stashes') this.stashes.reload();
    });
    // Amend starts from the last commit's message, as an editor would show it: once, when it is ticked.
    const amend = computed(() => this.draft().amend);
    effect(() => {
      if (!amend() || untracked(this.draft).message.trim()) return;
      void this.actions.lastMessage().then((message) => {
        if (untracked(this.draft).amend && !untracked(this.draft).message.trim()) this.draft.update((d) => ({ ...d, message }));
      });
    });
    // A message written for one repository is not carried to another.
    effect(() => {
      this.app.activeWorkspaceId();
      untracked(() => this.draft.set({ message: '', amend: false }));
    });
    // Polled only in a repository: a folder without one is read again on focus, events and Try again.
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible' && !this.status.isLoading() && untracked(this.current)) this.status.reload();
    }, STATUS_EVERY_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  protected reloadAll(): void {
    this.status.reload();
    this.branches.reload();
    this.stashes.reload();
  }

  protected openFile(f: GitFileChange, where: 'working' | 'staged' | 'untracked'): void {
    if (where === 'untracked') this.actions.openDiff({ kind: 'working', path: f.path });
    else this.actions.openDiff({ kind: where, path: f.path });
  }

  protected async commit(): Promise<void> {
    if (!this.canCommit()) return;
    this.committing.set(true);
    const { message, amend } = this.draft();
    const done = await this.actions.commit(message, amend, this.current());
    this.committing.set(false);
    if (done) this.draft.set({ message: '', amend: false });
  }

  protected switchTo(b: GitBranch): void {
    if (!b.current) void this.actions.checkout(b.name);
  }

  protected branchMenu(event: MouseEvent, b: GitBranch): void {
    this.contextMenu.open(event, this.actions.branchMenu(b));
  }

  protected stashAction(event: Event, st: GitStash, action: 'apply' | 'pop' | 'drop'): void {
    event.stopPropagation();
    void (action === 'drop' ? this.actions.dropStash(st) : this.actions.applyStash(st, action === 'pop'));
  }

  protected stashMenu(event: MouseEvent, st: GitStash): void {
    this.contextMenu.open(event, [
      { label: 'Show changes', testId: 'git-menu-show', select: () => this.actions.openStash(st) },
      { label: 'Apply', testId: 'git-menu-apply', select: () => void this.actions.applyStash(st, false) },
      { label: 'Pop (apply and drop)', testId: 'git-menu-pop', select: () => void this.actions.applyStash(st, true) },
      'separator',
      { label: 'Drop…', testId: 'git-menu-drop', danger: true, select: () => void this.actions.dropStash(st) },
    ]);
  }
}
