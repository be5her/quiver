import { Component, Service, computed, inject, input, linkedSignal, model, signal } from '@angular/core';
import type { GitDiffFile } from '@quiver/core';
import { EmptyState, Segment, Segmented } from '@quiver/ui';
import { codeClass, diffCode, parsePatch, splitPath, splitRows, type PatchRow, type SplitCell } from './git-format';

export type DiffMode = 'split' | 'inline';

/** Lines drawn before "Show all": a 512 KB patch is tens of thousands of rows. */
const FIRST_ROWS = 2000;

/** The diff layout picked last, shared by every diff on screen. */
@Service()
export class GitDiffPrefs {
  readonly mode = signal<DiffMode>('split');
}

const ROW_CLASS: Record<string, string> = {
  add: 'bg-success/10',
  del: 'bg-danger/10',
  context: '',
  empty: 'bg-elevated/40',
};

/** One file's unified patch, side by side or inline, with line numbers from its hunks. */
@Component({
  selector: 'q-git-patch',
  template: `
    @let f = file();
    @if (conflicted()) {
      <p class="p-4 text-xs text-muted" data-testid="git-patch-note" data-conflict="true">This file has merge conflicts. Resolve the conflict markers in your editor, then mark it resolved (Stage) in the sidebar.</p>
    } @else if (f.binary) {
      <p class="p-4 text-xs text-muted" data-testid="git-patch-note">Binary file; no text diff.</p>
    } @else if (f.patch === undefined) {
      <p class="p-4 text-xs text-muted" data-testid="git-patch-note">{{ f.truncated ? 'The diff of this file is too large to show.' : 'No changes to show.' }}</p>
    } @else if (!rows().length) {
      <p class="p-4 text-xs text-muted" data-testid="git-patch-note">{{ unchangedNote(f) }}</p>
    } @else {
      <table class="w-full border-collapse font-mono text-[12px] leading-[18px]" data-testid="git-patch" [attr.data-mode]="mode()">
        @if (mode() === 'split') {
          <colgroup><col class="w-12" /><col class="w-1/2" /><col class="w-12" /><col class="w-1/2" /></colgroup>
          @for (row of visibleSplit(); track $index) {
            @switch (row.kind) {
              @case ('pair') {
                <tr>
                  <td class="select-none text-right pr-2 align-top text-muted/70 border-r border-edge" [class]="cellClass(row.left)">{{ row.left.no ?? '' }}</td>
                  <td class="whitespace-pre-wrap break-all pl-2 pr-3 align-top border-r border-edge" [class]="cellClass(row.left)" [attr.data-kind]="row.left.kind">{{ row.left.text }}</td>
                  <td class="select-none text-right pr-2 align-top text-muted/70 border-r border-edge" [class]="cellClass(row.right)">{{ row.right.no ?? '' }}</td>
                  <td class="whitespace-pre-wrap break-all pl-2 pr-3 align-top" [class]="cellClass(row.right)" [attr.data-kind]="row.right.kind">{{ row.right.text }}</td>
                </tr>
              }
              @default {
                <tr>
                  <td colspan="4" class="px-2 py-0.5 text-muted bg-elevated/60 whitespace-pre-wrap break-all">{{ row.text }}</td>
                </tr>
              }
            }
          }
        } @else {
          <colgroup><col class="w-12" /><col class="w-12" /><col class="w-4" /><col /></colgroup>
          @for (row of visibleRows(); track $index) {
            @switch (row.kind) {
              @case ('hunk') {
                <tr>
                  <td colspan="4" class="px-2 py-0.5 text-muted bg-elevated/60 whitespace-pre-wrap break-all">{{ row.text }}</td>
                </tr>
              }
              @case ('note') {
                <tr>
                  <td colspan="4" class="px-2 text-muted italic">{{ row.text }}</td>
                </tr>
              }
              @default {
                <tr [class]="rowClass(row)" [attr.data-kind]="row.kind">
                  <td class="select-none text-right pr-2 align-top text-muted/70">{{ oldNo(row) }}</td>
                  <td class="select-none text-right pr-2 align-top text-muted/70 border-r border-edge">{{ newNo(row) }}</td>
                  <td class="select-none text-center align-top" [class]="row.kind === 'add' ? 'text-success' : row.kind === 'del' ? 'text-danger' : 'text-muted'">{{ sign(row) }}</td>
                  <td class="whitespace-pre-wrap break-all pr-3 align-top">{{ row.text }}</td>
                </tr>
              }
            }
          }
        }
      </table>
      @if (hidden() > 0) {
        <div class="p-2 text-center">
          <button type="button" class="text-xs text-accent hover:underline" (click)="showAll.set(true)">Show {{ hidden() }} more lines</button>
        </div>
      }
    }
  `,
  host: { class: 'block' },
})
export class GitPatch {
  readonly file = input.required<GitDiffFile>();
  readonly mode = input<DiffMode>('split');

