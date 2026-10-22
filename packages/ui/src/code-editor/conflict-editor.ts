import { Component, DestroyRef, ElementRef, afterNextRender, computed, effect, inject, input, model, untracked, viewChild } from '@angular/core';
import { Annotation, EditorState, StateEffect, StateField, type Range } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import { conflictRegions, resolveConflict, type ConflictChoice, type ConflictRegion } from '@quiver/core';
import { AppState } from '../state/app-state';
import { VariableHover } from '../variables/variable-hover';
import { editorExtensions, type CodeLanguage } from './code-editor-extensions';

/** What the two sides of a conflict are called on screen: current (ours) and incoming (theirs). */
export interface ConflictSideLabels {
  ours: string;
  theirs: string;
}

/** Marks the editor's own updates when the value is set from outside, so they do not echo back as edits. */
const External = Annotation.define<boolean>();
const setLabels = StateEffect.define<ConflictSideLabels>();

const labelsField = StateField.define<ConflictSideLabels>({
  create: () => ({ ours: '', theirs: '' }),
  update: (value, tr) => tr.effects.find((e) => e.is(setLabels))?.value ?? value,
});

/** The actions a conflict offers, in the order its bar shows them. */
const ACTIONS: { choice: Exclude<ConflictChoice, object>; label: string; base?: true }[] = [
  { choice: 'ours', label: 'Accept current' },
  { choice: 'theirs', label: 'Accept incoming' },
  { choice: 'ours-theirs', label: 'Accept both' },
  { choice: 'theirs-ours', label: 'Both, incoming first' },
  { choice: 'base', label: 'Accept base', base: true },
];

/** Replace one conflict, found again by its index in the text as it is now, with the choice's text; undoable. */
function accept(view: EditorView, index: number, choice: ConflictChoice): void {
  const region = conflictRegions(view.state.doc.toString())[index];
  if (!region) return;
  view.dispatch({ changes: { from: region.from, to: region.to, insert: resolveConflict(region, choice) }, userEvent: 'input.conflict' });
}

/** The bar above a conflict: its number, what each side is, and the accept buttons. */
class ConflictActions extends WidgetType {
  constructor(
    readonly region: ConflictRegion,
    readonly labels: ConflictSideLabels,
  ) {
    super();
  }

  override eq(other: ConflictActions): boolean {
    return other.region.index === this.region.index && (other.region.base === null) === (this.region.base === null) && other.labels.ours === this.labels.ours && other.labels.theirs === this.labels.theirs;
  }

