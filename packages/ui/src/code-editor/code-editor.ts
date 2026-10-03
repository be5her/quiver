import { Component, DestroyRef, ElementRef, afterNextRender, booleanAttribute, computed, effect, inject, input, model, output, untracked, viewChild } from '@angular/core';
import type { FormValueControl } from '@angular/forms/signals';
import { Annotation, EditorState, StateEffect } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { GraphQLSchema } from 'graphql';
import { cn } from '../class-names';
import { AppState } from '../state/app-state';
import { VariableHover } from '../variables/variable-hover';
import { injectVariables } from '../variables/variables';
import { editorExtensions, type CodeLanguage, type SQLNamespace, type SqlDialect } from './code-editor-extensions';

/** Marks the editor's own updates when the value is set from outside, so they do not echo back as edits. */
const External = Annotation.define<boolean>();

/**
 * CodeMirror with the app's theme. Bind it with `[formField]` or `[(value)]`. Inside a `[qVariables]`
 * scope an editable editor marks `{{variables}}`; responses and other read-only views do not.
 */
@Component({
  selector: 'q-code-editor',
  template: `<div #container [class]="containerClass()" [style.height]="filled() ? '100%' : null"></div>`,
  host: { '[class]': 'hostClass()' },
})
export class CodeEditor implements FormValueControl<string> {
  private readonly theme = inject(AppState).resolvedTheme;
  private readonly hover = inject(VariableHover);
  private readonly variables = injectVariables();
  private readonly container = viewChild.required<ElementRef<HTMLDivElement>>('container');
  private view: EditorView | null = null;

  readonly value = model('');
  readonly language = input<CodeLanguage>('text');
  readonly readonly = input(false, { transform: booleanAttribute });
  readonly placeholder = input('');
  /** Fill the parent instead of growing with content. */
  readonly fill = input(true, { transform: booleanAttribute });
  readonly wrap = input(false, { transform: booleanAttribute });
  /** SQL only: keyword set and completion source. */
  readonly sqlDialect = input<SqlDialect>('standard');
  /** SQL only: table names (and optionally columns) offered by autocompletion. */
  readonly sqlSchema = input<SQLNamespace>();
  /** SQL only: a table in `sqlSchema` whose columns complete without the table name in front. */
  readonly sqlDefaultTable = input<string>();
  /** GraphQL only: schema for autocompletion and lint. Without it, highlighting only. */
  readonly graphqlSchema = input<GraphQLSchema | null>();
  /**
   * A one-line field that looks like the text input: no gutters, newlines typed or pasted become
   * spaces, Enter runs (unless it picks a completion) and Tab moves focus. Size it with classes.
   */
  readonly singleLine = input(false, { transform: booleanAttribute });
  readonly autofocus = input(false, { transform: booleanAttribute });
  /** Mod+Enter inside the editor, and Enter when `singleLine`. */
  readonly run = output<void>();
  readonly touch = output<void>();

  protected readonly filled = computed(() => this.fill() && !this.singleLine());
  protected readonly hostClass = computed(() =>
    cn(
      'overflow-hidden rounded-md border border-edge bg-surface',
      this.singleLine() ? 'flex items-center focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/30' : 'block',
      this.filled() && 'h-full min-h-0',
    ),
  );
  protected readonly containerClass = computed(() => cn(`cm-theme-${this.theme()}`, this.singleLine() && 'flex-1 min-w-0'));

  private readonly extensions = computed(() => [
    EditorView.updateListener.of((update) => {
      if (update.docChanged && !update.transactions.some((tr) => tr.annotation(External))) this.value.set(update.state.doc.toString());
      if (update.focusChanged && !update.view.hasFocus) this.touch.emit();
    }),
    ...editorExtensions({
      language: this.language(),
      readOnly: this.readonly(),
      placeholder: this.placeholder(),
      filled: this.filled(),
      wrap: this.wrap(),
      singleLine: this.singleLine(),
      sqlDialect: this.sqlDialect(),
      sqlSchema: this.sqlSchema(),
      sqlDefaultTable: this.sqlDefaultTable(),
      graphqlSchema: this.graphqlSchema(),
      theme: this.theme(),
      variables: this.variables(),
      hover: this.hover,
      run: () => this.run.emit(),
    }),
  ]);

  constructor() {
    afterNextRender(() => {
      this.view = new EditorView({
        state: EditorState.create({ doc: untracked(this.value), extensions: untracked(this.extensions) }),
        parent: this.container().nativeElement,
      });
      if (untracked(this.autofocus)) this.view.focus();
    });

    effect(() => {
      const extensions = this.extensions();
      untracked(() => this.view?.dispatch({ effects: StateEffect.reconfigure.of(extensions) }));
    });

    effect(() => {
      const value = this.value();
      const view = this.view;
      if (view && value !== view.state.doc.toString()) {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value }, annotations: External.of(true) });
      }
    });

    inject(DestroyRef).onDestroy(() => this.view?.destroy());
  }

  focus(options?: FocusOptions): void {
    if (options?.preventScroll) this.view?.contentDOM.focus(options);
    else this.view?.focus();
  }

  /** Text inside the current selection, or an empty string. */
  selectedText(): string {
    const view = this.view;
    if (!view) return '';
    const { from, to } = view.state.selection.main;
    return from === to ? '' : view.state.sliceDoc(from, to);
  }
}
