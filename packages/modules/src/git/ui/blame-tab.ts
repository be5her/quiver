import { Component, computed, inject, input, linkedSignal } from '@angular/core';
import { FormField, form } from '@angular/forms/signals';
import type { GitBlame } from '@quiver/core';
import { Button, Checkbox, CodeEditor, ContextMenu, EmptyState, Icon, Input, Spinner, TabsState, Toasts, invokeResource, type LineMarkerEvent, type Tab, type TabComponent } from '@quiver/ui';
import { ArrowLeft, FileUser, RefreshCw } from 'lucide';
import { GitActions } from './git-actions';
import { injectGitChanged, injectReloadWhenShown, tabVisible } from './git-events';
import { blameBefore, blameKey, blameMarkers, blameText, blameTitle, languageForPath, shortRef, type BlameAt } from './git-format';

/** What a blame tab keeps in its data: the file and ref on screen, the whitespace setting, and where Back goes. */
interface BlameTabData extends BlameAt {
  id: string;
  ignoreWhitespace?: boolean;
  back?: BlameAt[];
}

/**
 * Who last changed each line of a file (`git.blame`), read-only in CodeMirror with a gutter: each run of lines from
 * one commit shows its short hash, author and age once, coloured by age. A click opens the commit; a right-click
 * offers blaming the file as it was before that commit (renames followed), and Back returns. The ref field blames
 * at another ref (empty: the working tree); Ignore whitespace runs `git blame -w`.
 */
@Component({
  selector: 'q-git-blame-tab',
  imports: [Button, Checkbox, CodeEditor, EmptyState, FormField, Icon, Input, Spinner],
  template: `
    <div class="flex flex-col h-full min-h-0 w-full" data-testid="git-blame-tab" [attr.data-path]="at().path" [attr.data-ref]="at().ref ?? ''" [attr.data-loaded]="Boolean(shown())">
      <div class="flex items-center gap-2 px-3 h-10 border-b border-edge shrink-0">
        <svg [qIcon]="icons.FileUser" class="size-4 text-accent shrink-0"></svg>
        <span class="font-medium text-sm truncate min-w-0" [title]="at().path" data-testid="git-blame-path">{{ at().path }}</span>
        <span class="text-xs text-muted truncate shrink-0">{{ at().ref ? 'at ' + shortRef(at().ref!) : 'working tree' }}</span>
        <span class="flex-1"></span>
        <button qButton size="sm" variant="ghost" [icon]="icons.ArrowLeft" [disabled]="!back().length" [title]="backTitle()" data-testid="git-blame-back" (click)="goBack()">Back</button>
        <div class="w-48 shrink-0">
          <input
            qInput
            class="h-7 text-xs font-mono"
            placeholder="Ref, e.g. HEAD~3"
            title="A commit, branch or tag to blame the file at; empty for the working tree. Enter to apply."
            [formField]="refForm.ref"
            data-testid="git-blame-ref"
            (keydown.enter)="applyRef()"
          />
        </div>
        <label class="flex items-center gap-1.5 text-xs text-muted shrink-0" title="Leave whitespace-only changes out when finding the commit of a line (git blame -w)">
          <input type="checkbox" qCheckbox [checked]="ignoreWhitespace()" data-testid="git-blame-whitespace" (change)="toggleWhitespace()" /> Ignore whitespace
        </label>
        <button qButton size="sm" variant="ghost" [icon]="icons.RefreshCw" [loading]="blame.isLoading()" (click)="blame.reload()">Refresh</button>
      </div>
      <div class="flex-1 min-h-0">
        @if (failed(); as e) {
          <p class="p-4 text-sm text-danger" data-testid="git-blame-error">{{ e.message }}</p>
        } @else if (shown(); as b) {
          @if (b.lines.length) {
            <q-code-editor
              class="rounded-none border-0"
              readonly
              searchable
              [value]="content()"
              [language]="language()"
              [lineMarkers]="markers()"
              (lineMarkerClick)="open($event)"
              (lineMarkerMenu)="menu($event)"
              data-testid="git-blame-editor"
            />
          } @else {
            <q-empty-state title="Empty file" hint="There are no lines to blame." />
          }
        } @else {
          <div class="flex items-center justify-center h-full"><svg qSpinner></svg></div>
        }
      </div>
    </div>
  `,
  // Edits to working files are not watched; coming back to the window picks them up.
  host: { class: 'contents', '(window:focus)': '!at().ref && reloadShown()' },
})
export class GitBlameTab implements TabComponent {
  private readonly actions = inject(GitActions);
  private readonly tabs = inject(TabsState);
  private readonly contextMenu = inject(ContextMenu);
  private readonly toasts = inject(Toasts);

  readonly tab = input.required<Tab>();
  readonly scope = input.required<string>();

