import { Component, computed, effect, inject, input, linkedSignal, signal, untracked, viewChild } from '@angular/core';
import { DEFAULT_MARKER_SIZE, conflictMarkerLines, conflictedPaths, dropAddedFinalNewline, type GitConflict, type GitConflictKind, type GitStatus } from '@quiver/core';
import { AppState, Badge, Button, CodeEditor, ConflictEditor, Dialogs, EmptyState, HostBridge, Icon, IconButton, Spinner, TabsState, Toasts, invokeResource, type Tab, type TabComponent } from '@quiver/ui';
import { Check, ChevronDown, ChevronUp, FileUser, GitMerge, RefreshCw } from 'lucide';
import { GitActions } from './git-actions';
import { injectGitChanged, injectReloadWhenShown, tabVisible } from './git-events';
import { errorReason, languageForPath } from './git-format';

type View = 'loading' | 'error' | 'resolved' | 'text' | 'one-sided' | 'whole';
type Take = 'ours' | 'theirs' | 'base' | 'delete';
/** The text being edited and the file on disk it started from (both with LF line breaks). */
interface Edit {
  base: string;
  text: string;
}

const KIND_TEXT: Record<GitConflictKind, string> = {
  'both-modified': 'Both modified',
  'both-added': 'Both added',
  'both-deleted': 'Both deleted',
  'deleted-by-us': 'Deleted by current',
  'deleted-by-them': 'Deleted by incoming',
  'added-by-us': 'Added by current',
  'added-by-them': 'Added by incoming',
};

/**
 * One conflicted file: its text with the conflicts highlighted and editable, an accept bar per conflict, a counter
 * with previous and next, whole-file takes and Mark resolved; a file one side deleted gets Keep or Delete, a binary
 * one only the whole-file takes. Once it is resolved, the tab says what is left to do.
 */
