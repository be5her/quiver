import { Component, Service, computed, effect, inject, input, linkedSignal, model, signal } from '@angular/core';
import { buildFileTree, fileTreeItems, type GitDiffFile, type GitFileContent } from '@quiver/core';
import { Button, ContextMenu, DiffEditor, EmptyState, HostBridge, Segment, Segmented, Spinner } from '@quiver/ui';
import { FileUser } from 'lucide';
import { GitFileLayoutPref, GitFileLayoutToggle, GitFileRowDef, GitFileTree } from './file-tree';
import { GitActions } from './git-actions';
import { applyPatch, codeClass, diffCode, languageForPath, parsePatch, splitPath, splitRows, type BlameAt, type DiffBase, type PatchRow, type SplitCell } from './git-format';

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
      <div class="p-4 flex flex-col items-start gap-2 text-xs text-muted" data-testid="git-patch-note" data-conflict="true">
        <p>This file has merge conflicts.</p>
        <button qButton size="sm" variant="secondary" data-testid="git-conflict-open" (click)="actions.openConflict(f.path)">Open conflict editor</button>
      </div>
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
  imports: [Button],
})
export class GitPatch {
  protected readonly actions = inject(GitActions);
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

/** Whether a file's diff can be drawn whole: a text patch with hunks, not a conflict's combined diff. */
function drawableWhole(f: GitDiffFile): boolean {
  return !f.binary && f.patch !== undefined && !f.patch.startsWith('diff --cc ') && /^@@ /m.test(f.patch);
}

/**
 * One file side by side in the shared CodeMirror merge view, whole, with unchanged stretches folded: the old side is
 * read with `git.file.show` from the base, the new side worked out from it and the patch (`applyPatch`). When the old
 * side cannot be had (over 2 MB, binary, gone) or the patch does not fit it, the file is drawn from its hunks instead.
 */
@Component({
  selector: 'q-git-full-diff',
  imports: [DiffEditor, GitPatch, Spinner],
  template: `
    @if (sides(); as s) {
      <q-diff-editor class="rounded-none border-0" [left]="s.left" [right]="s.right" [language]="language()" data-testid="git-full-diff" [attr.data-path]="file().path" />
    } @else if (failed()) {
      <q-git-patch class="block h-full overflow-auto" [file]="file()" mode="split" />
    } @else {
      <div class="flex items-center justify-center h-full"><svg qSpinner></svg></div>
    }
  `,
  host: { class: 'block h-full min-h-0' },
})
export class GitFullDiff {
  private readonly host = inject(HostBridge);

  readonly file = input.required<GitDiffFile>();
  readonly base = input.required<DiffBase>();

  /** The old side, kept with the file it was read for: a reload brings a new file object, and a stale side is never paired with it. */
  private readonly loaded = signal<{ file: GitDiffFile; left: string | null } | null>(null);
  protected readonly language = computed(() => languageForPath(this.file().path));
  protected readonly sides = computed(() => {
    const l = this.loaded();
    if (!l || l.file !== this.file() || l.left === null) return null;
    const right = applyPatch(l.left, this.file().patch ?? '');
    return right === null ? null : { left: l.left, right };
  });
  protected readonly failed = computed(() => this.loaded()?.file === this.file() && !this.sides());

  constructor() {
    effect((onCleanup) => {
      const file = this.file();
      const base = this.base();
      let live = true;
      onCleanup(() => (live = false));
      void this.read(file, base).then((left) => {
        if (live) this.loaded.set({ file, left });
      });
    });
  }

