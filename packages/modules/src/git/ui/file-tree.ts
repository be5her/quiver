import { NgTemplateOutlet } from '@angular/common';
import { Component, Directive, ElementRef, Service, TemplateRef, computed, contentChild, inject, input, signal, untracked } from '@angular/core';
import { buildFileTree, fileTreeItems, flattenTree, type FileTreeNode, type FileTreeRow } from '@quiver/core';
import { AppState, HostBridge, Icon, IconButton, Toasts, TreeState, invokeResource } from '@quiver/ui';
import { ChevronDown, ChevronRight, FolderTree, List } from 'lucide';

export type GitFileLayout = 'list' | 'tree';

/** The workspace state key (per machine, under `.quiver/local`) the layout is kept in. */
export const FILE_LAYOUT_KEY = 'git.fileLayout';

/**
 * Whether the git module draws changed files as a list or a tree: one preference for the sidebar, the diff tab, the
 * History and a pull request's Files, kept per machine with the workspace's UI state, so it survives a restart.
 */
@Service()
export class GitFileLayoutPref {
  private readonly host = inject(HostBridge);
  private readonly app = inject(AppState);
  private readonly toasts = inject(Toasts);
  private readonly saved = invokeResource<{ value: unknown }>('workspace.state.get', () => ({ key: FILE_LAYOUT_KEY }), {
    enabled: () => this.app.hasWorkspace(),
    refreshOnState: [FILE_LAYOUT_KEY],
  });
  /** Picked in this window, per workspace, so the switch answers before the write is read back. */
  private readonly picked = signal<Record<string, GitFileLayout>>({});

  readonly layout = computed<GitFileLayout>(() => {
    const id = this.app.activeWorkspaceId();
    const mine = id ? this.picked()[id] : undefined;
    if (mine) return mine;
    return this.saved.current()?.value === 'tree' ? 'tree' : 'list';
  });
  readonly tree = computed(() => this.layout() === 'tree');

  toggle(): void {
    this.set(untracked(this.tree) ? 'list' : 'tree');
  }

  set(layout: GitFileLayout): void {
    const id = untracked(this.app.activeWorkspaceId);
    if (!id) return;
    this.picked.update((p) => ({ ...p, [id]: layout }));
    this.host.invoke('workspace.state.set', { key: FILE_LAYOUT_KEY, value: layout }, id).catch((err) => this.toasts.error(err));
  }
}

/** The View as tree / View as list button. */
@Component({
  selector: 'q-git-file-layout-toggle',
  imports: [Icon, IconButton],
  template: `
    <button qIconButton [label]="pref.tree() ? 'View as list' : 'View as tree'" size="sm" data-testid="git-file-layout" [attr.data-layout]="pref.layout()" (click)="pref.toggle()">
      <svg [qIcon]="pref.tree() ? icons.List : icons.FolderTree" class="size-3.5"></svg>
    </button>
  `,
  host: { class: 'contents' },
})
export class GitFileLayoutToggle {
  protected readonly pref = inject(GitFileLayoutPref);
  protected readonly icons = { FolderTree, List };
}

/** What a file row's template gets: the item, its row, whether the tree is on, and the left padding to draw it with. */
export interface GitFileRowContext<T> {
  $implicit: T;
  row: FileTreeRow<T>;
  tree: boolean;
  indent: number;
}

/** The template of a file row; its root element carries `data-tree-row` and `tabindex` so the keys can move to it. */
@Directive({ selector: 'ng-template[qGitFileRow]' })
export class GitFileRowDef {
  readonly template = inject<TemplateRef<GitFileRowContext<unknown>>>(TemplateRef);
}

/** Buttons shown on a folder row on hover, given every item under the folder and the row. */
@Directive({ selector: 'ng-template[qGitFolderActions]' })
export class GitFolderActionsDef {
  readonly template = inject<TemplateRef<{ $implicit: unknown[]; row: FileTreeRow<unknown> }>>(TemplateRef);
}

/** Per depth level, in px. */
const STEP = 12;
/** A file row sits past its folder's chevron. */
const CHEVRON = 18;

/**
 * Changed files as a flat list or, with the layout set to tree, under folder rows (single-folder chains compacted, as
 * VS Code does) that show their file count, collapse and expand on a click, and carry `qGitFolderActions`. Up and
 * down move between rows, right opens a folder (or goes to its first child), left closes it (or goes to the parent).
 * Which folders are closed is kept under `stateKey` in the workspace's tree state, or by this view alone without one.
 */