@Component({
  selector: 'q-git-conflict-tab',
  imports: [Badge, Button, CodeEditor, ConflictEditor, EmptyState, Icon, IconButton, Spinner],
  template: `
    @let c = conflict.value();
    <div class="flex flex-col h-full min-h-0 w-full" data-testid="git-conflict-tab" [attr.data-path]="path()" [attr.data-view]="view()">
      <div class="flex items-center gap-2 px-3 h-10 border-b border-edge shrink-0">
        <svg [qIcon]="icons.GitMerge" class="size-4 text-warning shrink-0"></svg>
        <span class="font-medium text-sm truncate min-w-0" [title]="path()">{{ path() }}</span>
        @if (c && view() !== 'resolved') {
          <span qBadge class="shrink-0" data-testid="git-conflict-kind" [attr.data-kind]="c.kind">{{ kindText(c.kind) }}</span>
          <span class="text-xs text-muted truncate min-w-0 flex items-center gap-1.5" data-testid="git-conflict-labels" [attr.data-ours]="c.labels.ours" [attr.data-theirs]="c.labels.theirs">
            <span class="inline-block size-2 rounded-sm bg-accent/60 shrink-0"></span>Current: {{ c.labels.ours }}
            <span class="inline-block size-2 rounded-sm bg-warning/60 shrink-0 ml-1.5"></span>Incoming: {{ c.labels.theirs }}
          </span>
        }
        <span class="flex-1"></span>
        @if (c && view() !== 'resolved') {
          @if (blameRef(c, 'ours'); as ref) {
            <button qButton size="sm" variant="ghost" [icon]="icons.FileUser" data-testid="git-conflict-blame-ours" [attr.data-ref]="ref" [title]="'Blame the file at ' + c.labels.ours" (click)="actions.openBlame(path(), ref)">Blame current</button>
          }
          @if (blameRef(c, 'theirs'); as ref) {
            <button qButton size="sm" variant="ghost" [icon]="icons.FileUser" data-testid="git-conflict-blame-theirs" [attr.data-ref]="ref" [title]="'Blame the file at ' + c.labels.theirs" (click)="actions.openBlame(path(), ref)">Blame incoming</button>
          }
        }
        <button qButton size="sm" variant="ghost" [icon]="icons.RefreshCw" [loading]="conflict.isLoading()" (click)="reload()">Refresh</button>
      </div>
      @switch (view()) {
        @case ('loading') {
          <div class="flex items-center justify-center flex-1"><svg qSpinner></svg></div>
        }
        @case ('error') {
          <p class="p-4 text-sm text-danger" data-testid="git-conflict-error">{{ conflict.error()?.message }}</p>
        }
        @case ('resolved') {
          <q-empty-state class="flex-1" [title]="'No conflict left in ' + name()" [hint]="resolvedHint()" data-testid="git-conflict-resolved">
            @if (remaining().length) {
              <div class="flex flex-col gap-1 items-center">
                @for (p of remaining(); track p) {
                  <button type="button" class="text-xs text-accent hover:underline" data-testid="git-conflict-next-file" [attr.data-path]="p" (click)="actions.openConflict(p)">{{ p }}</button>
                }
              </div>
            } @else if (operation(); as op) {
              <div class="flex items-center gap-2">
                <button qButton size="sm" variant="primary" data-testid="git-conflict-continue" (click)="actions.operation('continue', op)">Continue {{ op }}</button>
                <button qButton size="sm" variant="secondary" (click)="showSidebar()">Show in Git sidebar</button>
              </div>
            }
          </q-empty-state>
        }
        @case ('text') {
          <div class="flex items-center gap-1.5 px-3 h-9 border-b border-edge shrink-0 text-xs" data-testid="git-conflict-toolbar">
            <span class="text-muted tabular-nums" data-testid="git-conflict-counter" [attr.data-count]="count()">{{ counter() }}</span>
            <button qIconButton label="Previous conflict" size="sm" data-testid="git-conflict-prev" [disabled]="!count()" (click)="step(-1)"><svg [qIcon]="icons.ChevronUp" class="size-3.5"></svg></button>
            <button qIconButton label="Next conflict" size="sm" data-testid="git-conflict-next" [disabled]="!count()" (click)="step(1)"><svg [qIcon]="icons.ChevronDown" class="size-3.5"></svg></button>
            <span class="w-px h-4 bg-edge mx-1"></span>
            <button qButton size="sm" variant="ghost" data-testid="git-conflict-take-ours" [disabled]="busy()" [title]="'Resolve with the whole file as ' + (c?.labels.ours ?? 'current') + ' has it'" (click)="take('ours')">Take current</button>
            <button qButton size="sm" variant="ghost" data-testid="git-conflict-take-theirs" [disabled]="busy()" [title]="'Resolve with the whole file as ' + (c?.labels.theirs ?? 'incoming') + ' has it'" (click)="take('theirs')">Take incoming</button>
            <span class="flex-1"></span>
            <button
              qButton
              size="sm"
              variant="primary"
              [icon]="icons.Check"
              [loading]="busy()"
              [disabled]="count() > 0 || leftover().length > 0 || busy()"
              [title]="count() ? 'Resolve every conflict first: ' + count() + ' left' : leftover().length ? 'Remove the leftover conflict marker first' : 'Save the file and stage it'"
              data-testid="git-conflict-mark-resolved"
              (click)="markResolved()"
            >
              Mark resolved
            </button>
          </div>
          @if (c?.operation === 'rebase') {
            <p class="px-3 py-1.5 text-[11px] text-muted border-b border-edge" data-testid="git-conflict-rebase-note">
              In a rebase, current is {{ c?.labels.ours }}, the branch being rebased onto, and incoming is the commit being replayed.
            </p>
          }
          @if (changedOnDisk()) {
            <div class="flex items-center gap-2 px-3 py-1 text-[11px] text-warning border-b border-edge" data-testid="git-conflict-changed-on-disk">
              <span class="flex-1 min-w-0">The file changed on disk since you started editing it here.</span>
              <button qButton size="sm" variant="ghost" data-testid="git-conflict-use-disk" (click)="useDisk()">Use the file on disk</button>
            </div>
          }
          <q-conflict-editor
            class="flex-1 min-h-0 rounded-none border-0"
            [value]="draft()"
            (valueChange)="setDraft($event)"
            [language]="language()"
            [labels]="c?.labels ?? { ours: '', theirs: '' }"
            [markerSize]="markerSize()"
            data-testid="git-conflict-editor"
          />
        }
        @case ('one-sided') {
          <div class="flex flex-col gap-3 p-4 text-sm" data-testid="git-conflict-one-sided">
            <p class="text-muted" data-testid="git-conflict-explain">{{ oneSidedText() }}</p>
            <div class="flex items-center gap-2">
              @if (kept(); as k) {
                <button qButton size="sm" variant="primary" [loading]="busy()" data-testid="git-conflict-keep" (click)="take(k)">Keep the file</button>
              }
              <button qButton size="sm" variant="secondary" [loading]="busy()" data-testid="git-conflict-delete" (click)="take('delete')">Delete the file</button>
            </div>
          </div>
          @if (keptText() !== null) {
            <q-code-editor class="flex-1 min-h-0 rounded-none border-0 border-t" [value]="keptText() ?? ''" [language]="language()" readonly searchable />
          }
        }
        @case ('whole') {
          <div class="flex flex-col gap-3 p-4 text-sm" data-testid="git-conflict-whole">
            <p class="text-muted" data-testid="git-conflict-explain">{{ wholeText() }}</p>
            <div class="flex items-center gap-2">
              <button qButton size="sm" variant="secondary" [loading]="busy()" data-testid="git-conflict-take-ours" (click)="take('ours')">Take current ({{ c?.labels.ours }})</button>
              <button qButton size="sm" variant="secondary" [loading]="busy()" data-testid="git-conflict-take-theirs" (click)="take('theirs')">Take incoming ({{ c?.labels.theirs }})</button>
            </div>
          </div>
        }
      }
    </div>
  `,
  // Edits made in another editor are not watched; coming back to the window picks them up.
  host: { class: 'contents', '(window:focus)': 'reloadShown()' },
})
export class GitConflictTab implements TabComponent {
  protected readonly actions = inject(GitActions);
  private readonly host = inject(HostBridge);
  private readonly app = inject(AppState);
  private readonly tabs = inject(TabsState);
  private readonly dialogs = inject(Dialogs);
  private readonly toasts = inject(Toasts);
  private readonly editor = viewChild(ConflictEditor);

