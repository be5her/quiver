import { toErrorPayload, type DbTableDetail, type DbTableRows, type ErrorPayload } from '@quiver/core';
import { Badge, Button, CodeEditor, IconButton, Input, Segmented, Spinner, cn, invoke, useInvoke, type TabProps } from '@quiver/ui';
import { ChevronLeft, ChevronRight, RefreshCw, Terminal } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { ResultGrid } from './ResultGrid';
import { openQueryTab } from './index';
import { DbError, formatCount, formatDuration } from './shared';

type View = 'data' | 'structure';
const PAGE = 100;

export function TableTab({ tab }: TabProps) {
  const connectionId = String(tab.data?.connectionId ?? '');
  const table = String(tab.data?.table ?? '');
  const database = typeof tab.data?.database === 'string' ? tab.data.database : null;
  const [view, setView] = useState<View>('data');

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-edge shrink-0">
        <span className="text-sm font-medium truncate">
          {database && <span className="text-muted">{database}.</span>}
          {table}
        </span>
        <div className="flex-1" />
        <Button size="sm" variant="ghost" icon={<Terminal className="size-3.5" />} onClick={() => openQueryTab({ connectionId, database, text: `SELECT * FROM ${table} LIMIT 100;`, title: table })}>
          Query
        </Button>
      </div>
      <Segmented<View>
        value={view}
        onChange={setView}
        className="px-3 shrink-0"
        options={[
          { value: 'data', label: 'Data' },
          { value: 'structure', label: 'Structure' },
        ]}
      />
      <div className="flex-1 min-h-0">
        {view === 'data' ? <DataView connectionId={connectionId} table={table} database={database} /> : <StructureView connectionId={connectionId} table={table} database={database} />}
      </div>
    </div>
  );
}

function DataView({ connectionId, table, database }: { connectionId: string; table: string; database: string | null }) {
  const [offset, setOffset] = useState(0);
  const [sort, setSort] = useState<{ column: string; direction: 'asc' | 'desc' } | null>(null);
  const [where, setWhere] = useState('');
  const [applied, setApplied] = useState('');
  const [data, setData] = useState<DbTableRows | null>(null);
  const [error, setError] = useState<ErrorPayload | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const out = await invoke<DbTableRows>('db.table.rows', {
        connectionId,
        table,
        database,
        limit: PAGE,
        offset,
        orderBy: sort?.column ?? null,
        direction: sort?.direction,
        where: applied || null,
      });
      setData(out);
      setError(null);
    } catch (err) {
      setError(toErrorPayload(err));
    } finally {
      setLoading(false);
    }
  }, [connectionId, table, database, offset, sort, applied]);

  useEffect(() => {
    void load();
  }, [load]);

  const total = data?.total ?? null;
  const from = data ? data.offset + 1 : 0;
  const to = data ? data.offset + data.rows.length : 0;
  const hasNext = data ? (total !== null ? data.offset + PAGE < total : data.rows.length === PAGE) : false;

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-2 px-3 h-9 border-b border-edge shrink-0 text-xs">
        <span className="text-muted shrink-0">WHERE</span>
        <Input
          value={where}
          onChange={(e) => setWhere(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              setOffset(0);
              setApplied(where.trim());
            }
          }}
          placeholder="id > 100 AND status = 'active'  (Enter to apply)"
          className="h-7 font-mono text-xs max-w-xl"
        />
        <div className="flex-1" />
        {loading && <Spinner className="size-3.5" />}
        {data && !loading && (
          <span className="text-muted">
            {data.rows.length ? `${formatCount(from)}–${formatCount(to)}` : '0'}
            {total !== null && <> of {data.approximate ? '~' : ''}{formatCount(total)}</>} · {formatDuration(data.durationMs)}
          </span>
        )}
        <IconButton label="Previous page" size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
          <ChevronLeft className="size-3.5" />
        </IconButton>
        <IconButton label="Next page" size="sm" disabled={!hasNext} onClick={() => setOffset(offset + PAGE)}>
          <ChevronRight className="size-3.5" />
        </IconButton>
        <IconButton label="Refresh" size="sm" onClick={() => void load()}>
          <RefreshCw className="size-3.5" />
        </IconButton>
      </div>
      <div className="flex-1 min-h-0">
        {error ? (
          <DbError error={error} onRetry={() => void load()} />
        ) : data ? (
          <ResultGrid
            columns={data.columns}
            rows={data.rows}
            sort={sort}
            onSort={(column) => {
              setOffset(0);
              setSort((s) => (s?.column === column ? (s.direction === 'asc' ? { column, direction: 'desc' } : null) : { column, direction: 'asc' }));
            }}
            emptyMessage={applied ? 'No rows match the filter' : 'Table is empty'}
          />
        ) : (
          <div className="flex items-center justify-center h-full">
            <Spinner />
          </div>
        )}
      </div>
    </div>
  );
}

function StructureView({ connectionId, table, database }: { connectionId: string; table: string; database: string | null }) {
  const detail = useInvoke<DbTableDetail>('db.schema.table', { connectionId, table, database }, { refreshOn: [`db-schema:${connectionId}`] });
  if (detail.error) return <DbError error={detail.error} onRetry={() => void detail.refresh()} />;
  if (!detail.data)
    return (
      <div className="flex items-center justify-center h-full">
        <Spinner />
      </div>
    );
  const d = detail.data;
  return (
    <div className="h-full overflow-auto p-3 flex flex-col gap-4 text-sm">
      <section>
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted mb-1">Columns</h3>
        <table className="w-full text-xs border border-edge rounded-md overflow-hidden">
          <thead className="bg-elevated text-muted">
            <tr>
              <th className="text-left px-2 py-1 font-medium">Name</th>
              <th className="text-left px-2 py-1 font-medium">Type</th>
              <th className="text-left px-2 py-1 font-medium">Null</th>
              <th className="text-left px-2 py-1 font-medium">Key</th>
              <th className="text-left px-2 py-1 font-medium">Default</th>
              <th className="text-left px-2 py-1 font-medium">Extra</th>
            </tr>
          </thead>
          <tbody>
            {d.columns.map((c) => (
              <tr key={c.name} className="border-t border-edge">
                <td className="px-2 py-1 font-mono">{c.name}</td>
                <td className="px-2 py-1 font-mono text-muted">{c.type}</td>
                <td className="px-2 py-1">{c.nullable ? 'yes' : 'no'}</td>
                <td className="px-2 py-1">{c.key && <Badge className={cn(c.key === 'PRI' && 'text-accent')}>{c.key}</Badge>}</td>
                <td className="px-2 py-1 font-mono text-muted">{c.default ?? ''}</td>
                <td className="px-2 py-1 text-muted">{c.extra ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      {d.indexes.length > 0 && (
        <section>
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted mb-1">Indexes</h3>
          <ul className="text-xs flex flex-col gap-1">
            {d.indexes.map((i) => (
              <li key={i.name} className="flex items-center gap-2">
                <span className="font-mono">{i.name}</span>
                {i.unique && <Badge>unique</Badge>}
                <span className="text-muted font-mono">({i.columns.join(', ')})</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {d.ddl && (
        <section className="flex-1 min-h-40 flex flex-col">
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted mb-1">Definition</h3>
          <div className="min-h-40 flex-1">
            <CodeEditor value={d.ddl} language="sql" readOnly wrap />
          </div>
        </section>
      )}
    </div>
  );
}
