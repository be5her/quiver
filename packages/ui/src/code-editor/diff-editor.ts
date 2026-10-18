import { Component, DestroyRef, ElementRef, afterNextRender, booleanAttribute, computed, effect, inject, input, untracked, viewChild } from '@angular/core';
import { MergeView } from '@codemirror/merge';
import { EditorView } from '@codemirror/view';
import { cn } from '../class-names';
import { AppState } from '../state/app-state';
import { VariableHover } from '../variables/variable-hover';
import { editorExtensions, type CodeLanguage } from './code-editor-extensions';

/** Highlights for changed lines and words, in the app's colours on both themes. */
const diffTheme = EditorView.theme({
  '&.cm-merge-a .cm-changedLine, .cm-deletedChunk': { backgroundColor: 'color-mix(in srgb, var(--color-danger) 12%, transparent)' },
  '&.cm-merge-b .cm-changedLine, .cm-insertedLine': { backgroundColor: 'color-mix(in srgb, var(--color-success) 12%, transparent)' },
  '&.cm-merge-a .cm-changedText, .cm-deletedChunk .cm-deletedText': { background: 'color-mix(in srgb, var(--color-danger) 30%, transparent)' },
  '&.cm-merge-b .cm-changedText': { background: 'color-mix(in srgb, var(--color-success) 30%, transparent)' },
});

/**
 * Two texts side by side with their differences marked (CodeMirror's merge view), read-only, with
 * the app's theme. Unchanged stretches can be collapsed.
 */
@Component({
  selector: 'q-diff-editor',
  template: `<div #container [class]="containerClass()" class="h-full"></div>`,
  host: { class: 'block h-full min-h-0 overflow-hidden rounded-md border border-edge bg-surface' },
  styles: `
    :host ::ng-deep .cm-mergeView {
      height: 100%;
      overflow: auto;
    }
    :host ::ng-deep .cm-mergeViewEditors {
      min-height: 100%;
    }
  `,
})
export class DiffEditor {
  private readonly theme = inject(AppState).resolvedTheme;
  private readonly hover = inject(VariableHover);
  private readonly container = viewChild.required<ElementRef<HTMLDivElement>>('container');
  private view: MergeView | null = null;
  private ready = false;

  readonly left = input('');
  readonly right = input('');
  readonly language = input<CodeLanguage>('text');
  readonly wrap = input(false, { transform: booleanAttribute });
  /** Fold long runs of unchanged lines, leaving a few lines of context around each change. */
  readonly collapseUnchanged = input(true, { transform: booleanAttribute });

  protected readonly containerClass = computed(() => cn(`cm-theme-${this.theme()}`));

  private readonly extensions = computed(() => [
    ...editorExtensions({
      language: this.language(),
      readOnly: true,
      searchable: true,
      placeholder: '',
      filled: false,
      wrap: this.wrap(),
      singleLine: false,
      sqlDialect: 'standard',
      theme: this.theme(),
      variables: null,
      hover: this.hover,
      run: () => undefined,
    }),
    diffTheme,
  ]);

  constructor() {
    afterNextRender(() => {
      this.ready = true;
      this.build();
    });
    // Any change rebuilds the view: both documents and their extensions go together in a merge view.
    effect(() => {
      this.left();
      this.right();
      this.extensions();
      this.collapseUnchanged();
      if (this.ready) untracked(() => this.build());
    });
    inject(DestroyRef).onDestroy(() => this.view?.destroy());
  }

  private build(): void {
    this.view?.destroy();
    const extensions = this.extensions();
    this.view = new MergeView({
      a: { doc: this.left(), extensions },
      b: { doc: this.right(), extensions },
      parent: this.container().nativeElement,
      highlightChanges: true,
      gutter: true,
      ...(this.collapseUnchanged() ? { collapseUnchanged: { margin: 3, minSize: 6 } } : {}),
    });
  }
}
