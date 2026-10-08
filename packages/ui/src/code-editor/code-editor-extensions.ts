import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { MySQL, SQLite, StandardSQL, sql, type SQLNamespace } from '@codemirror/lang-sql';
import { bracketMatching, defaultHighlightStyle, foldGutter, foldKeymap, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { lintKeymap } from '@codemirror/lint';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { EditorState, Prec, RangeSetBuilder, type ChangeSpec, type Extension } from '@codemirror/state';
import { oneDark } from '@codemirror/theme-one-dark';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  placeholder,
  rectangularSelection,
  type DecorationSet,
  type KeyBinding,
  type ViewUpdate,
} from '@codemirror/view';
import { findVariableSpans } from '@quiver/core';
import { graphql as graphqlLanguage } from 'cm6-graphql';
import type { GraphQLSchema } from 'graphql';
import type { VariableHover } from '../variables/variable-hover';
import { lookupVariable, type VariableContext } from '../variables/variables';

export type CodeLanguage = 'json' | 'javascript' | 'html' | 'xml' | 'sql' | 'graphql' | 'text';
export type SqlDialect = 'mysql' | 'sqlite' | 'standard';
export type { SQLNamespace };

export interface EditorOptions {
  language: CodeLanguage;
  readOnly: boolean;
  placeholder: string;
  filled: boolean;
  wrap: boolean;
  singleLine: boolean;
  sqlDialect: SqlDialect;
  sqlSchema?: SQLNamespace;
  sqlDefaultTable?: string;
  graphqlSchema?: GraphQLSchema | null;
  theme: 'light' | 'dark';
  variables: VariableContext | null;
  hover: VariableHover;
  run(): void;
}

function languageExtension({ language, sqlDialect, sqlSchema, sqlDefaultTable, graphqlSchema }: EditorOptions): Extension[] {
  switch (language) {
    case 'graphql':
      return [graphqlLanguage(graphqlSchema ?? undefined)];
    case 'json':
      return [json()];
    case 'javascript':
      return [javascript()];
    case 'html':
    case 'xml':
      return [html()];
    case 'sql':
      return [sql({ dialect: sqlDialect === 'mysql' ? MySQL : sqlDialect === 'sqlite' ? SQLite : StandardSQL, schema: sqlSchema, defaultTable: sqlDefaultTable, upperCaseKeywords: true })];
    default:
      return [];
  }
}

/** CodeMirror's basic setup, with the parts a one-line field or a read-only view does not want switched off. */
function basicSetup({ language, readOnly, singleLine }: EditorOptions): Extension[] {
  const keys: KeyBinding[] = [...closeBracketsKeymap, ...defaultKeymap, ...(singleLine ? [] : searchKeymap), ...historyKeymap, ...(singleLine ? [] : foldKeymap), ...completionKeymap, ...lintKeymap];
  const extensions: Extension[] = [];
  if (!singleLine) extensions.push(lineNumbers());
  extensions.push(highlightSpecialChars(), history());
  if (!singleLine) extensions.push(foldGutter());
  extensions.push(drawSelection(), dropCursor(), EditorState.allowMultipleSelections.of(true), indentOnInput(), syntaxHighlighting(defaultHighlightStyle, { fallback: true }), bracketMatching(), closeBrackets());
  if ((language === 'sql' || language === 'graphql') && !readOnly) extensions.push(autocompletion());
  extensions.push(rectangularSelection());
  if (!readOnly && !singleLine) extensions.push(highlightActiveLine());
  extensions.push(highlightSelectionMatches(), keymap.of(keys));
  return extensions;
}

const lightTheme = EditorView.theme({ '&': { backgroundColor: '#fff' } }, { dark: false });

const scrollerTheme = EditorView.theme({ '& .cm-scroller': { height: '100% !important' } });

const fillTheme = EditorView.theme({ '&': { height: '100%' } });

