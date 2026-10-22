import { Component, ElementRef, afterRenderEffect, computed, effect, inject, input, output, signal, untracked, viewChild } from '@angular/core';
import { FormField, form } from '@angular/forms/signals';
import { defaultWorktreePath, type GitBranch, type GitWorktree } from '@quiver/core';
import { Autofocus, Button, Input, Label, Select, invokeResource } from '@quiver/ui';
import { GitWorktreeActions } from './worktree-actions';

interface Draft {
  mode: 'new' | 'existing';
  branch: string;
  newBranch: string;
  from: string;
  path: string;
}

/**
 * New worktree: a new branch from a ref, or an existing branch no worktree has, checked out in a folder of its own.
 * The folder follows the branch (`<repository>.worktrees/<branch>` beside the main worktree) until it is edited.
 */
@Component({
  selector: 'q-git-worktree-dialog',
  imports: [Autofocus, Button, FormField, Input, Label, Select],
  template: `
    <div class="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[14vh]" (mousedown)="cancelled.emit()">
      <form
        class="w-[520px] max-w-[92vw] rounded-lg border border-edge bg-canvas shadow-xl p-4 flex flex-col gap-3"
        role="dialog"
        aria-modal="true"
        aria-label="New worktree"
        data-testid="git-worktree-dialog"
        [attr.data-mode]="draft().mode"
        (mousedown)="$event.stopPropagation()"
        (keydown.escape)="cancelled.emit()"
        (submit)="submit($event)"
      >
        <div>
          <h2 class="text-sm font-semibold">New worktree</h2>
          <p class="text-xs text-muted mt-0.5">Checks a branch out in a folder of its own, to work on it beside this one without switching here.</p>
        </div>
        <div class="flex items-center gap-2">
          <label qLabel class="mb-0 w-20 shrink-0" for="git-worktree-mode">Branch</label>
          <select qSelect id="git-worktree-mode" class="flex-1" [formField]="draftForm.mode" data-testid="git-worktree-mode">
            <option value="new">A new branch</option>
            <option value="existing">An existing branch</option>
          </select>
        </div>
        @if (draft().mode === 'new') {
          <div class="flex items-center gap-2">
            <label qLabel class="mb-0 w-20 shrink-0" for="git-worktree-new-branch">Name</label>
            <input qInput qAutofocus id="git-worktree-new-branch" class="flex-1" placeholder="feat/my-change" [formField]="draftForm.newBranch" data-testid="git-worktree-new-branch" />
          </div>
          <div class="flex items-center gap-2">
            <label qLabel class="mb-0 w-20 shrink-0" for="git-worktree-from">From</label>
            <input qInput id="git-worktree-from" class="flex-1" [placeholder]="currentBranch() ?? 'HEAD'" [formField]="draftForm.from" data-testid="git-worktree-from" />
          </div>
        } @else {
          <div class="flex items-center gap-2">
            <label qLabel class="mb-0 w-20 shrink-0" for="git-worktree-branch">Existing</label>
            <select qSelect id="git-worktree-branch" class="flex-1" [formField]="draftForm.branch" data-testid="git-worktree-branch">
              @for (b of free(); track b.name) {
                <option [value]="b.name">{{ b.name }}</option>
              }
            </select>
          </div>
          @if (branches.value() && !free().length) {
            <p class="text-xs text-muted" data-testid="git-worktree-no-branch">Every local branch is checked out somewhere already; make a new one instead.</p>
          }
        }
        <div class="flex items-center gap-2">
          <label qLabel class="mb-0 w-20 shrink-0" for="git-worktree-path">Folder</label>
          <input #pathInput qInput id="git-worktree-path" class="flex-1 font-mono text-xs" [formField]="draftForm.path" (input)="pathEdited.set(true)" data-testid="git-worktree-path" />
        </div>
        <div class="flex items-center justify-end gap-2 mt-1">
          <button qButton type="button" variant="ghost" (click)="cancelled.emit()">Cancel</button>
          <button qButton type="submit" variant="primary" [loading]="busy()" [disabled]="!ready()" data-testid="git-worktree-create">Create worktree</button>
        </div>
      </form>
    </div>
  `,
  host: { class: 'contents' },
})
export class GitWorktreeDialog {
  private readonly actions = inject(GitWorktreeActions);

  /** The main worktree's folder, which the default folder goes beside. */
  readonly mainPath = input.required<string>();
  readonly created = output<GitWorktree>();
  readonly cancelled = output<void>();

  protected readonly branches = invokeResource<GitBranch[]>('git.branch.list');
  /** Local branches git would check out in a new worktree: not the current one, nor one another worktree has. */
  protected readonly free = computed(() => (this.branches.value() ?? []).filter((b) => !b.remote && !b.current && !b.worktreePath));
  protected readonly currentBranch = computed(() => (this.branches.value() ?? []).find((b) => b.current)?.name ?? null);

  protected readonly draft = signal<Draft>({ mode: 'new', branch: '', newBranch: '', from: '', path: '' });
  protected readonly draftForm = form(this.draft);
  protected readonly pathEdited = signal(false);
  protected readonly busy = signal(false);
  private readonly pathInput = viewChild<ElementRef<HTMLInputElement>>('pathInput');

  private readonly branchName = computed(() => {
    const d = this.draft();
    return (d.mode === 'new' ? d.newBranch : d.branch).trim();
  });
  protected readonly ready = computed(() => !this.busy() && Boolean(this.branchName()) && Boolean(this.draft().path.trim()));

  constructor() {
    // The first free branch is picked once the list is in.
    effect(() => {
      const first = this.free()[0]?.name ?? '';
      if (!untracked(this.draft).branch && first) this.draft.update((d) => ({ ...d, branch: first }));
    });
    // The folder follows the branch until it is edited by hand.
    effect(() => {
      const name = this.branchName();
      const main = this.mainPath();
      if (untracked(this.pathEdited)) return;
      const path = name ? defaultWorktreePath(main, name) : '';
      if (untracked(this.draft).path !== path) this.draft.update((d) => ({ ...d, path }));
    });
    // A filled-in folder shows its end, the part that names the worktree, rather than the drive and user folders.
    afterRenderEffect(() => {
      this.draft().path;
      const el = this.pathInput()?.nativeElement;
      if (el && !untracked(this.pathEdited) && document.activeElement !== el) el.scrollLeft = el.scrollWidth;
    });
  }

  protected async submit(event: Event): Promise<void> {
    event.preventDefault();
    if (!this.ready()) return;
    const d = this.draft();
    this.busy.set(true);
    const made = await this.actions.add(
      d.mode === 'new' ? { newBranch: d.newBranch.trim(), path: d.path.trim(), ...(d.from.trim() ? { from: d.from.trim() } : {}) } : { branch: d.branch, path: d.path.trim() },
    );
    this.busy.set(false);
    if (made) this.created.emit(made);
  }
}
