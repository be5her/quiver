import {
  RealtimeConnectionSchema,
  newSavedMessage,
  toErrorPayload,
  type KeyValue,
  type RealtimeConnection,
  type RealtimeConnectionSummary,
  type RealtimeSavedMessage,
} from '@quiver/core';
import { Button, Checkbox, CodeEditor, IconButton, Input, KeyValueEditor, Label, Segmented, Select, Spinner, cn, invoke, notify, onHostEvent, useTabsStore, type TabProps } from '@quiver/ui';
import { Plug, Plus, Save, Send, Trash2, Unplug } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AuthEditor } from '../../api/ui/RequestTab';
import { MessagesView } from './MessagesView';
import { statusDot } from './Sidebar';
import { deleteConnection, type ConnectionView } from './index';

const STATUS_LABEL: Record<RealtimeConnectionSummary['status'], string> = {
  disconnected: 'disconnected',
  connecting: 'connecting…',
  open: 'connected',
  reconnecting: 'reconnecting…',
};

function definitionOf(summary: RealtimeConnectionSummary): RealtimeConnection {
  return RealtimeConnectionSchema.parse(summary);
}

export function ConnectionTab({ tab, scope }: TabProps) {
  const connectionId = String(tab.data?.id ?? '');
  const [summary, setSummary] = useState<RealtimeConnectionSummary | null>(null);
  const [draft, setDraft] = useState<RealtimeConnection | null>(null);
  const [saved, setSaved] = useState<RealtimeConnection | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [view, setView] = useState<ConnectionView>((tab.data?.view as ConnectionView | undefined) ?? 'messages');
  const [busy, setBusy] = useState(false);
  const updateTab = useTabsStore((s) => s.updateTab);
  const dirtyRef = useRef(false);

  const load = useCallback(async () => {
    try {
      const next = await invoke<RealtimeConnectionSummary>('realtime.connection.get', { id: connectionId });
      setSummary(next);
      const def = definitionOf(next);
      setSaved(def);
      setDraft((current) => (current && dirtyRef.current ? current : def));
      setLoadError(null);
    } catch (err) {
      setLoadError(toErrorPayload(err).message);
    }
  }, [connectionId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(
    () =>
      onHostEvent('store.changed', (p) => {
        if (p.collection === 'realtime-connections') void load();
      }),
    [load],
  );

  useEffect(
    () =>
      onHostEvent('realtime.changed', (p) => {
        if (p.connectionId === connectionId && p.reason !== 'messages') void load();
      }),
    [load, connectionId],
  );

  const nonce = tab.data?.nonce;
  useEffect(() => {
    const wanted = tab.data?.view as ConnectionView | undefined;
    if (wanted) setView(wanted);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce]);

  const dirty = useMemo(() => Boolean(draft && saved && JSON.stringify(draft) !== JSON.stringify(saved)), [draft, saved]);
  dirtyRef.current = dirty;

  useEffect(() => {
    if (tab.dirty !== dirty) updateTab(scope, tab.id, { dirty });
  }, [dirty, scope, tab.id, tab.dirty, updateTab]);

  const patch = useCallback((p: Partial<RealtimeConnection>) => setDraft((d) => (d ? { ...d, ...p } : d)), []);

  const save = useCallback(async (): Promise<boolean> => {
    if (!draft) return false;
    try {
      const stored = await invoke<RealtimeConnectionSummary>('realtime.connection.save', { connection: draft });
      const def = definitionOf(stored);
      setSummary(stored);
      setSaved(def);
      setDraft(def);
      updateTab(scope, tab.id, { title: stored.name });
      return true;
    } catch (err) {
      notify(toErrorPayload(err).message, 'error');
      return false;
    }
  }, [draft, scope, tab.id, updateTab]);

  const toggle = useCallback(async () => {
    if (!summary || busy) return;
    setBusy(true);
    try {
      if (summary.status === 'disconnected') {
        if (dirtyRef.current && !(await save())) return;
        const opened = await invoke<RealtimeConnectionSummary>('realtime.connect', { id: connectionId });
        setSummary(opened);
        if (opened.error && opened.status === 'disconnected') notify(opened.error, 'error');
      } else {
        setSummary(await invoke<RealtimeConnectionSummary>('realtime.disconnect', { id: connectionId }));
      }
    } catch (err) {
      notify(toErrorPayload(err).message, 'error');
    } finally {
      setBusy(false);
    }
  }, [summary, busy, save, connectionId]);

  const saveMessage = useCallback(
    (body: string) => {
      setDraft((d) => (d ? { ...d, messages: [...d.messages, newSavedMessage({ name: `Message ${d.messages.length + 1}`, body })] } : d));
      setView('saved');
      notify('Added to saved messages. Save the connection to keep it.', 'info');
    },
    [],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void save().then((ok) => ok && notify('Saved', 'success'));
    }
  };

  if (loadError) return <div className="p-4 text-sm text-danger">{loadError}</div>;
  if (!draft || !summary)
    return (
      <div className="flex items-center justify-center h-full">
        <Spinner />
      </div>
    );

  const open = summary.status !== 'disconnected';
  const isWs = draft.kind === 'websocket';

  return (
    <div className="flex flex-col h-full min-h-0" onKeyDown={onKeyDown} data-testid="realtime-connection-tab">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-edge shrink-0">
        <div className="w-56 shrink-0">
          <Input value={draft.name} onChange={(e) => patch({ name: e.target.value })} className="font-medium" aria-label="Connection name" />
        </div>
        <span className={cn('text-[10px] font-bold shrink-0', isWs ? 'text-sky-600 dark:text-sky-400' : 'text-violet-600 dark:text-violet-400')}>{isWs ? 'WS' : 'SSE'}</span>
        <span className={cn('size-2 rounded-full shrink-0', statusDot(summary.status, summary.error))} />
        <span className="text-xs text-muted shrink-0" data-testid="realtime-status">
          {STATUS_LABEL[summary.status]}
          {summary.protocol ? ` · ${summary.protocol}` : ''}
          {summary.lastEventId !== null ? ` · last id ${summary.lastEventId}` : ''}
        </span>
        {summary.error && (
          <span className="text-xs text-danger truncate min-w-0" title={summary.error} data-testid="realtime-error">
            {summary.error}
          </span>
        )}
        <div className="flex-1 min-w-4" />
        <Button size="sm" variant={dirty ? 'secondary' : 'ghost'} icon={<Save className="size-3.5" />} onClick={() => void save().then((ok) => ok && notify('Saved', 'success'))} title="Ctrl+S">
          Save{dirty ? '*' : ''}
        </Button>
      </div>
      <div className="flex items-center gap-2 px-3 py-2 shrink-0">
        <Input
          value={draft.url}
          onChange={(e) => patch({ url: e.target.value })}
          placeholder={isWs ? 'wss://{{host}}/socket' : 'https://{{host}}/events'}
          className="font-mono"
          autoFocus={!draft.url}
          data-testid="realtime-url"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !open) void toggle();
          }}
        />
        <Button variant={open ? 'secondary' : 'primary'} icon={open ? <Unplug className="size-3.5" /> : <Plug className="size-3.5" />} loading={busy} onClick={() => void toggle()} data-testid="realtime-toggle">
          {open ? 'Disconnect' : 'Connect'}
        </Button>
      </div>
      <Segmented<ConnectionView>
        value={view}
        onChange={setView}
        className="shrink-0 px-1"
        options={[
          { value: 'messages', label: `Messages (${summary.messageCount})` },
          { value: 'headers', label: `Headers (${draft.headers.filter((h) => h.enabled && h.key).length})` },
          { value: 'auth', label: draft.auth.type === 'none' ? 'Auth' : `Auth (${draft.auth.type})` },
          ...(isWs ? [{ value: 'saved' as const, label: `Saved (${draft.messages.length})` }] : []),
          { value: 'settings', label: 'Settings' },
        ]}
      />
      <div className="flex-1 min-h-0">
        {view === 'messages' && <MessagesView connection={summary} draft={draft} onSaveMessage={saveMessage} />}
        {view === 'headers' && (
          <div className="p-2 overflow-y-auto h-full">
            <KeyValueEditor<KeyValue> rows={draft.headers} onChange={(headers) => patch({ headers })} keyPlaceholder="Header" />
            <p className="text-[11px] text-muted px-1 mt-2">{isWs ? 'Sent with the handshake request.' : 'Sent with the stream request; Accept and Cache-Control are set for you.'}</p>
          </div>
        )}
        {view === 'auth' && (
          <div className="p-3 overflow-y-auto h-full">
            <AuthEditor auth={draft.auth} onChange={(auth) => patch({ auth })} />
          </div>
        )}
        {view === 'saved' && isWs && <SavedMessages draft={draft} summary={summary} onChange={(messages) => patch({ messages })} />}
        {view === 'settings' && <SettingsView draft={draft} patch={patch} onDelete={() => void deleteConnection(summary)} />}
      </div>
    </div>
  );
}