  private async read(file: GitDiffFile, base: DiffBase): Promise<string | null> {
    if (file.status === 'added') return '';
    try {
      const at = 'index' in base ? { index: true } : { ref: base.ref };
      return (await this.host.invoke<GitFileContent>('git.file.show', { path: file.origPath ?? file.path, ...at })).content ?? null;
    } catch {
      return null;
    }
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
 * right, side by side as whole files when `base` says where the old sides are, else from the hunks. Untracked files
 * are not in a git diff; `note` explains an empty list.
 */
@Component({
  selector: 'q-git-diff-view',
  imports: [Button, EmptyState, GitDiffMode, GitFileLayoutToggle, GitFileRowDef, GitFileTree, GitFullDiff, GitPatch],
  template: `
    @if (!files().length) {
      <q-empty-state [title]="emptyTitle()" [hint]="emptyHint()" data-testid="git-diff-empty" />
    } @else {
      <div class="flex h-full min-h-0">
        @if (files().length > 1) {
          <div class="w-64 shrink-0 border-r border-edge flex flex-col min-h-0" data-testid="git-diff-files">
            <div class="flex items-center gap-1 pl-2 pr-1 h-7 shrink-0 border-b border-edge/60">
              <span class="text-[11px] text-muted flex-1">{{ files().length }} files</span>
              <q-git-file-layout-toggle />
            </div>
            <q-git-file-tree class="flex-1 min-h-0 overflow-y-auto py-1" [files]="files()">
              <ng-template qGitFileRow let-f let-tree="tree" let-indent="indent">
                <button
                  type="button"
                  class="w-full flex items-center gap-1.5 pr-2 h-7 text-left text-[13px] hover:bg-elevated focus-visible:bg-elevated outline-none min-w-0"
                  [class.bg-elevated]="f.path === current()?.path"
                  [style.padding-left.px]="indent"
                  [title]="f.origPath ? f.origPath + ' → ' + f.path : f.path"
                  data-tree-row
                  data-testid="git-diff-file"
                  [attr.data-path]="f.path"
                  (click)="selected.set(f.path)"
                  (contextmenu)="fileMenu($event, f)"
                >
                  <span class="font-mono text-[11px] font-bold w-3 shrink-0" [class]="codeClass(code(f))">{{ code(f) }}</span>
                  <span class="truncate" [class.flex-1]="tree">{{ name(f.path) }}</span>
                  @if (!tree) {
                    <span class="truncate text-[11px] text-muted flex-1 min-w-0">{{ dir(f.path) }}</span>
                  }
                  <span class="text-[10px] text-success shrink-0">+{{ f.additions }}</span>
                  <span class="text-[10px] text-danger shrink-0">-{{ f.deletions }}</span>
                </button>
              </ng-template>
            </q-git-file-tree>
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
              @if (blameTarget(f); as at) {
                <button qButton size="sm" variant="ghost" [icon]="icons.FileUser" title="Who last changed each line of this file" data-testid="git-diff-blame" (click)="actions.openBlame(at.path, at.ref)">Blame</button>
              }
              <q-git-diff-mode [(mode)]="mode" />
            </div>
            @if (base(); as b) {
              @if (mode() === 'split' && whole(f)) {
                <q-git-full-diff class="flex-1 min-h-0" [file]="f" [base]="b" />
              } @else {
                <q-git-patch class="flex-1 min-h-0 overflow-auto" [file]="f" [mode]="mode()" />
              }
            } @else {
              <q-git-patch class="flex-1 min-h-0 overflow-auto" [file]="f" [mode]="mode()" />
            }
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
  /** Where the old sides are read from, for the whole-file view; without it (a pull request's files) only the hunks show. */
  readonly base = input<DiffBase | null>(null);
  /** Side by side or inline, the same for every diff. */
  protected readonly mode = inject(GitDiffPrefs).mode;
  /**
   * Where a file's Blame opens: a ref (the commit shown, the ref compared to), null for the working tree, undefined
   * for no Blame (a pull request's files, whose commits may not be local).
   */
  readonly blameAt = input<string | null | undefined>(undefined);
  protected readonly actions = inject(GitActions);
  private readonly contextMenu = inject(ContextMenu);
  protected readonly icons = { FileUser };

  /** The file and ref Blame opens; a deleted file is blamed where it still was, on the old side. */
  protected blameTarget(f: GitDiffFile): BlameAt | null {
    const at = this.blameAt();
    if (at === undefined) return null;
    if (f.status === 'deleted') {
      const base = this.base();
      return { path: f.origPath ?? f.path, ref: base && 'ref' in base ? base.ref : 'HEAD' };
    }
    return { path: f.path, ...(at ? { ref: at } : {}) };
  }

  /** Right-click on a file in the list: Blame, where the diff has one. */
  protected fileMenu(event: MouseEvent, f: GitDiffFile): void {
    const at = this.blameTarget(f);
    if (!at) return;
    this.contextMenu.open(event, [{ label: 'Blame', testId: 'git-menu-blame', select: () => this.actions.openBlame(at.path, at.ref) }]);
  }

  private readonly tree = inject(GitFileLayoutPref).tree;
  /** The file shown when none is picked: the first row of the list, which in a tree is the first file under the first folder. */
  private readonly first = computed<GitDiffFile | undefined>(() => {
    const files = this.files();
    if (!this.tree() || files.length < 2) return files[0];
    return buildFileTree(files, { compact: true }).flatMap((n) => fileTreeItems(n))[0];
  });

  protected readonly current = computed<GitDiffFile | undefined>(() => this.files().find((f) => f.path === this.selected()) ?? this.first());
  protected readonly code = diffCode;
  protected readonly codeClass = codeClass;
  protected readonly whole = drawableWhole;

  protected name(p: string): string {
    return splitPath(p).name;
  }

  protected dir(p: string): string {
    return splitPath(p).dir;
  }
}
