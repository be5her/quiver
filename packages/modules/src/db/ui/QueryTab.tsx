import { toErrorPayload, type DbConnectionSummary, type DbQueryResult, type DbTable, type ErrorPayload, type SavedQuery } from '@quiver/core';
import {
  Badge,
  Button,
  CodeEditor,
  IconButton,
  Segmented,
  Select,
  cn,
  invoke,
  notify,
  promptDialog,
  selectedText,
  useInvoke,
  useTabsStore,
  type ReactCodeMirrorRef,
  type SQLNamespace,
  type TabProps,
} from '@quiver/ui';
import { Copy, Play, Save } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ResultGrid } from './ResultGrid';
import { DbError, KindIcon, firstLine, formatCount, formatDuration, rowsToCsv, rowsToJson } from './shared';

const MAX_ROWS_OPTIONS = [100, 500, 1000, 5000];

export function QueryTab({ tab, scope }: TabProps) {
  const data = tab.data ?? {};
  const queryId = typeof data.queryId === 'string' ? data.queryId : undefined;
  const [text, setText] = useState(typeof data.text === 'string' ? data.text : '');
  const [connectionId, setConnectionId] = useState<string | null>(typeof data.connectionId === 'string' ? data.connectionId : null);
  const [database, setDatabase] = useState<string | null>(typeof data.database === 'string' ? data.database : null);
  const [saved, setSaved] = useState<SavedQuery | null>(null);
  const [maxRows, setMaxRows] = useState(500);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<DbQueryResult[] | null>(null);
  const [error, setError] = useState<ErrorPayload | null>(null);
  const [activeResult, setActiveResult] = useState(0);
  const editorRef = useRef<ReactCodeMirrorRef>(null);
  const updateTab = useTabsStore((s) => s.updateTab);

  const connections = useInvoke<DbConnectionSummary[]>('db.connection.list', {}, { refreshOn: ['db-connections'] });
  const connection = connections.data?.find((c) => c.id === connectionId) ?? null;
  const kind = connection?.kind ?? null;
  const databases = useInvoke<string[]>('db.schema.databases', { connectionId }, { enabled: kind === 'mysql' });
  const tables = useInvoke<DbTable[]>('db.schema.tables', { connectionId, database }, { enabled: kind === 'mysql' ? Boolean(database || connection?.database) : kind === 'sqlite' });
  const sqlSchema = useMemo<SQLNamespace | undefined>(() => (tables.data ? Object.fromEntries(tables.data.map((t) => [t.name, []])) : undefined), [tables.data]);

  // Saved query: load once, then the tab's own text wins so unsaved edits survive restarts.
  useEffect(() => {
    if (!queryId) return;
    let cancelled = false;
    invoke<SavedQuery>('db.query.get', { id: queryId })
      .then((q) => {
        if (cancelled) return;
        setSaved(q);
        if (typeof data.text !== 'string' || data.text === '') setText(q.text);
        if (!data.connectionId) setConnectionId(q.connectionId);
        if (!data.database) setDatabase(q.database);
      })
      .catch((err) => !cancelled && setError(toErrorPayload(err)));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryId]);

  // Fall back to the first connection so a fresh tab is immediately runnable.
  useEffect(() => {
    if (!connectionId && connections.data?.length) setConnectionId(connections.data[0].id);
  }, [connectionId, connections.data]);

  // Persist editor state into the tab (debounced) so it is restored with the workspace.
  useEffect(() => {
    const handle = setTimeout(() => {
      const next = { ...tab.data, id: data.id, queryId, connectionId, database, text };
      if (JSON.stringify(next) !== JSON.stringify(tab.data)) updateTab(scope, tab.id, { data: next });
    }, 300);
    return () => clearTimeout(handle);
  }, [text, connectionId, database, queryId, scope, tab.id, tab.data, data.id, updateTab]);

  const dirty = saved ? text !== saved.text || (connectionId ?? null) !== saved.connectionId || (database ?? null) !== saved.database : false;
  useEffect(() => {
    if (tab.dirty !== dirty) updateTab(scope, tab.id, { dirty });
  }, [dirty, scope, tab.id, tab.dirty, updateTab]);

  useEffect(() => {
    if (!saved) {
      const title = firstLine(text, 32) || 'Query';
      if (tab.title !== title) updateTab(scope, tab.id, { title });
    }
  }, [text, saved, scope, tab.id, tab.title, updateTab]);

  const run = useCallback(async () => {
    if (!connectionId || running) return;
    const selection = selectedText(editorRef.current);
    const query = (selection || text).trim();
    if (!query) return;
    setRunning(true);
    setError(null);
    try {
      const out = await invoke<DbQueryResult[]>('db.query.run', { connectionId, query, database: database || undefined, maxRows });
      setResults(out);
      setActiveResult(Math.max(0, out.length - 1));
    } catch (err) {
      setError(toErrorPayload(err));
    } finally {
      setRunning(false);
    }
  }, [connectionId, running, text, database, maxRows]);

  const save = useCallback(async () => {
    let name = saved?.name;
    if (!name) {
      name = (await promptDialog({ title: 'Save query', label: 'Name', defaultValue: firstLine(text, 40), confirmLabel: 'Save' }))?.trim();
      if (!name) return;
    }
    try {
      const stored = await invoke<SavedQuery>('db.query.save', { query: { id: saved?.id, name, connectionId, database, text } });
      setSaved(stored);
      updateTab(scope, tab.id, { title: stored.name, data: { ...tab.data, id: stored.id, queryId: stored.id, connectionId, database, text } });
      notify('Query saved', 'success');
    } catch (err) {
      notify(toErrorPayload(err).message, 'error');
    }
  }, [saved, text, connectionId, database, scope, tab.id, tab.data, updateTab]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void save();
    }
  };

  const current = results?.[activeResult] ?? null;
  const summary = useMemo(() => summarize(results), [results]);

  return (
    <div className="flex flex-col h-full min-h-0" onKeyDown={onKeyDown}>
      <div className="flex items-center gap-2 px-3 py-2 border-b border-edge shrink-0">
        {kind && <KindIcon kind={kind} className="size-4" />}
        <Select value={connectionId ?? ''} onChange={(e) => setConnectionId(e.target.value || null)} className="h-7 text-xs max-w-56">
          {!connections.data?.length && <option value="">No connections</option>}
          {connections.data?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        {kind === 'mysql' && (
          <Select value={database ?? ''} onChange={(e) => setDatabase(e.target.value || null)} className="h-7 text-xs max-w-48" title="Database">
            <option value="">{connection?.database ? `${connection.database} (default)` : 'Pick a database'}</option>
            {databases.data?.map((db) => (
              <option key={db} value={db}>
                {db}
              </option>
            ))}
          </Select>
        )}
        <Button variant="primary" size="sm" icon={<Play className="size-3.5" />} loading={running} disabled={!connectionId} onClick={() => void run()} title="Ctrl+Enter runs the selection or everything">
          Run
        </Button>
        <Select value={String(maxRows)} onChange={(e) => setMaxRows(Number(e.target.value))} className="h-7 text-xs" title="Row limit per result">
          {MAX_ROWS_OPTIONS.map((n) => (
            <option key={n} value={n}>
              {n} rows
            </option>
          ))}
        </Select>
        <div className="flex-1" />
        {saved && <span className="text-xs text-muted truncate max-w-48">{saved.name}</span>}
        <Button size="sm" variant={dirty || !saved ? 'secondary' : 'ghost'} icon={<Save className="size-3.5" />} onClick={() => void save()} title="Ctrl+S">
          {saved ? `Save${dirty ? '*' : ''}` : 'Save as…'}
        </Button>
      </div>

      <div className="flex flex-col flex-1 min-h-0">
        <div className="basis-[42%] min-h-[120px] p-2 border-b border-edge">
          <CodeEditor
            value={text}
            onChange={setText}
            language={kind === 'redis' ? 'text' : 'sql'}
            sqlDialect={kind === 'sqlite' ? 'sqlite' : 'mysql'}
            sqlSchema={sqlSchema}
            onRun={() => void run()}
            editorRef={editorRef}
            placeholder={kind === 'redis' ? 'One command per line, e.g.\nSCAN 0 MATCH user:* COUNT 100\nHGETALL user:1' : 'SELECT * FROM table_name LIMIT 100;\n\nCtrl+Enter runs the selection, or everything when nothing is selected.'}
            autoFocus
          />
        </div>

        <div className="flex-1 min-h-0 flex flex-col">
          <div className="flex items-center gap-2 px-3 h-8 border-b border-edge shrink-0 text-xs text-muted">
            {results && results.length > 1 && (
              <Segmented<string>
                value={String(activeResult)}
                onChange={(v) => setActiveResult(Number(v))}
                className="border-b-0 -ml-3"
                options={results.map((r, i) => ({ value: String(i), label: `${i + 1}: ${resultLabel(r)}` }))}
              />
            )}
            {summary && !error && <span>{summary}</span>}
            {error && <span className="text-danger truncate">{error.message}</span>}
            <div className="flex-1" />
            {current?.kind === 'rows' && current.rows.length > 0 && (
              <>
                {current.truncated && <Badge className="text-warning">first {formatCount(current.rowCount)} rows</Badge>}
                <IconButton label="Copy as JSON" size="sm" onClick={() => copy(rowsToJson(current.columns, current.rows), 'JSON')}>
                  <span className="text-[10px] font-mono">{'{}'}</span>
                </IconButton>
                <IconButton label="Copy as CSV" size="sm" onClick={() => copy(rowsToCsv(current.columns, current.rows), 'CSV')}>
                  <Copy className="size-3.5" />
                </IconButton>
              </>
            )}
          </div>
          <div className="flex-1 min-h-0">
            {error ? (
              <DbError error={error} onRetry={() => void run()} />
            ) : !results ? (
              <div className="h-full flex items-center justify-center text-xs text-muted">{running ? 'Running…' : 'Results appear here.'}</div>
            ) : current ? (
              <ResultView result={current} />
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function ResultView({ result }: { result: DbQueryResult }) {
  if (result.kind === 'rows') return <ResultGrid columns={result.columns} rows={result.rows} emptyMessage="Empty result set" />;
  if (result.kind === 'affected') {
    return (
      <div className="p-3 text-sm">
        <p className="text-fg">
          OK, {formatCount(result.affectedRows ?? 0)} row{result.affectedRows === 1 ? '' : 's'} affected
          {result.insertId ? <span className="text-muted"> · insert id {result.insertId}</span> : null}
        </p>
        {result.message && <p className="text-xs text-muted mt-1 font-mono">{result.message}</p>}
      </div>
    );
  }
  return <ValueView value={result.value} />;
}

/** Redis replies: arrays become a one-column grid, everything else is shown as text or JSON. */
function ValueView({ value }: { value: unknown }) {
  if (Array.isArray(value)) {
    const rows = value.map((v, i) => [i, v]);
    return <ResultGrid columns={[{ name: 'index', type: null }, { name: 'value', type: null }]} rows={rows} emptyMessage="(empty array)" />;
  }
  const text = value === null ? '(nil)' : typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return <pre className={cn('p-3 text-xs font-mono whitespace-pre-wrap break-all overflow-auto h-full', value === null && 'text-muted italic')}>{text}</pre>;
}

function resultLabel(r: DbQueryResult): string {
  if (r.kind === 'rows') return `${formatCount(r.rowCount)} rows`;
  if (r.kind === 'affected') return `${formatCount(r.affectedRows ?? 0)} affected`;
  return 'reply';
}

function summarize(results: DbQueryResult[] | null): string | null {
  if (!results?.length) return null;
  const total = results.reduce((n, r) => n + r.durationMs, 0);
  if (results.length === 1) {
    const r = results[0];
    if (r.kind === 'rows') return `${formatCount(r.rowCount)} row${r.rowCount === 1 ? '' : 's'}${r.truncated ? ' (truncated)' : ''} · ${formatDuration(r.durationMs)}`;
    if (r.kind === 'affected') return `${formatCount(r.affectedRows ?? 0)} affected · ${formatDuration(r.durationMs)}`;
    return `reply · ${formatDuration(r.durationMs)}`;
  }
  return `${results.length} statements · ${formatDuration(total)}`;
}

function copy(text: string, what: string) {
  void navigator.clipboard.writeText(text).then(() => notify(`Copied ${what}`, 'success'));
}
