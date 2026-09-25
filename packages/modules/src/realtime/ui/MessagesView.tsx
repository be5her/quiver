import { toErrorPayload, type RealtimeConnection, type RealtimeConnectionSummary, type RealtimeMessage } from '@quiver/core';
import { Badge, Button, CodeEditor, EmptyState, IconButton, Input, Select, cn, formatBytes, invoke, notify, onHostEvent, type CodeLanguage } from '@quiver/ui';
import { ArrowDown, ArrowDownToLine, ArrowUp, Info, RefreshCw, Save, Send, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const PAGE = 500;

export function MessagesView({ connection, draft, onSaveMessage }: { connection: RealtimeConnectionSummary; draft: RealtimeConnection; onSaveMessage(body: string): void }) {
  const [items, setItems] = useState<RealtimeMessage[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [follow, setFollow] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try {
      setItems(await invoke<RealtimeMessage[]>('realtime.message.list', { id: connection.id, limit: PAGE }));
    } catch (err) {
      notify(toErrorPayload(err).message, 'error');
    }
  }, [connection.id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(
    () =>
      onHostEvent('realtime.changed', (p) => {
        if (p.connectionId === connection.id && p.reason === 'messages') void refresh();
      }),
    [connection.id, refresh],
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
      await invoke('realtime.message.clear', { id: connection.id });
      setSelectedId(null);
    } catch (err) {
      notify(toErrorPayload(err).message, 'error');
    }
  };

  const needle = filter.trim().toLowerCase();
  const filtered = useMemo(() => (needle ? (items ?? []).filter((m) => `${m.event ?? ''} ${m.data} ${m.kind}`.toLowerCase().includes(needle)) : (items ?? [])), [items, needle]);
  const selected = items?.find((m) => m.id === selectedId) ?? null;

  return (
    <div className="flex h-full min-h-0">
      <div className="flex-1 min-w-0 flex flex-col min-h-0">
        <div className="flex items-center gap-1 px-2 h-9 border-b border-edge shrink-0">
          <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter messages" className="h-7 text-xs" />
          {!follow && (
            <IconButton label="Jump to latest" size="sm" onClick={() => setFollow(true)}>
              <ArrowDownToLine className="size-3.5" />
            </IconButton>
          )}
          <IconButton label="Refresh" size="sm" onClick={() => void refresh()}>
            <RefreshCw className="size-3.5" />
          </IconButton>
          <IconButton label="Clear messages" size="sm" onClick={() => void clear()} disabled={!items?.length}>
            <Trash2 className="size-3.5" />
          </IconButton>
        </div>
        <div ref={listRef} onScroll={onScroll} className="flex-1 overflow-y-auto" data-testid="realtime-message-list">
          {filtered.map((m) => (
            <MessageRow key={m.id} message={m} selected={m.id === selectedId} onClick={() => setSelectedId(m.id === selectedId ? null : m.id)} />
          ))}
          {items && items.length === 0 && (
            <p className="px-3 py-3 text-xs text-muted">
              {connection.status === 'open' ? 'Connected. Messages appear here as they arrive.' : 'Nothing yet. Connect to start receiving.'}
            </p>
          )}
          {items && items.length > 0 && filtered.length === 0 && <p className="px-3 py-3 text-xs text-muted">No message matches the filter.</p>}
        </div>
        {connection.kind === 'websocket' && <Composer connection={connection} draft={draft} onSaveMessage={onSaveMessage} />}
      </div>
      {selected && (
        <div className="w-96 border-l border-edge flex flex-col min-h-0 shrink-0">
          <MessageDetail key={selected.id} message={selected} />
        </div>
      )}
    </div>
  );
}

const KIND_LABEL: Record<RealtimeMessage['kind'], string> = { text: 'text', binary: 'binary', event: 'event', open: 'open', close: 'close', error: 'error', info: 'info' };

function MessageRow({ message, selected, onClick }: { message: RealtimeMessage; selected: boolean; onClick(): void }) {
  const system = message.direction === 'system';
  const preview = message.encoding === 'base64' ? `binary, ${formatBytes(message.size)}` : message.data.replace(/\s+/g, ' ').slice(0, 300);
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn('w-full text-left px-2 py-1 border-b border-edge/60 hover:bg-elevated flex items-center gap-2 min-w-0', selected && 'bg-elevated')}
      data-testid="realtime-message"
      data-direction={message.direction}
      data-kind={message.kind}
    >
      <span className="w-4 shrink-0 flex justify-center">
        {message.direction === 'in' && <ArrowDown className="size-3.5 text-sky-600 dark:text-sky-400" aria-label="received" />}
        {message.direction === 'out' && <ArrowUp className="size-3.5 text-amber-600 dark:text-amber-400" aria-label="sent" />}
        {system && <Info className={cn('size-3.5', message.kind === 'error' ? 'text-danger' : 'text-muted')} aria-label={message.kind} />}
      </span>
      {message.event && message.event !== 'message' && <Badge className="shrink-0 text-violet-600 dark:text-violet-400">{message.event}</Badge>}
      {message.eventId !== null && <span className="text-[10px] text-muted shrink-0 font-mono">#{message.eventId}</span>}
      <span className={cn('truncate flex-1 text-xs font-mono', system && 'italic text-muted', message.kind === 'error' && 'text-danger')}>{preview || <span className="text-muted">(empty)</span>}</span>
      {!system && message.size > 0 && <span className="text-[10px] text-muted shrink-0">{formatBytes(message.size)}</span>}
      <span className="text-[10px] text-muted shrink-0">{new Date(message.at).toLocaleTimeString()}</span>
    </button>
  );
}