function SavedMessages({ draft, summary, onChange }: { draft: RealtimeConnection; summary: RealtimeConnectionSummary; onChange(messages: RealtimeSavedMessage[]): void }) {
  const [selectedId, setSelectedId] = useState<string | null>(draft.messages[0]?.id ?? null);
  const selected = draft.messages.find((m) => m.id === selectedId) ?? null;
  const add = () => {
    const m = newSavedMessage({ name: `Message ${draft.messages.length + 1}` });
    onChange([...draft.messages, m]);
    setSelectedId(m.id);
  };
  const update = (p: Partial<RealtimeSavedMessage>) => onChange(draft.messages.map((m) => (m.id === selectedId ? { ...m, ...p } : m)));
  const remove = () => {
    onChange(draft.messages.filter((m) => m.id !== selectedId));
    setSelectedId(null);
  };
  const send = async () => {
    if (!selected) return;
    try {
      await invoke('realtime.send', { id: draft.id, data: selected.body });
    } catch (err) {
      notify(toErrorPayload(err).message, 'error');
    }
  };
  return (
    <div className="flex h-full min-h-0">
      <div className="w-56 border-r border-edge flex flex-col min-h-0 shrink-0">
        <div className="flex items-center justify-between pl-3 pr-1 h-9 border-b border-edge shrink-0">
          <span className="text-[11px] text-muted">Reusable payloads</span>
          <IconButton label="Add message" size="sm" onClick={add}>
            <Plus className="size-3.5" />
          </IconButton>
        </div>
        <div className="flex-1 overflow-y-auto">
          {draft.messages.map((m) => (
            <button key={m.id} type="button" onClick={() => setSelectedId(m.id)} className={cn('w-full text-left px-3 h-8 text-xs hover:bg-elevated truncate', m.id === selectedId && 'bg-elevated')}>
              {m.name || m.body.slice(0, 40) || '(empty)'}
            </button>
          ))}
          {draft.messages.length === 0 && <p className="px-3 py-3 text-xs text-muted">Keep messages you send often. Agents can send them by id with realtime.send.</p>}
        </div>
      </div>
      <div className="flex-1 min-w-0 flex flex-col gap-2 p-3">
        {selected ? (
          <>
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <Label>Name</Label>
                <Input value={selected.name} onChange={(e) => update({ name: e.target.value })} />
              </div>
              <Button size="sm" variant="primary" icon={<Send className="size-3.5" />} disabled={summary.status !== 'open'} onClick={() => void send()}>
                Send
              </Button>
              <IconButton label="Delete message" onClick={remove}>
                <Trash2 className="size-3.5" />
              </IconButton>
            </div>
            <div className="flex-1 min-h-[160px]">
              <CodeEditor value={selected.body} onChange={(body) => update({ body })} language={/^\s*[[{]/.test(selected.body) ? 'json' : 'text'} placeholder="Payload; {{variables}} resolve on send" />
            </div>
          </>
        ) : (
          <p className="text-xs text-muted">Pick a message or add one.</p>
        )}
      </div>
    </div>
  );
}

function SettingsView({ draft, patch, onDelete }: { draft: RealtimeConnection; patch(p: Partial<RealtimeConnection>): void; onDelete(): void }) {
  const isWs = draft.kind === 'websocket';
  return (
    <div className="flex flex-col gap-4 p-3 overflow-y-auto h-full max-w-3xl">
      <section className="grid grid-cols-2 gap-3">
        <div>
          <Label>Kind</Label>
          <Select value={draft.kind} onChange={(e) => patch({ kind: e.target.value as RealtimeConnection['kind'] })} className="w-full" data-testid="realtime-kind">
            <option value="websocket">WebSocket (two-way messages)</option>
            <option value="sse">Server-Sent Events (server pushes events)</option>
          </Select>
        </div>
        {isWs ? (
          <div>
            <Label>Subprotocols</Label>
            <Input value={draft.protocols.join(', ')} onChange={(e) => patch({ protocols: e.target.value.split(',').map((p) => p.trim()).filter(Boolean) })} placeholder="e.g. graphql-transport-ws" className="font-mono" />
          </div>
        ) : (
          <div>
            <Label>Request method</Label>
            <Select value={draft.method} onChange={(e) => patch({ method: e.target.value as RealtimeConnection['method'] })} className="w-full">
              <option value="GET">GET</option>
              <option value="POST">POST with a body</option>
            </Select>
          </div>
        )}
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={draft.reconnect} onChange={(e) => patch({ reconnect: e.target.checked })} /> Reconnect when the connection drops
        </label>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={draft.autoConnect} onChange={(e) => patch({ autoConnect: e.target.checked })} /> Connect when the workspace opens
        </label>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={draft.insecure} onChange={(e) => patch({ insecure: e.target.checked })} /> Accept self-signed certificates
        </label>
        <div>
          <Label>Messages to keep</Label>
          <Input type="number" min={10} max={5000} value={draft.logLimit} onChange={(e) => patch({ logLimit: clampInt(e.target.value, 10, 5000, 500) })} className="font-mono" />
        </div>
      </section>
      {!isWs && draft.method === 'POST' && (
        <section>
          <Label>Request body</Label>
          <div className="border border-edge rounded-md h-40">
            <CodeEditor value={draft.body} onChange={(body) => patch({ body })} language={/^\s*[[{]/.test(draft.body) ? 'json' : 'text'} fill placeholder="Sent when the stream is opened; {{variables}} resolve on connect" />
          </div>
        </section>
      )}
      <p className="text-[11px] text-muted">
        {isWs ? 'Reconnects back off from 1 s to 30 s. A close with code 1000 (normal) is not retried.' : 'Reconnects honour the retry hint of the server (3 s otherwise) and resume with Last-Event-ID. A non-2xx answer or a wrong content type is not retried.'}
      </p>
      <section className="border-t border-edge pt-3">
        <Button variant="danger" size="sm" icon={<Trash2 className="size-3.5" />} onClick={onDelete}>
          Delete this connection
        </Button>
      </section>
    </div>
  );
}

function clampInt(raw: string, min: number, max: number, fallback: number): number {
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