  readonly tab = input.required<Tab>();
  readonly scope = input.required<string>();

  protected readonly icons = { Check, ChevronDown, ChevronUp, FileUser, GitMerge, RefreshCw };

  /** The commit to blame a side at, when that side has the file: who wrote the current or the incoming lines. */
  protected blameRef(c: GitConflict, side: 'ours' | 'theirs'): string | null {
    const without: GitConflictKind[] = side === 'ours' ? ['deleted-by-us', 'added-by-them', 'both-deleted'] : ['deleted-by-them', 'added-by-us', 'both-deleted'];
    return without.includes(c.kind) ? null : (c.commits?.[side] ?? null);
  }
  protected readonly path = computed(() => String(this.tab().data?.['path'] ?? ''));
  protected readonly name = computed(() => this.path().split('/').pop() ?? this.path());
  protected readonly language = computed(() => languageForPath(this.path()));

  protected readonly conflict = invokeResource<GitConflict>('git.conflict.get', () => ({ path: this.path() }), { enabled: () => Boolean(this.path()) });
  private readonly resolved = computed(() => errorReason(this.conflict.error()) === 'not-unmerged');
  /** Once resolved: the other files still in conflict, and the operation to continue. */
  private readonly status = invokeResource<GitStatus>('git.status', () => ({}), { enabled: this.resolved });
  protected readonly remaining = computed(() => conflictedPaths(this.status.value()?.files ?? []).filter((p) => p !== this.path()));
  protected readonly operation = computed(() => this.status.value()?.operation);