function MessageDetail({ message }: { message: RealtimeMessage }) {
  const { text, language } = useMemo(() => formatData(message), [message]);
  const copy = () => navigator.clipboard.writeText(message.data).then(() => notify('Copied', 'success'));
  return (
    <div className="flex flex-col h-full min-h-0" data-testid="realtime-message-detail">
      <div className="flex flex-col gap-1 px-3 py-2 border-b border-edge text-[11px] text-muted shrink-0">
        <div className="flex items-center gap-2 flex-wrap">
          <Badge>{message.direction === 'in' ? 'received' : message.direction === 'out' ? 'sent' : KIND_LABEL[message.kind]}</Badge>
          {message.event && <Badge className="text-violet-600 dark:text-violet-400">{message.event}</Badge>}
          {message.eventId !== null && <span className="font-mono">id {message.eventId}</span>}
          <span>{new Date(message.at).toLocaleString()}</span>
          <span>{formatBytes(message.size)}</span>
          {message.truncated && <span className="text-warning">truncated to {formatBytes(message.data.length)}</span>}
          <span className="flex-1" />
          <Button size="sm" variant="ghost" onClick={() => void copy()}>
            Copy
          </Button>
        </div>
      </div>
      <div className="flex-1 min-h-0 p-2">
        <CodeEditor value={text} readOnly language={language} wrap={language !== 'json'} />
      </div>
    </div>
  );
}

function formatData(message: RealtimeMessage): { text: string; language: CodeLanguage } {
  if (message.encoding === 'base64') return { text: `Binary frame (${formatBytes(message.size)}), base64:\n${message.data.slice(0, 4000)}${message.data.length > 4000 ? '…' : ''}`, language: 'text' };
  if (/^\s*[[{]/.test(message.data)) {
    try {
      return { text: JSON.stringify(JSON.parse(message.data), null, 2), language: 'json' };
    } catch {
      return { text: message.data, language: 'text' };
    }
  }
  return { text: message.data, language: 'text' };
}

// ---------- composer ----------

type Format = 'text' | 'json';

function Composer({ connection, draft, onSaveMessage }: { connection: RealtimeConnectionSummary; draft: RealtimeConnection; onSaveMessage(body: string): void }) {
  const [text, setText] = useState('');
  const [format, setFormat] = useState<Format>('text');
  const [sending, setSending] = useState(false);
  const open = connection.status === 'open';

  const send = async () => {
    if (!open || sending) return;
    if (format === 'json') {
      try {
        JSON.parse(text);
      } catch (err) {
        notify(`Not valid JSON: ${(err as Error).message}`, 'error');
        return;
      }
    }
    setSending(true);
    try {
      await invoke('realtime.send', { id: connection.id, data: text });
    } catch (err) {
      notify(toErrorPayload(err).message, 'error');
    } finally {
      setSending(false);
    }
  };

  const loadSaved = (id: string) => {
    const saved = draft.messages.find((m) => m.id === id);
    if (saved) {
      setText(saved.body);
      setFormat(/^\s*[[{]/.test(saved.body) ? 'json' : 'text');
    }
  };

  return (
    <div className="border-t border-edge shrink-0 flex flex-col gap-1 p-2" data-testid="realtime-composer">
      <div className="h-24">
        <CodeEditor value={text} onChange={setText} language={format === 'json' ? 'json' : 'text'} onRun={() => void send()} placeholder={open ? 'Message to send (Ctrl+Enter)' : 'Connect to send messages'} />
      </div>
      <div className="flex items-center gap-2">
        <Select value={format} onChange={(e) => setFormat(e.target.value as Format)} className="h-7 text-xs w-20">
          <option value="text">Text</option>
          <option value="json">JSON</option>
        </Select>
        {draft.messages.length > 0 && (
          <Select value="" onChange={(e) => loadSaved(e.target.value)} className="h-7 text-xs w-44" title="Load a saved message">
            <option value="">Saved messages…</option>
            {draft.messages.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name || m.body.slice(0, 40) || '(empty)'}
              </option>
            ))}
          </Select>
        )}
        <Button size="sm" variant="ghost" icon={<Save className="size-3.5" />} onClick={() => onSaveMessage(text)} disabled={!text.trim()} title="Keep this message with the connection">
          Save message
        </Button>
        <div className="flex-1" />
        <span className="text-[11px] text-muted">{'{{variables}}'} resolve on send</span>
        <Button size="sm" variant="primary" icon={<Send className="size-3.5" />} loading={sending} disabled={!open} onClick={() => void send()} title="Ctrl+Enter" data-testid="realtime-send">
          Send
        </Button>
      </div>
    </div>
  );
}

export function EmptyMessages() {
  return <EmptyState title="No messages" />;
}
