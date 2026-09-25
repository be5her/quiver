import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { MySQL, SQLite, StandardSQL, sql, type SQLNamespace } from '@codemirror/lang-sql';
import { Prec } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import CodeMirror, { type Extension, type ReactCodeMirrorRef } from '@uiw/react-codemirror';
import { graphql as graphqlLanguage } from 'cm6-graphql';
import type { GraphQLSchema } from 'graphql';
import { useMemo, useRef, type Ref } from 'react';
import { cn } from '../cn';
import { useAppStore } from '../stores/app';

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
  /** GraphQL only: schema for autocompletion and lint. Without it, highlighting only. */
  graphqlSchema?: GraphQLSchema | null;
  /** Bound to Mod+Enter inside the editor. */
  onRun?(): void;
  /** Access to the underlying CodeMirror view, e.g. to read the selection. */
  editorRef?: Ref<ReactCodeMirrorRef>;
  autoFocus?: boolean;
}

function languageExtension(language: CodeLanguage, dialect: SqlDialect, schema?: SQLNamespace, graphqlSchema?: GraphQLSchema | null): Extension[] {
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
      return [sql({ dialect: dialect === 'mysql' ? MySQL : dialect === 'sqlite' ? SQLite : StandardSQL, schema, upperCaseKeywords: true })];
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
  graphqlSchema,
  onRun,
  editorRef,
  autoFocus,
}: CodeEditorProps) {
  const theme = useAppStore((s) => s.resolvedTheme);
  const onRunRef = useRef(onRun);
  onRunRef.current = onRun;

  const extensions = useMemo(() => {
    const list = [baseTheme, ...languageExtension(language, sqlDialect, sqlSchema, graphqlSchema)];
    if (wrap) list.push(EditorView.lineWrapping);
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
  }, [language, wrap, sqlDialect, sqlSchema, graphqlSchema]);

  return (
    <div className={cn('overflow-hidden rounded-md border border-edge bg-surface', fill && 'h-full min-h-0', className)}>
      <CodeMirror
        ref={editorRef}
        value={value}
        onChange={onChange}
        readOnly={readOnly}
        editable={!readOnly}
        theme={theme}
        extensions={extensions}
        placeholder={placeholder}
        autoFocus={autoFocus}
        height={fill ? '100%' : undefined}
        style={{ height: fill ? '100%' : undefined }}
        basicSetup={{
          lineNumbers: true,
          foldGutter: true,
          highlightActiveLine: !readOnly,
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