  protected readonly view = computed<View>(() => {
    if (this.resolved()) return 'resolved';
    if (this.conflict.error()) return 'error';
    const c = this.conflict.value();
    if (!c) return 'loading';
    if (c.kind !== 'both-modified' && c.kind !== 'both-added') return 'one-sided';
    if (c.binary || c.tooLarge || c.working === null) return 'whole';
    return 'text';
  });

  /** The file on disk. */
  private readonly working = computed(() => this.conflict.value()?.working ?? null);
  /** Whether the file uses CRLF: CodeMirror edits with LF, and the file is written back as it was. */
  private readonly crlf = computed(() => /\r\n/.test(this.working() ?? ''));
  private readonly diskText = computed(() => (this.working() ?? '').replace(/\r\n/g, '\n'));
  protected readonly markerSize = computed(() => this.conflict.value()?.markerSize ?? DEFAULT_MARKER_SIZE);
  /** Follows the file on disk while nothing was edited here; keeps the edits (and what they started from) otherwise. */
  private readonly edit = linkedSignal<string, Edit>({
    source: this.diskText,
    computation: (text, previous) => (previous && previous.value.text !== previous.value.base ? previous.value : { base: text, text }),
  });
  protected readonly draft = computed(() => this.edit().text);
  /** Edits made here and not written yet; the tab asks before it is closed with them. */
  protected readonly dirty = computed(() => this.view() === 'text' && this.edit().text !== this.diskText());
  protected readonly changedOnDisk = computed(() => {
    const edit = this.edit();
    return this.view() === 'text' && edit.text !== edit.base && edit.base !== this.diskText();
  });
  protected readonly count = computed(() => this.editor()?.count() ?? 0);
  /** Start, base or end marker lines left once no whole conflict is (one half deleted by hand). */
  protected readonly leftover = computed(() => (this.count() ? [] : conflictMarkerLines(this.draft(), this.markerSize())));
  /** The conflict the counter is on, 0-based. */
  private readonly index = signal(0);
  protected readonly counter = computed(() => {
    const n = this.count();
    const left = this.leftover();
    if (!n && left.length) return `A conflict marker is left on line ${left.join(', ')}`;
    return n ? `Conflict ${Math.min(this.index(), n - 1) + 1} of ${n}` : 'No conflicts left';
  });
  protected readonly busy = signal(false);

  protected readonly resolvedHint = computed(() => {
    const left = this.remaining().length;
    if (left) return `${left} other file${left === 1 ? ' is' : 's are'} still in conflict:`;
    const op = this.operation();
    return op ? `Nothing is left in conflict. Continue the ${op} to go on, as the banner in the Git sidebar offers.` : 'Nothing is left in conflict.';
  });

