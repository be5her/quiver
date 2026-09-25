import { MCP_LOGGING_LEVELS, toErrorPayload, type McpLogEntry, type McpServerSummary } from '@quiver/core';
import { Badge, Button, CodeEditor, IconButton, Input, Select, cn, formatBytes, invoke, notify, onHostEvent } from '@quiver/ui';
import { ArrowDown, ArrowDownToLine, ArrowUp, Info, RefreshCw, Send, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TextBlock } from './content';
import { formatMs } from './ToolsView';

const PAGE = 500;

export function LogView({ server }: { server: McpServerSummary }) {
  const [items, setItems] = useState<McpLogEntry[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [direction, setDirection] = useState<'' | McpLogEntry['direction']>('');
  const [follow, setFollow] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);
  const canLog = Boolean(server.capabilities?.logging) && server.status === 'connected';

  const refresh = useCallback(async () => {
    try {
      setItems(await invoke<McpLogEntry[]>('mcp.log.list', { id: server.id, limit: PAGE }));
    } catch (err) {
      notify(toErrorPayload(err).message, 'error');
    }
  }, [server.id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(
    () =>
      onHostEvent('mcp.changed', (p) => {
        if (p.serverId === server.id && p.reason === 'log') void refresh();
      }),
    [server.id, refresh],
  );

  useEffect(() => {
    if (follow && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [items, follow]);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (atBottom !== follow) setFollow(atBottom);
  };

  const clear = async () => {
    try {
      await invoke('mcp.log.clear', { id: server.id });
      setSelectedId(null);
    } catch (err) {
      notify(toErrorPayload(err).message, 'error');
    }
  };

  const setLevel = async (level: string) => {
    if (!level) return;
    try {
      await invoke('mcp.logging.level', { id: server.id, level });
      notify(`Logging level set to ${level}`, 'success');
    } catch (err) {
      notify(toErrorPayload(err).message, 'error');
    }
  };

  const needle = filter.trim().toLowerCase();
  const filtered = useMemo(
    () => (items ?? []).filter((m) => (!direction || m.direction === direction) && (!needle || `${m.method ?? ''} ${m.kind} ${m.data}`.toLowerCase().includes(needle))),
    [items, needle, direction],
  );
  const selected = items?.find((m) => m.id === selectedId) ?? null;

  return (
    <div className="flex h-full min-h-0">
      <div className="flex-1 min-w-0 flex flex-col min-h-0">
        <div className="flex items-center gap-1 px-2 h-9 border-b border-edge shrink-0">
          <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by method or text" className="h-7 text-xs" />
          <Select value={direction} onChange={(e) => setDirection(e.target.value as typeof direction)} className="h-7 text-xs w-24" title="Direction">
            <option value="">All</option>
            <option value="out">Sent</option>
            <option value="in">Received</option>
            <option value="system">Events</option>
          </Select>
          {canLog && (
            <Select value="" onChange={(e) => void setLevel(e.target.value)} className="h-7 text-xs w-32" title="Ask the server for log messages at this level and above">
              <option value="">Log level…</option>
              {MCP_LOGGING_LEVELS.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </Select>
          )}
          {!follow && (
            <IconButton label="Jump to latest" size="sm" onClick={() => setFollow(true)}>
              <ArrowDownToLine className="size-3.5" />
            </IconButton>
          )}
          <IconButton label="Refresh" size="sm" onClick={() => void refresh()}>
            <RefreshCw className="size-3.5" />
          </IconButton>
          <IconButton label="Clear log" size="sm" onClick={() => void clear()} disabled={!items?.length}>
            <Trash2 className="size-3.5" />
          </IconButton>
        </div>
        <div ref={listRef} onScroll={onScroll} className="flex-1 overflow-y-auto" data-testid="mcp-log-list">
          {filtered.map((m) => (
            <LogRow key={m.id} entry={m} selected={m.id === selectedId} onClick={() => setSelectedId(m.id === selectedId ? null : m.id)} />
          ))}
          {items && items.length === 0 && <p className="px-3 py-3 text-xs text-muted">{server.status === 'connected' ? 'Every request, response and notification lands here.' : 'Nothing yet. Connect to see the traffic.'}</p>}
          {items && items.length > 0 && filtered.length === 0 && <p className="px-3 py-3 text-xs text-muted">No entry matches the filter.</p>}
        </div>
        <RawRequest server={server} />
      </div>
      {selected && (
        <div className="w-[26rem] border-l border-edge flex flex-col min-h-0 shrink-0">
          <LogDetail key={selected.id} entry={selected} />
        </div>
      )}
    </div>
  );
}

const KIND_COLOR: Partial<Record<McpLogEntry['kind'], string>> = {
  error: 'text-danger',
  stderr: 'text-amber-600 dark:text-amber-400',
  log: 'text-violet-600 dark:text-violet-400',
  notification: 'text-violet-600 dark:text-violet-400',
};

function preview(entry: McpLogEntry): string {
  if (entry.direction === 'system' || entry.kind === 'stderr') return entry.data;
  try {
    const m = JSON.parse(entry.data) as { params?: unknown; result?: unknown; error?: { message?: string } };
    if (m.error) return m.error.message ?? JSON.stringify(m.error);
    const body = m.params ?? m.result;
    return body === undefined ? '' : JSON.stringify(body);
  } catch {
    return entry.data;
  }
}

function LogRow({ entry, selected, onClick }: { entry: McpLogEntry; selected: boolean; onClick(): void }) {
  const system = entry.direction === 'system';
  const text = preview(entry).replace(/\s+/g, ' ').slice(0, 300);
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn('w-full text-left px-2 py-1 border-b border-edge/60 hover:bg-elevated flex items-center gap-2 min-w-0', selected && 'bg-elevated')}
      data-testid="mcp-log-entry"
      data-direction={entry.direction}
      data-kind={entry.kind}
    >
      <span className="w-4 shrink-0 flex justify-center">
        {entry.direction === 'in' && <ArrowDown className="size-3.5 text-sky-600 dark:text-sky-400" aria-label="received" />}
        {entry.direction === 'out' && <ArrowUp className="size-3.5 text-amber-600 dark:text-amber-400" aria-label="sent" />}
        {system && <Info className={cn('size-3.5', entry.kind === 'error' ? 'text-danger' : 'text-muted')} aria-label={entry.kind} />}
      </span>
      <Badge className={cn('shrink-0', KIND_COLOR[entry.kind], entry.ok === false && 'text-danger')}>{entry.kind}</Badge>
      {entry.method && <span className="font-mono text-xs shrink-0 max-w-48 truncate">{entry.method}</span>}
      {entry.requestId !== null && <span className="text-[10px] text-muted shrink-0 font-mono">#{entry.requestId}</span>}
      <span className={cn('truncate flex-1 text-xs font-mono', system && 'italic text-muted', entry.kind === 'error' && 'text-danger')}>{text || <span className="text-muted">(empty)</span>}</span>
      {entry.durationMs !== null && <span className="text-[10px] text-muted shrink-0">{formatMs(entry.durationMs)}</span>}
      {!system && entry.size > 0 && <span className="text-[10px] text-muted shrink-0">{formatBytes(entry.size)}</span>}
      <span className="text-[10px] text-muted shrink-0">{new Date(entry.at).toLocaleTimeString()}</span>
    </button>
  );
}

function LogDetail({ entry }: { entry: McpLogEntry }) {
  const json = entry.direction !== 'system' && entry.kind !== 'stderr';
  const copy = () => navigator.clipboard.writeText(entry.data).then(() => notify('Copied', 'success'));
  return (
    <div className="flex flex-col h-full min-h-0" data-testid="mcp-log-detail">
      <div className="flex flex-col gap-1 px-3 py-2 border-b border-edge text-[11px] text-muted shrink-0">
        <div className="flex items-center gap-2 flex-wrap">
          <Badge>{entry.direction === 'in' ? 'received' : entry.direction === 'out' ? 'sent' : 'event'}</Badge>
          <Badge className={KIND_COLOR[entry.kind]}>{entry.kind}</Badge>
          {entry.method && <span className="font-mono">{entry.method}</span>}
          {entry.requestId !== null && <span className="font-mono">#{entry.requestId}</span>}
          {entry.durationMs !== null && <span>{formatMs(entry.durationMs)}</span>}
          <span>{new Date(entry.at).toLocaleString()}</span>
          <span>{formatBytes(entry.size)}</span>
          {entry.truncated && <span className="text-warning">truncated</span>}
          <span className="flex-1" />
          <Button size="sm" variant="ghost" onClick={() => void copy()}>
            Copy
          </Button>
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-2">{json ? <TextBlock text={entry.data} mime="application/json" /> : <CodeEditor value={entry.data} readOnly language="text" wrap />}</div>
    </div>
  );
}

function RawRequest({ server }: { server: McpServerSummary }) {
  const [method, setMethod] = useState('ping');
  const [params, setParams] = useState('');
  const [sending, setSending] = useState(false);
  const connected = server.status === 'connected';

  const send = async () => {
    if (!connected || sending || !method.trim()) return;
    let parsed: Record<string, unknown> | undefined;
    try {
      parsed = params.trim() ? (JSON.parse(params) as Record<string, unknown>) : undefined;
    } catch (err) {
      notify(`Params: ${(err as Error).message}`, 'error');
      return;
    }
    setSending(true);
    try {
      const out = await invoke<{ result: unknown; durationMs: number }>('mcp.request', { id: server.id, method: method.trim(), params: parsed });
      notify(`${method.trim()} answered in ${formatMs(out.durationMs)}`, 'success');
    } catch (err) {
      notify(toErrorPayload(err).message, 'error');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="border-t border-edge shrink-0 flex items-end gap-2 p-2" data-testid="mcp-raw-request">
      <div className="w-52 shrink-0">
        <Input value={method} onChange={(e) => setMethod(e.target.value)} placeholder="method, e.g. ping" className="font-mono h-7 text-xs" data-testid="mcp-raw-method" />
      </div>
      <div className="flex-1 min-w-0 h-7 border border-edge rounded-md">
        <CodeEditor value={params} onChange={setParams} language="json" fill onRun={() => void send()} placeholder='params, e.g. {"level":"debug"}' />
      </div>
      <Button size="sm" variant="secondary" icon={<Send className="size-3.5" />} loading={sending} disabled={!connected} onClick={() => void send()} title="Send a raw JSON-RPC request (Ctrl+Enter)" data-testid="mcp-raw-send">
        Send
      </Button>
    </div>
  );
}
