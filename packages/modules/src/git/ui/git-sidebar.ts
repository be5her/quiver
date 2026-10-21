import { Component, DestroyRef, computed, effect, inject, input, linkedSignal, output, signal, untracked } from '@angular/core';
import { FormField, form } from '@angular/forms/signals';
import type { GitBranch, GitFileChange, GitStatus } from '@quiver/core';
import { AppState, Button, Checkbox, ContextMenu, EmptyState, HostBridge, Icon, IconButton, SectionHeader, Spinner, TextArea, TreeState, invokeResource } from '@quiver/ui';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Check, CloudUpload, Download, GitBranch as GitBranchIcon, GitPullRequest, History, Minus, Plus, RefreshCw } from 'lucide';
import { GitActions } from './git-actions';
import { injectGitChanged } from './git-events';
import { codeClass, codeWord, errorReason, groupChanges, splitPath } from './git-format';

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
        >
          <span class="truncate text-[13px]">{{ name(f.path) }}</span>
          <span class="truncate text-[11px] text-muted flex-1 min-w-0">{{ dir(f.path) }}</span>
          <span class="hidden group-hover:flex items-center">
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

  readonly group = input.required<Group>();
  readonly files = input.required<GitFileChange[]>();
  readonly opened = output<GitFileChange>();

  protected readonly icons = { ChevronDown, ChevronRight, Minus, Plus };
  protected readonly title = computed(() => GROUP_TITLE[this.group()]);
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
    const what = this.group() === 'staged' ? codeWord(f.index) : this.group() === 'conflicts' ? 'Conflict' : codeWord(f.worktree);
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
}

/** The paths to unstage: a staged rename's old path too, or its deletion would stay staged. */
function withOrigin(files: GitFileChange[]): string[] {
  return files.flatMap((f) => (f.origPath ? [f.path, f.origPath] : [f.path]));
}

/** The workspace repository: branch and remote, the changed files, the commit box and the branches. */
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
      @if (s.operation) {
        <p class="mx-3 mt-2 px-2 py-1 rounded bg-warning/10 text-warning text-xs" data-testid="git-operation">A {{ s.operation }} is in progress. Resolve the conflicts, stage them and commit, or finish it in a terminal.</p>
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
        <q-git-change-group group="conflicts" [files]="g.conflicts" (opened)="openFile($event, 'working')" />
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

      <!-- Branches -->
      <q-section-header title="Branches" class="mt-2">
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

  protected readonly icons = { ArrowDown, ArrowUp, Check, ChevronDown, ChevronRight, CloudUpload, Download, GitBranchIcon, GitPullRequest, History, RefreshCw, Plus };
  protected readonly status = invokeResource<GitStatus>('git.status');
  // The same sidebar serves every workspace with Git on screen, and the resource keeps a result while the next one
  // loads; each result is kept with the workspace it was read for, so another repository's files never show here.
  private readonly statusOf = linkedSignal({ source: this.status.value, computation: (value) => ({ value, ws: untracked(this.app.activeWorkspaceId) }) });
  private readonly errorOf = linkedSignal({ source: this.status.error, computation: (error) => ({ error, ws: untracked(this.app.activeWorkspaceId) }) });
  /** The status of the workspace on screen, once read. */
  protected readonly current = computed(() => (this.statusOf().ws === this.app.activeWorkspaceId() ? this.statusOf().value : undefined));
  protected readonly statusError = computed(() => (this.errorOf().ws === this.app.activeWorkspaceId() ? this.errorOf().error : null));
  protected readonly branchesOpen = computed(() => this.tree.isExpanded('git/branches', true));
  protected readonly branches = invokeResource<GitBranch[]>('git.branch.list', () => ({}), { enabled: () => this.branchesOpen() && Boolean(this.current()) });
  protected readonly busy = this.actions.busy;

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
}