  toDOM(view: EditorView): HTMLElement {
    const bar = document.createElement('div');
    bar.className = 'cm-conflict-actions';
    bar.setAttribute('data-testid', 'conflict-actions');
    bar.setAttribute('data-index', String(this.region.index));
    for (const action of ACTIONS) {
      if (action.base && this.region.base === null) continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = action.label;
      button.setAttribute('data-testid', 'conflict-accept');
      button.setAttribute('data-choice', action.choice);
      // Keep the editor's selection where it is; the click replaces the conflict.
      button.addEventListener('mousedown', (e) => e.preventDefault());
      button.addEventListener('click', () => accept(view, this.region.index, action.choice));
      bar.append(button);
    }
    return bar;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

/** A note at the end of a marker line saying which side it opens or closes. */
class SideNote extends WidgetType {
  constructor(readonly text: string) {
    super();
  }

  override eq(other: SideNote): boolean {
    return other.text === this.text;
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-conflict-note';
    span.textContent = this.text;
    return span;
  }
}

function decorate(state: EditorState): DecorationSet {
  const doc = state.doc;
  const labels = state.field(labelsField);
  const decorations: Range<Decoration>[] = [];
  const lines = (from: number, to: number, cls: string) => {
    for (let pos = from; pos < to; ) {
      const line = doc.lineAt(pos);
      decorations.push(Decoration.line({ class: cls }).range(line.from));
      pos = line.to + 1;
    }
  };
  const marker = (at: number, cls: string, note?: string) => {
    const line = doc.lineAt(at);
    decorations.push(Decoration.line({ class: `cm-conflict-marker ${cls}` }).range(line.from));
    if (note) decorations.push(Decoration.widget({ widget: new SideNote(note), side: 1 }).range(line.to));
  };
  for (const r of conflictRegions(doc.toString())) {
    decorations.push(Decoration.widget({ widget: new ConflictActions(r, labels), side: -1, block: true }).range(r.from));
    marker(r.from, 'cm-conflict-marker-ours', `current${labels.ours ? ` · ${labels.ours}` : ''}`);
    lines(r.oursFrom, r.oursTo, 'cm-conflict-ours');
    if (r.baseFrom !== null && r.baseTo !== null) {
      marker(r.oursTo, 'cm-conflict-marker-base', 'common ancestor');
      lines(r.baseFrom, r.baseTo, 'cm-conflict-base');
    }
    marker(r.baseTo ?? r.oursTo, 'cm-conflict-marker-sep');
    lines(r.theirsFrom, r.theirsTo, 'cm-conflict-theirs');
    marker(r.theirsTo, 'cm-conflict-marker-theirs', `incoming${labels.theirs ? ` · ${labels.theirs}` : ''}`);
  }
  return Decoration.set(decorations, true);
}

const conflictField = StateField.define<DecorationSet>({
  create: decorate,
  update: (value, tr) => (tr.docChanged || tr.effects.some((e) => e.is(setLabels)) ? decorate(tr.state) : value),
  provide: (field) => EditorView.decorations.from(field),
});

const conflictTheme = EditorView.baseTheme({
  '.cm-conflict-ours': { backgroundColor: 'color-mix(in srgb, var(--accent) 14%, transparent)' },
  '.cm-conflict-theirs': { backgroundColor: 'color-mix(in srgb, var(--warning) 14%, transparent)' },
  '.cm-conflict-base': { backgroundColor: 'color-mix(in srgb, var(--muted) 12%, transparent)' },
  '.cm-conflict-marker': { color: 'var(--muted)', fontWeight: '600' },
  '.cm-conflict-marker-ours': { backgroundColor: 'color-mix(in srgb, var(--accent) 28%, transparent)' },
  '.cm-conflict-marker-theirs': { backgroundColor: 'color-mix(in srgb, var(--warning) 28%, transparent)' },
  '.cm-conflict-marker-base, .cm-conflict-marker-sep': { backgroundColor: 'color-mix(in srgb, var(--muted) 18%, transparent)' },
  '.cm-conflict-note': { marginLeft: '12px', fontFamily: 'var(--font-sans, inherit)', fontSize: '11px', fontWeight: '400', fontStyle: 'italic', color: 'var(--muted)' },
  '.cm-conflict-actions': { display: 'flex', flexWrap: 'wrap', gap: '2px 10px', padding: '6px 6px 2px', fontFamily: 'var(--font-sans, inherit)', fontSize: '11px' },
  '.cm-conflict-actions button': { color: 'var(--accent)', background: 'none', border: 'none', padding: '0', cursor: 'pointer' },
  '.cm-conflict-actions button:hover': { textDecoration: 'underline' },
});

/**
 * An editable CodeMirror over a file with git's conflict markers: each conflict's current (ours) lines in one colour
 * and incoming (theirs) in another, the base of a diff3 conflict muted, the marker lines naming their side, and a bar
 * above each conflict to accept current, incoming, both (either order) or the base. Accepting is an ordinary edit,
 * undone with Mod-Z. Bind the text with `[(value)]`; `count` is the number of conflicts left in it.
 */
@Component({
  selector: 'q-conflict-editor',
  template: `<div #container [class]="containerClass()" style="height: 100%"></div>`,
  host: { class: 'block h-full min-h-0 overflow-hidden rounded-md border border-edge bg-surface' },
})
export class ConflictEditor {
  private readonly theme = inject(AppState).resolvedTheme;
  private readonly hover = inject(VariableHover);
  private readonly container = viewChild.required<ElementRef<HTMLDivElement>>('container');
  private view: EditorView | null = null;

  readonly value = model('');
  readonly language = input<CodeLanguage>('text');
  readonly labels = input<ConflictSideLabels>({ ours: '', theirs: '' });
  /** The conflicts left in the text. */
  readonly count = computed(() => conflictRegions(this.value()).length);

  protected readonly containerClass = computed(() => `cm-theme-${this.theme()}`);

  private readonly extensions = computed(() => [
    EditorView.updateListener.of((update) => {
      if (update.docChanged && !update.transactions.some((tr) => tr.annotation(External))) this.value.set(update.state.doc.toString());
    }),
    ...editorExtensions({
      language: this.language(),
      readOnly: false,
      placeholder: '',
      filled: true,
      wrap: false,
      singleLine: false,
      sqlDialect: 'standard',
      theme: this.theme(),
      variables: null,
      hover: this.hover,
      run: () => undefined,
    }),
    labelsField,
    conflictField,
    conflictTheme,
  ]);

  constructor() {
    afterNextRender(() => {
      this.view = new EditorView({
        state: EditorState.create({ doc: untracked(this.value), extensions: untracked(this.extensions) }),
        parent: this.container().nativeElement,
      });
      this.view.dispatch({ effects: setLabels.of(untracked(this.labels)) });
    });
    effect(() => {
      const extensions = this.extensions();
      untracked(() => this.view?.dispatch({ effects: StateEffect.reconfigure.of(extensions) }));
    });
    effect(() => {
      const labels = this.labels();
      untracked(() => this.view?.dispatch({ effects: setLabels.of(labels) }));
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

  /** Scroll to a conflict and put the cursor at its start. */
  goTo(index: number): void {
    const view = this.view;
    const region = view ? conflictRegions(view.state.doc.toString())[index] : undefined;
    if (!view || !region) return;
    view.dispatch({ selection: { anchor: region.from }, effects: EditorView.scrollIntoView(region.from, { y: 'start', yMargin: 48 }) });
    view.focus();
  }

  /** Accept a side (or both) for one conflict, as its bar does. */
  accept(index: number, choice: ConflictChoice): void {
    if (this.view) accept(this.view, index, choice);
  }
}
