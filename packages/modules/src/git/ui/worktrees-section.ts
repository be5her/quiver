import { Component, computed, inject } from '@angular/core';
import { isSameOrInside, type GitWorktree } from '@quiver/core';
import { ContextMenu, Icon, IconButton, SectionHeader, TreeState, invokeResource } from '@quiver/ui';
import { ChevronDown, ChevronRight, Eraser, ExternalLink, FolderGit2, Plus, Trash2 } from 'lucide';
import { injectGitChanged } from './git-events';
import { GitWorktreeDialog } from './worktree-dialog';
import { GitWorktreeActions, label } from './worktree-actions';

/**
 * The sidebar's Worktrees: every worktree of the repository with its branch, folder and badges. A click opens one as
 * a workspace; its menu reveals, copies, locks, unlocks and removes it. New worktree… opens the dialog, Prune forgets
 * the worktrees whose folder is gone.
 */
@Component({
  selector: 'q-git-worktrees-section',
  imports: [GitWorktreeDialog, Icon, IconButton, SectionHeader],
  template: `
    <q-section-header title="Worktrees" class="mt-2" data-testid="git-worktrees">
      <button qIconButton label="New worktree…" size="sm" data-testid="git-worktree-new" (click)="actions.openDialog()"><svg [qIcon]="icons.Plus" class="size-3.5"></svg></button>
      <button qIconButton label="Prune worktrees whose folder is gone" size="sm" data-testid="git-worktree-prune" [disabled]="!prunable()" (click)="actions.prune()"><svg [qIcon]="icons.Eraser" class="size-3.5"></svg></button>
      <button qIconButton [label]="open() ? 'Hide worktrees' : 'Show worktrees'" size="sm" (click)="tree.toggle('git/worktrees', true)">
        <svg [qIcon]="open() ? icons.ChevronDown : icons.ChevronRight" class="size-3.5"></svg>
      </button>
    </q-section-header>
    @if (open()) {
      @if (worktrees.currentError(); as error) {
        <p class="px-3 py-1 text-xs text-danger">{{ error.message }}</p>
      }
      @for (wt of list(); track wt.path) {
        <div
          class="group flex items-center gap-1.5 pl-3 pr-1 h-6 cursor-pointer hover:bg-elevated min-w-0"
          role="button"
          tabindex="0"
          data-testid="git-worktree"
          [attr.data-path]="wt.path"
          [attr.data-branch]="wt.branch"
          [attr.data-current]="wt.current"
          [attr.data-main]="wt.main"
          [attr.data-locked]="wt.locked"
          [attr.data-prunable]="wt.prunable"
          [title]="tooltip(wt)"
          (click)="activate(wt)"
          (keydown.enter)="activate(wt)"
          (contextmenu)="contextMenu.open($event, actions.menu(wt))"
        >
          <svg [qIcon]="icons.FolderGit2" class="size-3.5 shrink-0" [class]="wt.current ? 'text-accent' : 'text-muted'"></svg>
          <span class="truncate text-[13px] shrink-0 max-w-[55%]" [class.font-medium]="wt.current" [class.line-through]="wt.prunable">{{ name(wt) }}</span>
          <span class="truncate text-[11px] text-muted flex-1 min-w-0">{{ where(wt) }}</span>
          <span class="flex items-center gap-1 shrink-0 group-hover:hidden">
            @if (wt.current) {
              <span class="rounded px-1 text-[10px] leading-4 bg-elevated text-accent">current</span>
            } @else if (wt.main) {
              <span class="rounded px-1 text-[10px] leading-4 bg-elevated text-muted">main</span>
            }
            @if (wt.locked) {
              <span class="rounded px-1 text-[10px] leading-4 bg-elevated text-warning" [title]="wt.lockReason ?? 'Locked'">locked</span>
            }
            @if (wt.prunable) {
              <span class="rounded px-1 text-[10px] leading-4 bg-elevated text-danger" [title]="wt.prunableReason ?? 'Its folder is gone'">prunable</span>
            }
          </span>
          <span class="hidden group-hover:flex items-center">
            @if (!wt.current && !wt.bare && !wt.prunable) {
              <button qIconButton label="Open as workspace" size="sm" data-testid="git-worktree-open" (click)="openOne($event, wt)"><svg [qIcon]="icons.ExternalLink" class="size-3.5"></svg></button>
            }
            @if (!wt.main && !wt.current && !wt.locked && !wt.prunable) {
              <button qIconButton label="Remove worktree" size="sm" data-testid="git-worktree-remove" (click)="removeOne($event, wt)"><svg [qIcon]="icons.Trash2" class="size-3.5"></svg></button>
            }
          </span>
        </div>
      }
      @if (worktrees.current() && list().length <= 1) {
        <p class="px-3 py-1 text-xs text-muted" data-testid="git-worktrees-empty">No other worktrees. New worktree checks a branch out in a folder of its own, to work on it beside this one.</p>
      }
    }
    @if (actions.dialogOpen() && mainPath(); as main) {
      <q-git-worktree-dialog [mainPath]="main" (created)="actions.closeDialog()" (cancelled)="actions.closeDialog()" />
    }
  `,
  host: { class: 'contents' },
})
export class GitWorktreesSection {
  protected readonly actions = inject(GitWorktreeActions);
  protected readonly tree = inject(TreeState);
  protected readonly contextMenu = inject(ContextMenu);