  protected readonly icons = { ArrowLeft, FileUser, RefreshCw };
  protected readonly Boolean = Boolean;
  protected readonly shortRef = shortRef;
  private readonly data = computed(() => (this.tab().data ?? {}) as Partial<BlameTabData>);
  protected readonly at = computed<BlameAt>(() => {
    const d = this.data();
    return { path: d.path ?? '', ...(d.ref ? { ref: d.ref } : {}) };
  });
  protected readonly ignoreWhitespace = computed(() => Boolean(this.data().ignoreWhitespace));
  protected readonly back = computed(() => this.data().back ?? []);
  protected readonly backTitle = computed(() => {
    const prev = this.back().at(-1);
    return prev ? `Back to ${prev.path}${prev.ref ? ` at ${shortRef(prev.ref)}` : ' in the working tree'}` : '';
  });

  protected readonly blame = invokeResource<GitBlame>('git.blame', () => ({ ...this.at(), ignoreWhitespace: this.ignoreWhitespace() }), { enabled: () => Boolean(this.at().path) });
  /** The blame of the file and ref on screen; one read for the previous ones is not shown while the next loads. */
  protected readonly shown = computed(() => {
    const b = this.blame.value();
    const at = this.at();
    return b && b.path === at.path && (b.ref ?? '') === (at.ref ?? '') ? b : undefined;
  });
  protected readonly failed = computed(() => (this.blame.isLoading() ? null : this.blame.error()));
  protected readonly content = computed(() => blameText(this.shown()?.lines ?? []));
  protected readonly markers = computed(() => {
    const b = this.shown();
    return b ? blameMarkers(b) : null;
  });
  protected readonly language = computed(() => languageForPath(this.at().path));

  /** The ref field; it follows the ref on screen. */
  private readonly refDraft = linkedSignal(() => ({ ref: this.at().ref ?? '' }));
  protected readonly refForm = form(this.refDraft);

  /** Reloads now when the tab is on screen, else once it is shown. */
  protected readonly reloadShown = injectReloadWhenShown(tabVisible(this.tab, this.scope), () => this.blame.reload());

  constructor() {
    injectGitChanged((p) => {
      // A commit, checkout or reset moves HEAD and the index; a ref blamed by name moves with its branch.
      if (p.reason === 'status' && !this.at().ref) this.reloadShown();
      if (p.reason === 'branches') this.reloadShown();
    });
  }

  /** Show another file or ref in this tab; Back returns to the one shown now. */
  private go(next: BlameAt, back: BlameAt[]): void {
    const data: BlameTabData = { ...(this.data() as BlameTabData), id: blameKey(next), path: next.path, back };
    if (next.ref) data.ref = next.ref;
    else delete data.ref;
    this.tabs.updateTab(this.scope(), this.tab().id, { title: blameTitle(next), data: { ...data } });
  }

  protected applyRef(): void {
    const ref = this.refDraft().ref.trim();
    if (ref === (this.at().ref ?? '')) return;
    this.go({ path: this.at().path, ...(ref ? { ref } : {}) }, [...this.back(), this.at()]);
  }

  protected goBack(): void {
    const back = this.back();
    const prev = back.at(-1);
    if (prev) this.go(prev, back.slice(0, -1));
  }

  protected toggleWhitespace(): void {
    this.tabs.updateTab(this.scope(), this.tab().id, { data: { ...this.data(), ignoreWhitespace: !this.ignoreWhitespace() } });
  }

  /** A click on the gutter: the commit, as the history's "Open in a tab" opens it; a line not committed yet opens the working changes. */
  protected open(e: LineMarkerEvent): void {
    const hash = e.marker.id;
    const commit = hash ? this.shown()?.commits[hash] : undefined;
    if (commit) this.actions.openDiff({ kind: 'commit', ref: commit.hash, path: commit.path });
    else if (!hash) this.actions.openDiff({ kind: 'working', path: this.at().path });
  }

  protected menu(e: LineMarkerEvent): void {
    const hash = e.marker.id;
    const commit = hash ? this.shown()?.commits[hash] : undefined;
    if (!commit) {
      this.contextMenu.open(e.event, [{ label: 'Show working changes', testId: 'git-blame-menu-working', select: () => this.actions.openDiff({ kind: 'working', path: this.at().path }) }]);
      return;
    }
    const before = blameBefore(commit);
    this.contextMenu.open(e.event, [
      { label: `Open commit ${commit.hash.slice(0, 7)}`, testId: 'git-blame-menu-open', select: () => this.open(e) },
      {
        label: 'Blame before this commit',
        testId: 'git-blame-menu-before',
        disabled: !before,
        select: () => before && this.go(before, [...this.back(), this.at()]),
      },
      'separator',
      { label: 'Copy hash', testId: 'git-blame-menu-copy', select: () => this.toasts.copy(commit.hash, 'Hash copied') },
    ]);
  }
}