  /** What Keep the file takes when one side deleted it: the side that still has it. */
  protected readonly kept = computed<Take | null>(() => {
    const kind = this.conflict.value()?.kind;
    return kind === 'deleted-by-them' || kind === 'added-by-us' ? 'ours' : kind === 'deleted-by-us' || kind === 'added-by-them' ? 'theirs' : null;
  });
  protected readonly keptText = computed(() => {
    const c = this.conflict.value();
    const k = this.kept();
    return !c || !k ? null : k === 'ours' ? c.ours : c.theirs;
  });
  protected readonly oneSidedText = computed(() => {
    const c = this.conflict.value();
    if (!c) return '';
    const { ours, theirs } = c.labels;
    switch (c.kind) {
      case 'deleted-by-them':
        return `${ours} (current) changed this file and ${theirs} (incoming) deleted it. Keep it as current has it, or delete it.`;
      case 'deleted-by-us':
        return `${ours} (current) deleted this file and ${theirs} (incoming) changed it. Keep it as incoming has it, or delete it.`;
      case 'added-by-us':
        return `Only ${ours} (current) has this file here: it added it, or a rename on one side moved it here. Keep it, or delete it.`;
      case 'added-by-them':
        return `Only ${theirs} (incoming) has this file here: it added it, or a rename on one side moved it here. Keep it, or delete it.`;
      default:
        return 'Both sides deleted this file (each renamed it to something else, say). Delete it to mark it resolved.';
    }
  });
  protected readonly wholeText = computed(() => {
    const c = this.conflict.value();
    if (!c) return '';
    if (c.binary) return 'This file is binary (or a submodule), so it cannot be merged line by line. Take one side as a whole.';
    if (c.tooLarge) return 'This file is over 2 MB, too large to edit here. Take one side as a whole, or resolve it in your editor.';
    return 'The file is not on disk as a regular file (it was deleted, or it is a symbolic link). Take one side as a whole.';
  });

  protected readonly reloadShown = injectReloadWhenShown(tabVisible(this.tab, this.scope), () => this.reload());

  constructor() {
    injectGitChanged((p) => {
      if (p.reason === 'status') this.reloadShown();
    });
    effect(() => {
      const dirty = this.dirty();
      const tab = this.tab();
      if (Boolean(tab.dirty) !== dirty) untracked(() => this.tabs.updateTab(this.scope(), tab.id, { dirty }));
    });
  }

  protected setDraft(text: string): void {
    this.edit.update((edit) => ({ ...edit, text }));
  }

  /** Drop the edits made here for the file as it is on disk now. */
  protected useDisk(): void {
    const text = this.diskText();
    this.edit.set({ base: text, text });
  }

  protected kindText(kind: GitConflictKind): string {
    return KIND_TEXT[kind];
  }

  protected reload(): void {
    this.conflict.reload();
    this.status.reload();
  }

  protected step(by: 1 | -1): void {
    const n = this.count();
    if (!n) return;
    const next = (((Math.min(this.index(), n - 1) + by) % n) + n) % n;
    this.index.set(next);
    this.editor()?.goTo(next);
  }

  protected showSidebar(): void {
    this.app.setActiveModule('git');
  }

  /** Save the edited file and stage it; the host refuses it while markers are left. */
  protected async markResolved(): Promise<void> {
    const c = this.conflict.value();
    const text = c ? dropAddedFinalNewline(this.draft(), { working: this.diskText(), ours: c.ours, theirs: c.theirs }, this.markerSize()) : this.draft();
    await this.resolve({ content: this.crlf() ? text.replace(/\n/g, '\r\n') : text }, `Marked ${this.path()} resolved`);
  }

  /** Resolve with a whole side, or delete the file; edits made here are lost, so that asks first when there are some. */
  protected async take(take: Take): Promise<void> {
    if (this.dirty() && !(await this.dialogs.confirm({ title: 'Discard your edits?', message: `The edits made here are replaced by the whole file as ${take === 'ours' ? 'current' : 'incoming'} has it.`, confirmLabel: 'Take it', danger: true }))) return;
    const done = take === 'delete' ? `Deleted ${this.path()}` : `Resolved ${this.path()} with ${take === 'ours' ? 'current' : take === 'theirs' ? 'incoming' : 'the base'}`;
    await this.resolve({ take }, done);
  }

  private async resolve(input: { content: string } | { take: Take }, done: string): Promise<void> {
    this.busy.set(true);
    try {
      await this.host.invoke('git.conflict.resolve', { path: this.path(), ...input });
      // The text is settled: once the file is read again it follows the disk, also when a later step conflicts in it again.
      this.edit.update((edit) => ({ base: edit.text, text: edit.text }));
      this.toasts.notify(done, 'success');
      this.reload();
    } catch (err) {
      this.toasts.error(err);
    } finally {
      this.busy.set(false);
    }
  }
}