  protected readonly icons = { ChevronDown, ChevronRight, Eraser, ExternalLink, FolderGit2, Plus, Trash2 };
  protected readonly open = computed(() => this.tree.isExpanded('git/worktrees', true));
  // Read also while the section is folded once the dialog is open: it needs the main worktree's folder.
  protected readonly worktrees = invokeResource<GitWorktree[]>('git.worktree.list', () => ({}), { enabled: () => this.open() || this.actions.dialogOpen() });
  protected readonly list = computed(() => this.worktrees.current() ?? []);
  protected readonly prunable = computed(() => this.list().some((w) => w.prunable && !w.locked));
  protected readonly mainPath = computed(() => this.list().find((w) => w.main)?.path ?? null);

  constructor() {
    injectGitChanged((p) => {
      // A checkout changes the branch this worktree shows; the others announce themselves through the watcher.
      if (p.reason === 'worktrees' || p.reason === 'branches') this.worktrees.reload();
    });
  }

  protected name(wt: GitWorktree): string {
    if (wt.bare) return 'bare repository';
    return wt.branch ?? `detached at ${wt.head?.slice(0, 7) ?? '?'}`;
  }

  /** The folder, shorter when it sits beside the main worktree (`quiver.worktrees/feat-x`). */
  protected where(wt: GitWorktree): string {
    const main = this.mainPath();
    if (!main) return wt.path;
    const parent = main.replace(/[\\/]+[^\\/]*[\\/]*$/, '');
    return parent && isSameOrInside(wt.path, parent) && wt.path.length > parent.length ? wt.path.slice(parent.length + 1) : wt.path;
  }

  protected tooltip(wt: GitWorktree): string {
    const what = wt.main ? 'The main worktree' : 'A linked worktree';
    return [
      `${label(wt)} · ${what}${wt.current ? ', open here' : ''}`,
      wt.path,
      wt.locked ? `Locked${wt.lockReason ? `: ${wt.lockReason}` : ''}` : '',
      wt.prunable ? `Prunable: ${wt.prunableReason ?? 'its folder is gone'}` : '',
      wt.current ? '' : 'Click to open as a workspace',
    ]
      .filter(Boolean)
      .join('\n');
  }

  protected activate(wt: GitWorktree): void {
    if (!wt.current && !wt.bare && !wt.prunable) void this.actions.open(wt.path);
  }

  protected openOne(event: Event, wt: GitWorktree): void {
    event.stopPropagation();
    void this.actions.open(wt.path);
  }

  protected removeOne(event: Event, wt: GitWorktree): void {
    event.stopPropagation();
    void this.actions.remove(wt);
  }
}