@Component({
  selector: 'q-git-file-tree',
  imports: [Icon, NgTemplateOutlet],
  template: `
    @for (row of rows(); track row.kind + ':' + row.path) {
      @if (row.kind === 'folder') {
        <div
          class="group flex items-center gap-1 pr-1 h-6 cursor-pointer hover:bg-elevated focus-visible:bg-elevated outline-none min-w-0"
          role="button"
          tabindex="0"
          data-tree-row
          data-testid="git-folder"
          [attr.data-path]="row.path"
          [attr.data-count]="row.count"
          [attr.data-expanded]="row.expanded"
          [attr.aria-expanded]="row.expanded"
          [style.padding-left.px]="treeIndent() + row.depth * step"
          [title]="row.path + ' · ' + row.count + ' file' + (row.count === 1 ? '' : 's')"
          (click)="toggle(row.path)"
          (keydown.enter)="toggle(row.path)"
        >
          <svg [qIcon]="row.expanded ? icons.ChevronDown : icons.ChevronRight" class="size-3.5 text-muted shrink-0"></svg>
          <span class="truncate text-[13px] flex-1 min-w-0" data-testid="git-folder-name">{{ row.name }}</span>
          @if (folderActions(); as actions) {
            <span class="hidden group-hover:flex items-center" (click)="$event.stopPropagation()">
              <ng-container *ngTemplateOutlet="actions.template; context: { $implicit: itemsOf(row), row }" />
            </span>
          }
          <span class="text-[10px] text-muted bg-elevated rounded-full px-1.5 shrink-0" [class.group-hover:hidden]="Boolean(folderActions())" data-testid="git-folder-count">{{ row.count }}</span>
        </div>
      } @else {
        <ng-container *ngTemplateOutlet="fileRow().template; context: fileContext(row)" />
      }
    }
  `,
  host: { class: 'block', '(keydown)': 'keydown($event)' },
})
export class GitFileTree<T extends { path: string }> {
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly treeState = inject(TreeState);
  private readonly app = inject(AppState);
  private readonly pref = inject(GitFileLayoutPref);

  readonly files = input.required<readonly T[]>();
  /** The tree state key folders' open state goes under; null keeps it in this view only. */
  readonly stateKey = input<string | null>(null);
  /** Left padding of a file row in list mode, and of a top folder row in tree mode, in px. */
  readonly listIndent = input(8);
  readonly treeIndent = input(8);

  protected readonly fileRow = contentChild.required(GitFileRowDef);
  protected readonly folderActions = contentChild(GitFolderActionsDef);
  protected readonly icons = { ChevronDown, ChevronRight };
  protected readonly step = STEP;
  protected readonly Boolean = Boolean;

  /** Folders closed in this view, when there is no state key. */
  private readonly closedHere = signal<ReadonlySet<string>>(new Set());
  protected readonly tree = this.pref.tree;
  private readonly nodes = computed(() => (this.tree() ? buildFileTree(this.files(), { compact: true }) : []));
  private readonly folders = computed(() => {
    const out: string[] = [];
    const walk = (list: FileTreeNode<T>[]) => list.forEach((n) => n.kind === 'folder' && (out.push(n.path), walk(n.children ?? [])));
    walk(this.nodes());
    return out;
  });
  private readonly collapsed = computed<ReadonlySet<string>>(() => {
    const key = this.stateKey();
    if (!key) return this.closedHere();
    return new Set(this.folders().filter((p) => !this.treeState.isExpanded(`${key}/${p}`, true)));
  });
  protected readonly rows = computed<FileTreeRow<T>[]>(() => {
    if (!this.tree()) return this.files().map((item) => ({ name: item.path, path: item.path, kind: 'file', depth: 0, item, expanded: false }));
    return flattenTree(this.nodes(), this.collapsed());
  });

  protected fileContext(row: FileTreeRow<T>): GitFileRowContext<T> {
    const tree = this.tree();
    return { $implicit: row.item as T, row, tree, indent: tree ? this.treeIndent() + row.depth * STEP + CHEVRON : this.listIndent() };
  }

  protected itemsOf(row: FileTreeRow<T>): T[] {
    return fileTreeItems(row);
  }

  protected toggle(path: string): void {
    this.setOpen(path, untracked(this.collapsed).has(path));
  }

  private setOpen(path: string, open: boolean): void {
    const key = untracked(this.stateKey);
    if (key) this.treeState.set(untracked(this.app.scope), `${key}/${path}`, open);
    else
      this.closedHere.update((s) => {
        const next = new Set(s);
        if (open) next.delete(path);
        else next.add(path);
        return next;
      });
  }

  protected keydown(event: KeyboardEvent): void {
    if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const target = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-tree-row]');
    if (!target) return;
    const els = [...this.el.nativeElement.querySelectorAll<HTMLElement>('[data-tree-row]')];
    const at = els.indexOf(target);
    const rows = this.rows();
    const row = rows[at];
    if (at < 0 || !row) return;
    event.preventDefault();
    const focus = (i: number) => els[Math.max(0, Math.min(els.length - 1, i))]?.focus();
    switch (event.key) {
      case 'ArrowDown':
        return focus(at + 1);
      case 'ArrowUp':
        return focus(at - 1);
      case 'Home':
        return focus(0);
      case 'End':
        return focus(els.length - 1);
      case 'ArrowRight':
        if (row.kind === 'folder' && !row.expanded) return this.setOpen(row.path, true);
        if (row.kind === 'folder') return focus(at + 1);
        return;
      case 'ArrowLeft': {
        if (row.kind === 'folder' && row.expanded) return this.setOpen(row.path, false);
        for (let i = at - 1; i >= 0; i--) if (rows[i].kind === 'folder' && rows[i].depth < row.depth) return focus(i);
        return;
      }
    }
  }
}