const baseTheme = EditorView.theme({
  '&': { fontSize: '12.5px', backgroundColor: 'transparent' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.55' },
  '.cm-gutters': { backgroundColor: 'transparent', borderRight: '1px solid var(--edge)', color: 'var(--muted)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--accent) 6%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent' },
  '.cm-tooltip': { backgroundColor: 'var(--elevated)', border: '1px solid var(--edge)', color: 'var(--fg)' },
  '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'var(--accent)', color: 'var(--accent-fg)' },
});

// Matches the text input: text-xs, px-2.5 and the muted placeholder; the scrollbar is hidden since the line scrolls with the cursor.
const singleLineTheme = EditorView.theme({
  '&': { fontSize: '12px' },
  '.cm-content': { padding: '0' },
  '.cm-line': { padding: '0 10px' },
  '.cm-scroller': { scrollbarWidth: 'none' },
  '.cm-placeholder': { color: 'color-mix(in srgb, var(--muted) 70%, transparent)' },
});

/** Keeps the document on one line: every newline, with the whitespace around it, becomes one space. */
const oneLine = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || tr.newDoc.lines === 1) return tr;
  const changes: ChangeSpec[] = [];
  for (const m of tr.newDoc.toString().matchAll(/\s*\n\s*/g)) changes.push({ from: m.index, to: m.index + m[0].length, insert: ' ' });
  return [tr, { changes, sequential: true }];
});

const variableTheme = EditorView.baseTheme({
  '.cm-variable': { backgroundColor: 'color-mix(in srgb, var(--accent) 20%, transparent)', borderRadius: '2px' },
  '.cm-variable-missing': { backgroundColor: 'color-mix(in srgb, var(--danger) 20%, transparent)', borderRadius: '2px', boxShadow: 'inset 0 -1.5px 0 var(--danger)' },
});

/** Marks `{{variables}}` in the visible lines and shows their value card on hover. */
function variableHighlighting(scope: VariableContext, hover: VariableHover): Extension {
  const build = (view: EditorView): DecorationSet => {
    const builder = new RangeSetBuilder<Decoration>();
    for (const { from, to } of view.visibleRanges) {
      const text = view.state.doc.sliceString(from, to);
      for (const span of findVariableSpans(text)) {
        const known = Boolean(lookupVariable(scope, span.name));
        builder.add(from + span.from, from + span.to, Decoration.mark({ class: known ? 'cm-variable' : 'cm-variable-missing', attributes: { 'data-var-name': span.name } }));
      }
    }
    return builder.finish();
  };
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view);
      }
      update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged) this.decorations = build(update.view);
      }
    },
    { decorations: (v) => v.decorations },
  );
  const pointer = EditorView.domEventHandlers({
    mousemove(event) {
      const el = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-var-name]');
      if (el) hover.showFor(scope, el.dataset['varName']!, el.getBoundingClientRect());
      else hover.scheduleHide();
    },
    mouseleave() {
      hover.scheduleHide();
    },
  });
  return [variableTheme, plugin, pointer];
}

/** Everything the editor is configured with, in the order the extensions take precedence. */
export function editorExtensions(options: EditorOptions): Extension[] {
  const { readOnly, singleLine, filled, wrap, theme, variables } = options;
  const defaults: Extension[] = [];
  if (options.placeholder) defaults.push(placeholder(options.placeholder));
  defaults.push(basicSetup(options));
  if (!singleLine) defaults.push(keymap.of([indentWithTab]));
  defaults.push(theme === 'dark' ? oneDark : lightTheme);
  if (readOnly) defaults.push(EditorView.editable.of(false), EditorState.readOnly.of(true));

  const own: Extension[] = [baseTheme, ...languageExtension(options)];
  if (wrap) own.push(EditorView.lineWrapping);
  if (singleLine) {
    own.push(
      Prec.high(singleLineTheme),
      oneLine,
      // Below the completion keymap (Prec.highest), so Enter still picks a completion while the list is open.
      Prec.high(keymap.of([{ key: 'Enter', run: () => (options.run(), true) }])),
    );
  }
  if (variables && !readOnly) own.push(variableHighlighting(variables, options.hover));
  own.push(Prec.highest(keymap.of([{ key: 'Mod-Enter', run: () => (options.run(), true) }])));

  return [...(filled ? [fillTheme] : []), scrollerTheme, ...defaults, ...own];
}
