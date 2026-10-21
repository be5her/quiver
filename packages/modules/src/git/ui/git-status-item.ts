import { Component, computed, inject } from '@angular/core';
import type { GitStatus } from '@quiver/core';
import { AppState, Icon, invokeResource } from '@quiver/ui';
import { ArrowDown, ArrowUp, GitBranch } from 'lucide';
import { injectGitChanged } from './git-events';

/** The status bar's branch: the current branch (or the detached commit) with ahead and behind; a click opens Git. Nothing outside a repository. */
@Component({
  selector: 'q-git-status-item',
  imports: [Icon],
  template: `
    @if (current(); as s) {
      <button type="button" class="flex items-center gap-1 min-w-0 hover:text-fg" data-testid="git-status-item" [attr.data-branch]="s.branch" [attr.data-ahead]="s.ahead" [attr.data-behind]="s.behind" [title]="title()" (click)="open()">
        <svg [qIcon]="icons.GitBranch" class="size-3 shrink-0"></svg>
        <span class="truncate max-w-48 font-mono">{{ s.branch ?? s.head?.slice(0, 7) ?? 'no commits' }}</span>
        @if (s.operation) {
          <span class="text-warning">{{ s.operation }}</span>
        }
        @if (s.ahead) {
          <span class="flex items-center shrink-0"><svg [qIcon]="icons.ArrowUp" class="size-3"></svg>{{ s.ahead }}</span>
        }
        @if (s.behind) {
          <span class="flex items-center shrink-0"><svg [qIcon]="icons.ArrowDown" class="size-3"></svg>{{ s.behind }}</span>
        }
      </button>
    }
  `,
  host: { class: 'contents' },
})
export class GitStatusItem {
  private readonly app = inject(AppState);
  protected readonly icons = { ArrowDown, ArrowUp, GitBranch };
  // Only the branch: git leaves out the untracked files and submodules, the bulk of a status in a big repository.
  private readonly status = invokeResource<GitStatus>('git.status', () => ({ files: false }));
  /** The status of the workspace on screen; nothing while another's is the latest, or outside a repository. */
  protected readonly current = computed(() => (this.status.currentError() ? undefined : this.status.current()));
  protected readonly title = computed(() => {
    const s = this.current();
    if (!s) return '';
    const where = s.branch ? `On ${s.branch}` : `Detached at ${s.head?.slice(0, 7) ?? 'no commit'}`;
    const tracking = s.upstream ? `tracking ${s.upstream}: ${s.ahead} ahead, ${s.behind} behind` : 'no upstream';
    return [where, tracking, s.operation ? `A ${s.operation} is in progress` : '', 'Click to open Git'].filter(Boolean).join('\n');
  });

  constructor() {
    // The host's repository watcher announces commits, checkouts and fetches; edits to working files do not move the branch.
    injectGitChanged((p) => {
      if (p.reason === 'status' || p.reason === 'branches') this.status.reload();
    });
  }

  protected open(): void {
    this.app.setActiveModule('git');
  }
}
