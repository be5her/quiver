import { DB_KIND_LABELS, type DbConnectionSummary, type DbHistoryEntry, type DbKind, type DbTable, type ErrorPayload, type SavedQuery } from '@quiver/core';
import { IconButton, SectionHeader, Spinner, cn, confirmDialog, invoke, notify, promptDialog, selectScope, useAppStore, useInvoke, useTabsStore } from '@quiver/ui';
import { ChevronDown, ChevronRight, Eye, KeyRound, Pencil, Plus, RefreshCw, Table2, Terminal, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { openConnectionTab, openNewConnectionTab, openQueryTab, openRedisTab, openTableTab } from './index';
import { AccessBadge, DbError, KindIcon, firstLine } from './shared';
import { useExpanded } from './tree-store';

export function DbSidebar() {
  const connections = useInvoke<DbConnectionSummary[]>('db.connection.list', {}, { refreshOn: ['db-connections'] });
  const queries = useInvoke<SavedQuery[]>('db.query.list', {}, { refreshOn: ['db-queries'] });
  const history = useInvoke<DbHistoryEntry[]>('db.history.list', { limit: 30 }, { refreshOn: ['db-history'] });
  const [queriesOpen, setQueriesOpen] = useState(true);
  const [historyOpen, setHistoryOpen] = useState(false);

  return (
    <div className="flex flex-col h-full min-h-0 overflow-y-auto text-sm">
      <SectionHeader title="Connections" actions={<NewConnectionMenu />} />
      {connections.loading && !connections.data && (
        <div className="px-3 py-2">
          <Spinner />
        </div>
      )}
      {(connections.data ?? []).map((conn) => (
        <ConnectionNode key={conn.id} conn={conn} />
      ))}
      {connections.data?.length === 0 && <p className="px-3 py-2 text-xs text-muted">No connections yet. Add a MySQL, SQLite or Redis connection for this project.</p>}

      <div className="mt-3">
        <SectionHeader
          title={
            <button type="button" className="flex items-center gap-1" onClick={() => setQueriesOpen((o) => !o)}>
              {queriesOpen ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />} Saved queries
            </button>
          }
          actions={
            <IconButton label="New query" size="sm" onClick={() => openQueryTab({ connectionId: connections.data?.[0]?.id ?? null })}>
              <Plus className="size-3.5" />
            </IconButton>
          }
        />
        {queriesOpen &&
          (queries.data ?? []).map((q) => (
            <Row
              key={q.id}
              onClick={() => openQueryTab({ queryId: q.id, title: q.name })}
              prefix={<Terminal className="size-3.5 text-muted shrink-0" />}
              label={q.name}
              actions={
                <>
                  <IconButton label="Rename" size="sm" onClick={(e) => stop(e, () => renameQuery(q))}>
                    <Pencil className="size-3.5" />
                  </IconButton>
                  <IconButton label="Delete" size="sm" onClick={(e) => stop(e, () => deleteQuery(q))}>
                    <Trash2 className="size-3.5" />
                  </IconButton>
                </>
              }
            />
          ))}
        {queriesOpen && queries.data?.length === 0 && <p className="px-3 py-1 text-xs text-muted">Save a query from the editor to keep it with the project.</p>}
      </div>

      <div className="mt-3">
        <SectionHeader
          title={
            <button type="button" className="flex items-center gap-1" onClick={() => setHistoryOpen((o) => !o)}>
              {historyOpen ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />} History
            </button>
          }
          actions={
            (history.data?.length ?? 0) > 0 ? (
              <IconButton label="Clear history" size="sm" onClick={() => void clearHistory()}>
                <Trash2 className="size-3.5" />
              </IconButton>
            ) : undefined
          }
        />
        {historyOpen &&
          (history.data ?? []).map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => openQueryTab({ connectionId: entry.connectionId, database: entry.database, text: entry.text })}
              className="w-full text-left px-3 py-1 hover:bg-elevated flex items-center gap-2 min-w-0"
              title={`${entry.at}\n${entry.connectionName}\n${entry.text}`}
            >
              <span className={cn('size-1.5 rounded-full shrink-0', entry.ok ? 'bg-success' : 'bg-danger')} />
              <span className="truncate text-xs font-mono text-fg flex-1">{firstLine(entry.text)}</span>
              <span className="text-[10px] text-muted shrink-0">{entry.durationMs} ms</span>
            </button>
          ))}
      </div>
    </div>
  );
}

function NewConnectionMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);
  const kinds: DbKind[] = ['mysql', 'sqlite', 'redis'];
  return (
    <div ref={ref} className="relative">
      <IconButton label="New connection" size="sm" onClick={() => setOpen((o) => !o)}>
        <Plus className="size-3.5" />
      </IconButton>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-20 min-w-36 rounded-md border border-edge bg-elevated shadow-lg py-1 normal-case tracking-normal font-normal">
          {kinds.map((kind) => (
            <button
              key={kind}
              type="button"
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-fg hover:bg-surface"
              onClick={() => {
                setOpen(false);
                openNewConnectionTab(kind);
              }}
            >
              <KindIcon kind={kind} /> {DB_KIND_LABELS[kind]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ConnectionNode({ conn }: { conn: DbConnectionSummary }) {
  const [open, toggle] = useExpanded(`conn/${conn.id}`);
  return (
    <div>
      <Row
        onClick={toggle}
        prefix={
          <>
            {open ? <ChevronDown className="size-3.5 text-muted shrink-0" /> : <ChevronRight className="size-3.5 text-muted shrink-0" />}
            <KindIcon kind={conn.kind} />
          </>
        }
        label={conn.name}
        bold
        badge={<AccessBadge access={conn.access} />}
        actions={
          <>
            {conn.kind === 'redis' ? (
              <IconButton label="Browse keys" size="sm" onClick={(e) => stop(e, () => openRedisTab(conn))}>
                <KeyRound className="size-3.5" />
              </IconButton>
            ) : null}
            <IconButton label="New query" size="sm" onClick={(e) => stop(e, () => openQueryTab({ connectionId: conn.id, database: conn.database || null }))}>
              <Terminal className="size-3.5" />
            </IconButton>
            <IconButton label="Edit connection" size="sm" onClick={(e) => stop(e, () => openConnectionTab(conn))}>
              <Pencil className="size-3.5" />
            </IconButton>
            <IconButton label="Delete connection" size="sm" onClick={(e) => stop(e, () => deleteConnection(conn))}>
              <Trash2 className="size-3.5" />
            </IconButton>
          </>
        }
      />
      {open && conn.kind === 'mysql' && <DatabaseList conn={conn} />}
      {open && conn.kind === 'sqlite' && <TableList connectionId={conn.id} database={null} depth={1} />}
      {open && conn.kind === 'redis' && (
        <>
          <Row depth={1} onClick={() => openRedisTab(conn)} prefix={<KeyRound className="size-3.5 text-muted shrink-0" />} label="Keys" />
          <Row depth={1} onClick={() => openQueryTab({ connectionId: conn.id })} prefix={<Terminal className="size-3.5 text-muted shrink-0" />} label="Console" />
        </>
      )}
    </div>
  );
}

function DatabaseList({ conn }: { conn: DbConnectionSummary }) {
  const databases = useInvoke<string[]>('db.schema.databases', { connectionId: conn.id }, { refreshOn: [`db-schema:${conn.id}`] });
  if (databases.error) return <ErrorRow depth={1} message={databases.error} retry={databases.refresh} />;
  if (!databases.data) return <LoadingRow depth={1} />;
  return (
    <>
      {databases.data.map((db) => (
        <DatabaseNode key={db} conn={conn} database={db} />
      ))}
    </>
  );
}

function DatabaseNode({ conn, database }: { conn: DbConnectionSummary; database: string }) {
  const [open, toggle] = useExpanded(`db/${conn.id}/${database}`);
  const isDefault = conn.database === database;
  return (
    <div>
      <Row
        depth={1}
        onClick={toggle}
        prefix={open ? <ChevronDown className="size-3.5 text-muted shrink-0" /> : <ChevronRight className="size-3.5 text-muted shrink-0" />}
        label={database}
        bold={isDefault}
        actions={
          <IconButton label="New query on this database" size="sm" onClick={(e) => stop(e, () => openQueryTab({ connectionId: conn.id, database }))}>
            <Terminal className="size-3.5" />
          </IconButton>
        }
      />
      {open && <TableList connectionId={conn.id} database={database} depth={2} />}
    </div>
  );
}

function TableList({ connectionId, database, depth }: { connectionId: string; database: string | null; depth: number }) {
  const tables = useInvoke<DbTable[]>('db.schema.tables', { connectionId, database }, { refreshOn: [`db-schema:${connectionId}`] });
  if (tables.error) return <ErrorRow depth={depth} message={tables.error} retry={tables.refresh} />;
  if (!tables.data) return <LoadingRow depth={depth} />;
  if (!tables.data.length) return <p className="text-xs text-muted py-1" style={{ paddingLeft: 12 + depth * 14 }}>No tables</p>;
  return (
    <>
      {tables.data.map((t) => (
        <Row
          key={t.name}
          depth={depth}
          onClick={() => openTableTab(connectionId, t.name, database)}
          prefix={t.type === 'view' ? <Eye className="size-3.5 text-muted shrink-0" /> : <Table2 className="size-3.5 text-muted shrink-0" />}
          label={t.name}
          hint={t.rows !== null ? t.rows.toLocaleString() : undefined}
          actions={
            <IconButton label="Query this table" size="sm" onClick={(e) => stop(e, () => openQueryTab({ connectionId, database, text: `SELECT * FROM ${t.name} LIMIT 100;`, title: t.name }))}>
              <Terminal className="size-3.5" />
            </IconButton>
          }
        />
      ))}
      <button type="button" onClick={() => void tables.refresh()} className="flex items-center gap-1 text-[11px] text-muted hover:text-fg py-1" style={{ paddingLeft: 12 + depth * 14 }}>
        <RefreshCw className="size-3" /> Refresh
      </button>
    </>
  );
}

function LoadingRow({ depth }: { depth: number }) {
  return (
    <div className="flex items-center h-7" style={{ paddingLeft: 12 + depth * 14 }}>
      <Spinner className="size-3.5" />
    </div>
  );
}

function ErrorRow({ depth, message, retry }: { depth: number; message: ErrorPayload; retry(): Promise<void> }) {
  return (
    <div style={{ paddingLeft: 4 + depth * 14 }}>
      <DbError error={message} onRetry={() => void retry()} compact />
    </div>
  );
}

function Row({
  depth = 0,
  onClick,
  prefix,
  label,
  hint,
  actions,
  bold,
  badge,
}: {
  depth?: number;
  onClick(): void;
  prefix?: React.ReactNode;
  label: string;
  hint?: string;
  actions?: React.ReactNode;
  bold?: boolean;
  badge?: React.ReactNode;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => e.key === 'Enter' && onClick()}
      className="group flex items-center gap-1.5 pr-1 h-7 cursor-pointer hover:bg-elevated min-w-0"
      style={{ paddingLeft: 8 + depth * 14 }}
      title={label}
    >
      {prefix}
      <span className={cn('truncate flex-1 text-[13px]', bold && 'font-medium')}>{label}</span>
      {badge}
      {hint && <span className="text-[10px] text-muted group-hover:hidden shrink-0">{hint}</span>}
      <span className="hidden group-hover:flex items-center">{actions}</span>
    </div>
  );
}

function stop(e: React.MouseEvent, fn: () => unknown) {
  e.stopPropagation();
  void Promise.resolve(fn()).catch((err) => notify((err as Error).message, 'error'));
}

async function deleteConnection(conn: DbConnectionSummary) {
  if (!(await confirmDialog({ title: `Delete connection "${conn.name}"?`, message: 'Saved queries that reference it are kept.', danger: true, confirmLabel: 'Delete' }))) return;
  await invoke('db.connection.delete', { id: conn.id });
  const scope = selectScope(useAppStore.getState());
  useTabsStore.getState().closeWhere(scope, (t) => (t.type === 'db.connection' && t.data?.id === conn.id) || ((t.type === 'db.table' || t.type === 'db.redis') && t.data?.connectionId === conn.id));
}

async function renameQuery(q: SavedQuery) {
  const name = await promptDialog({ title: 'Rename query', defaultValue: q.name, confirmLabel: 'Rename' });
  if (name?.trim() && name !== q.name) {
    await invoke('db.query.save', { query: { ...q, name: name.trim() } });
    const scope = selectScope(useAppStore.getState());
    const tab = useTabsStore.getState().scopes[scope]?.tabs.find((t) => t.type === 'db.query' && t.data?.queryId === q.id);
    if (tab) useTabsStore.getState().updateTab(scope, tab.id, { title: name.trim() });
  }
}

async function deleteQuery(q: SavedQuery) {
  if (!(await confirmDialog({ title: `Delete query "${q.name}"?`, danger: true, confirmLabel: 'Delete' }))) return;
  await invoke('db.query.delete', { id: q.id });
  const scope = selectScope(useAppStore.getState());
  useTabsStore.getState().closeWhere(scope, (t) => t.type === 'db.query' && t.data?.queryId === q.id);
}

async function clearHistory() {
  if (await confirmDialog({ title: 'Clear query history?', danger: true, confirmLabel: 'Clear' })) await invoke('db.history.clear');
}