  protected readonly showAll = linkedSignal({ source: this.file, computation: () => false });
  /** A file with merge conflicts comes as a combined diff (`diff --cc`, `@@@` hunks), which this view does not draw. */
  protected readonly conflicted = computed(() => this.file().patch?.startsWith('diff --cc ') ?? false);
  protected readonly rows = computed(() => parsePatch(this.file().patch ?? ''));
  private readonly split = computed(() => (this.mode() === 'split' ? splitRows(this.rows()) : []));
  protected readonly visibleRows = computed(() => (this.showAll() ? this.rows() : this.rows().slice(0, FIRST_ROWS)));
  protected readonly visibleSplit = computed(() => (this.showAll() ? this.split() : this.split().slice(0, FIRST_ROWS)));
  protected readonly hidden = computed(() => {
    if (this.showAll()) return 0;
    return Math.max(0, (this.mode() === 'split' ? this.split().length : this.rows().length) - FIRST_ROWS);
  });

  /** Why a file with a patch has no lines to show. */
  protected unchangedNote(f: GitDiffFile): string {
    if (f.status === 'renamed') return 'Renamed without changes.';
    if (f.status === 'copied') return 'Copied without changes.';
    if (f.status === 'added') return 'Empty file added.';
    if (f.status === 'deleted') return 'Empty file deleted.';
    return 'Only the file mode changed.';
  }

  protected cellClass(cell: SplitCell): string {
    return ROW_CLASS[cell.kind];
  }

  protected rowClass(row: PatchRow): string {
    return ROW_CLASS[row.kind] ?? '';
  }

  protected oldNo(row: PatchRow): string {
    return row.kind === 'context' || row.kind === 'del' ? String(row.old) : '';
  }

  protected newNo(row: PatchRow): string {
    return row.kind === 'context' || row.kind === 'add' ? String(row.new) : '';
  }

  protected sign(row: PatchRow): string {
    return row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : '';
  }
}

/** The side-by-side / inline switch. */
@Component({
  selector: 'q-git-diff-mode',
  imports: [Segment, Segmented],
  template: `
    <q-segmented [(value)]="mode" class="border-b-0">
      <button qSegment="split" data-testid="git-diff-split">Side by side</button>
      <button qSegment="inline" data-testid="git-diff-inline">Inline</button>
    </q-segmented>
  `,
})
export class GitDiffMode {
  readonly mode = model.required<DiffMode>();
}

/**
 * Files with their patches: a list of the files on the left when there are several, the picked file's diff on the
 * right. Untracked files are not in a git diff; `note` explains an empty list.
 */
@Component({
  selector: 'q-git-diff-view',
  imports: [EmptyState, GitDiffMode, GitPatch],
  template: `
    @if (!files().length) {
      <q-empty-state [title]="emptyTitle()" [hint]="emptyHint()" data-testid="git-diff-empty" />
    } @else {
      <div class="flex h-full min-h-0">
        @if (files().length > 1) {
          <div class="w-64 shrink-0 border-r border-edge overflow-y-auto py-1" data-testid="git-diff-files">
            @for (f of files(); track f.path) {
              <button
                type="button"
                class="w-full flex items-center gap-1.5 px-2 h-7 text-left text-[13px] hover:bg-elevated min-w-0"
                [class.bg-elevated]="f.path === current()?.path"
                [title]="f.origPath ? f.origPath + ' → ' + f.path : f.path"
                data-testid="git-diff-file"
                [attr.data-path]="f.path"
                (click)="selected.set(f.path)"
              >
                <span class="font-mono text-[11px] font-bold w-3 shrink-0" [class]="codeClass(code(f))">{{ code(f) }}</span>
                <span class="truncate">{{ name(f.path) }}</span>
                <span class="truncate text-[11px] text-muted flex-1 min-w-0">{{ dir(f.path) }}</span>
                <span class="text-[10px] text-success shrink-0">+{{ f.additions }}</span>
                <span class="text-[10px] text-danger shrink-0">-{{ f.deletions }}</span>
              </button>
            }
          </div>
        }
        @if (current(); as f) {
          <div class="flex-1 min-w-0 flex flex-col">
            <div class="flex items-center gap-2 px-3 h-9 border-b border-edge shrink-0">
              <span class="font-mono text-[11px] font-bold" [class]="codeClass(code(f))">{{ code(f) }}</span>
              <span class="text-sm truncate min-w-0" [title]="f.path" data-testid="git-diff-path">{{ f.origPath ? f.origPath + ' → ' + f.path : f.path }}</span>
              <span class="text-[11px] text-success shrink-0">+{{ f.additions }}</span>
              <span class="text-[11px] text-danger shrink-0">-{{ f.deletions }}</span>
              <span class="flex-1"></span>
              <q-git-diff-mode [(mode)]="mode" />
            </div>
            <q-git-patch class="flex-1 min-h-0 overflow-auto" [file]="f" [mode]="mode()" />
          </div>
        }
      </div>
    }
  `,
  host: { class: 'block h-full min-h-0' },
})
export class GitDiffView {
  readonly files = input.required<GitDiffFile[]>();
  readonly emptyTitle = input('No changes');
  readonly emptyHint = input<string | null>(null);
  /** The path picked, two-way so a tab can keep it in its data. */
  readonly selected = model<string | undefined>(undefined);
  /** Side by side or inline, the same for every diff. */
  protected readonly mode = inject(GitDiffPrefs).mode;

  protected readonly current = computed<GitDiffFile | undefined>(() => {
    const files = this.files();
    return files.find((f) => f.path === this.selected()) ?? files[0];
  });
  protected readonly code = diffCode;
  protected readonly codeClass = codeClass;

  protected name(p: string): string {
    return splitPath(p).name;
  }

  protected dir(p: string): string {
    return splitPath(p).dir;
  }
}
