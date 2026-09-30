import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { MySQL, SQLite, StandardSQL, sql, type SQLNamespace } from '@codemirror/lang-sql';
import { EditorState, Prec, RangeSetBuilder, type ChangeSpec } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, keymap, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { findVariableSpans } from '@quiver/core';
import CodeMirror, { type Extension, type ReactCodeMirrorRef } from '@uiw/react-codemirror';
import { graphql as graphqlLanguage } from 'cm6-graphql';
import type { GraphQLSchema } from 'graphql';
import { useMemo, useRef, type Ref } from 'react';
import { cn } from '../cn';
import { useAppStore } from '../stores/app';
import { lookupVariable, showVariableCard, useVariableHoverStore, useVariables, type VariableContext } from './Variables';

export type CodeLanguage = 'json' | 'javascript' | 'html' | 'xml' | 'sql' | 'graphql' | 'text';
export type SqlDialect = 'mysql' | 'sqlite' | 'standard';
export type { SQLNamespace, ReactCodeMirrorRef };

export interface CodeEditorProps {
  value: string;
  onChange?(value: string): void;
  language?: CodeLanguage;
  readOnly?: boolean;
  placeholder?: string;
  className?: string;
  /** Fill the parent instead of growing with content. */
  fill?: boolean;
  wrap?: boolean;
  /** SQL only: keyword set and completion source. */
  sqlDialect?: SqlDialect;
  /** SQL only: table names (and optionally columns) offered by autocompletion. */
  sqlSchema?: SQLNamespace;
  /** SQL only: a table in `sqlSchema` whose columns complete without the table name in front. */
  sqlDefaultTable?: string;
  /** GraphQL only: schema for autocompletion and lint. Without it, highlighting only. */
  graphqlSchema?: GraphQLSchema | null;
  /** Bound to Mod+Enter inside the editor, and to Enter when `singleLine`. */
  onRun?(): void;
  /**
   * A one-line field that looks like an Input: no gutters, newlines typed or pasted become
   * spaces, Enter runs `onRun` (unless it picks a completion) and Tab moves focus. Size it with `className`.
   */
  singleLine?: boolean;
  /** Access to the underlying CodeMirror view, e.g. to read the selection. */
  editorRef?: Ref<ReactCodeMirrorRef>;
  autoFocus?: boolean;
}

function languageExtension(language: CodeLanguage, dialect: SqlDialect, schema?: SQLNamespace, defaultTable?: string, graphqlSchema?: GraphQLSchema | null): Extension[] {
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
      return [sql({ dialect: dialect === 'mysql' ? MySQL : dialect === 'sqlite' ? SQLite : StandardSQL, schema, defaultTable, upperCaseKeywords: true })];
    default:
      return [];
  }
}

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

// Matches Input: text-xs, px-2.5 and the muted placeholder; the scrollbar is hidden since the line scrolls with the cursor.
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
function variableHighlighting(scope: VariableContext): Extension {
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
  const hover = EditorView.domEventHandlers({
    mousemove(event) {
      const el = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-var-name]');
      if (el) showVariableCard(scope, el.dataset.varName!, el.getBoundingClientRect());
      else useVariableHoverStore.getState().scheduleHide();
    },
    mouseleave() {
      useVariableHoverStore.getState().scheduleHide();
    },
  });
  return [variableTheme, plugin, hover];
}

export function CodeEditor({
  value,
  onChange,
  language = 'text',
  readOnly,
  placeholder,
  className,
  fill = true,
  wrap,
  sqlDialect = 'standard',
  sqlSchema,
  sqlDefaultTable,
  graphqlSchema,
  onRun,
  singleLine,
  editorRef,
  autoFocus,
}: CodeEditorProps) {
  const theme = useAppStore((s) => s.resolvedTheme);
  // Inside a VariablesProvider, editable editors mark {{variables}}; responses and other read-only views do not.
  const variables = useVariables();
  const onRunRef = useRef(onRun);
  onRunRef.current = onRun;

  const extensions = useMemo(() => {
    const list = [baseTheme, ...languageExtension(language, sqlDialect, sqlSchema, sqlDefaultTable, graphqlSchema)];
    if (wrap) list.push(EditorView.lineWrapping);
    if (singleLine) {
      list.push(
        Prec.high(singleLineTheme),
        oneLine,
        // Below the completion keymap (Prec.highest), so Enter still picks a completion while the list is open.
        Prec.high(
          keymap.of([
            {
              key: 'Enter',
              run: () => {
                onRunRef.current?.();
                return true;
              },
            },
          ]),
        ),
      );
    }
    if (variables && !readOnly) list.push(variableHighlighting(variables));
    list.push(
      Prec.highest(
        keymap.of([
          {
            key: 'Mod-Enter',
            run: () => {
              if (!onRunRef.current) return false;
              onRunRef.current();
              return true;
            },
          },
        ]),
      ),
    );
    return list;
  }, [language, wrap, singleLine, sqlDialect, sqlSchema, sqlDefaultTable, graphqlSchema, variables, readOnly]);
  const filled = fill && !singleLine;

  return (
    <div
      className={cn(
        'overflow-hidden rounded-md border border-edge bg-surface',
        filled && 'h-full min-h-0',
        singleLine && 'flex items-center focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/30',
        className,
      )}
    >
      <CodeMirror
        ref={editorRef}
        className={singleLine ? 'flex-1 min-w-0' : undefined}
        value={value}
        onChange={onChange}
        readOnly={readOnly}
        editable={!readOnly}
        theme={theme}
        extensions={extensions}
        placeholder={placeholder}
        autoFocus={autoFocus}
        height={filled ? '100%' : undefined}
        style={{ height: filled ? '100%' : undefined }}
        indentWithTab={!singleLine}
        basicSetup={{
          lineNumbers: !singleLine,
          foldGutter: !singleLine,
          foldKeymap: !singleLine,
          searchKeymap: !singleLine,
          highlightActiveLine: !readOnly && !singleLine,
          highlightActiveLineGutter: false,
          autocompletion: (language === 'sql' || language === 'graphql') && !readOnly,
        }}
      />
    </div>
  );
}

/** Text inside the current selection, or an empty string. */
export function selectedText(ref: ReactCodeMirrorRef | null | undefined): string {
  const view = ref?.view;
  if (!view) return '';
  const { from, to } = view.state.selection.main;
  return from === to ? '' : view.state.sliceDoc(from, to);
}
