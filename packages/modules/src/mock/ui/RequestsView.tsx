import {
  HttpMethodSchema,
  capturedToCurl,
  keyValue,
  mockServerUrl,
  replayableHeaders,
  toErrorPayload,
  type ApiRequest,
  type MockCapturedRequest,
  type MockReplayResult,
  type MockServerSummary,
} from '@quiver/core';
import { Badge, Button, CodeEditor, EmptyState, IconButton, Input, METHOD_COLORS, Segmented, cn, formatBytes, formatMs, invoke, notify, onHostEvent, promptDialog, statusColor, useAppStore, type CodeLanguage } from '@quiver/ui';
import { Copy, ExternalLink, Plus, RefreshCw, Repeat, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { openRequestTab } from '../../api/ui';

type DetailView = 'body' | 'headers' | 'query' | 'response';

const OUTCOME_LABEL: Record<MockCapturedRequest['outcome'], string> = {
  route: 'route',
  fallback: 'fallback',
  forwarded: 'forwarded',
  preflight: 'preflight',
  error: 'error',
};

const OUTCOME_CLASS: Record<MockCapturedRequest['outcome'], string> = {
  route: 'text-success',
  fallback: 'text-muted',
  forwarded: 'text-sky-600 dark:text-sky-400',
  preflight: 'text-muted',
  error: 'text-danger',
};

/** Remembered across tabs so replaying several webhooks to the same dev server is one click. */
let lastReplayTarget = 'http://localhost:3000';

export function RequestsView({ server, onCreateRoute }: { server: MockServerSummary; onCreateRoute(req: MockCapturedRequest): void }) {
  const [items, setItems] = useState<MockCapturedRequest[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const refresh = useCallback(async () => {
    try {
      setItems(await invoke<MockCapturedRequest[]>('mock.request.list', { serverId: server.id, limit: 300 }));
    } catch (err) {
      notify(toErrorPayload(err).message, 'error');
    }
  }, [server.id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(
    () =>
      onHostEvent('mock.changed', (p) => {
        if (p.serverId === server.id && p.reason === 'requests') void refresh();
      }),
    [server.id, refresh],
  );

  const clear = async () => {
    try {
      await invoke('mock.request.clear', { serverId: server.id });
      setSelectedId(null);
    } catch (err) {
      notify(toErrorPayload(err).message, 'error');
    }
  };

  const needle = filter.trim().toLowerCase();
  const filtered = useMemo(() => (needle ? (items ?? []).filter((r) => `${r.method} ${r.url} ${r.outcome} ${r.response.status}`.toLowerCase().includes(needle)) : (items ?? [])), [items, needle]);
  const selected = items?.find((r) => r.id === selectedId) ?? null;

  return (
    <div className="flex h-full min-h-0">
      <div className="w-80 border-r border-edge flex flex-col min-h-0 shrink-0">
        <div className="flex items-center gap-1 px-2 h-9 border-b border-edge shrink-0">
          <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by method, path, status" className="h-7 text-xs" />
          <IconButton label="Refresh" size="sm" onClick={() => void refresh()}>
            <RefreshCw className="size-3.5" />
          </IconButton>
          <IconButton label="Clear requests" size="sm" onClick={() => void clear()} disabled={!items?.length}>
            <Trash2 className="size-3.5" />
          </IconButton>
        </div>
        <div className="flex-1 overflow-y-auto" data-testid="mock-request-list">
          {filtered.map((r) => (
            <RequestRow key={r.id} req={r} selected={r.id === selectedId} onClick={() => setSelectedId(r.id)} />
          ))}
          {items && items.length === 0 && (
            <div className="px-3 py-3 text-xs text-muted">
              {server.running ? (
                <>
                  Waiting for requests on <code className="font-mono text-fg">{server.url}</code>. Anything sent there shows up here, matched or not.
                </>
              ) : (
                'The server is stopped. Start it to receive requests.'
              )}
            </div>
          )}
          {items && items.length > 0 && filtered.length === 0 && <p className="px-3 py-3 text-xs text-muted">No request matches the filter.</p>}
        </div>
      </div>
      <div className="flex-1 min-w-0 flex flex-col min-h-0">
        {selected ? (
          <RequestDetail key={selected.id} req={selected} server={server} onCreateRoute={onCreateRoute} />
        ) : (
          <EmptyState title="Select a request" hint="Inspect headers and body, replay it against your app, or turn it into a route." />
        )}
      </div>
    </div>
  );
}

function RequestRow({ req, selected, onClick }: { req: MockCapturedRequest; selected: boolean; onClick(): void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn('w-full text-left px-2 py-1 border-b border-edge/60 hover:bg-elevated flex flex-col gap-0.5 min-w-0', selected && 'bg-elevated')}
      data-testid="mock-request"
    >
      <span className="flex items-center gap-2 min-w-0">
        <span className={cn('text-[10px] font-semibold w-12 shrink-0', METHOD_COLORS[req.method] ?? 'text-muted')}>{req.method}</span>
        <span className="truncate flex-1 text-xs font-mono">{req.url}</span>
        <span className={cn('text-[11px] font-semibold shrink-0', statusColor(req.response.status))}>{req.response.status}</span>
      </span>
      <span className="flex items-center gap-2 pl-14 text-[10px] text-muted min-w-0">
        <span className={OUTCOME_CLASS[req.outcome]}>{OUTCOME_LABEL[req.outcome]}</span>
        <span>{formatMs(req.response.durationMs)}</span>
        {req.size > 0 && <span>{formatBytes(req.size)}</span>}
        <span className="flex-1" />
        <span>{new Date(req.at).toLocaleTimeString()}</span>
      </span>
    </button>
  );
}

function RequestDetail({ req, server, onCreateRoute }: { req: MockCapturedRequest; server: MockServerSummary; onCreateRoute(req: MockCapturedRequest): void }) {
  const [view, setView] = useState<DetailView>('body');
  const [replay, setReplay] = useState<MockReplayResult | null>(null);
  const [replayError, setReplayError] = useState<string | null>(null);
  const [replaying, setReplaying] = useState(false);
  const baseUrl = server.url ?? mockServerUrl(server);

  const doReplay = async () => {
    const target = await promptDialog({ title: 'Replay request', label: 'Send it to (base URL keeps the captured path)', defaultValue: lastReplayTarget, confirmLabel: 'Send' });
    if (!target?.trim()) return;
    lastReplayTarget = target.trim();
    setReplaying(true);
    setReplayError(null);
    try {
      setReplay(await invoke<MockReplayResult>('mock.request.replay', { serverId: server.id, requestId: req.id, url: target.trim() }));
    } catch (err) {
      setReplay(null);
      setReplayError(toErrorPayload(err).message);
    } finally {
      setReplaying(false);
    }
  };

  const copyCurl = async () => {
    await navigator.clipboard.writeText(capturedToCurl(req, baseUrl));
    notify('Copied curl command', 'success');
  };

  const openInApi = async () => {
    try {
      const method = (HttpMethodSchema.options as string[]).includes(req.method) ? req.method : 'GET';
      const created = await invoke<ApiRequest>('api.request.create', { name: `${req.method} ${req.path}`, method, url: `${baseUrl}${req.url}` });
      const headers = replayableHeaders(req.headers).map(([k, v]) => keyValue(k, v));
      const body: ApiRequest['body'] =
        req.bodyEncoding === 'utf8' && req.body ? (/json/i.test(req.contentType ?? '') ? { type: 'json', content: req.body } : { type: 'text', content: req.body }) : { type: 'none' };
      const saved = await invoke<ApiRequest>('api.request.save', { request: { ...created, headers, body } });
      useAppStore.getState().setActiveModule('api');
      openRequestTab(saved);
    } catch (err) {
      notify(toErrorPayload(err).message, 'error');
    }
  };

  const body = useMemo(() => formatBody(req.body, req.bodyEncoding, req.contentType, req.truncated, req.size), [req]);
  const responseBody = useMemo(
    () => formatBody(req.response.body, req.response.bodyEncoding, headerOf(req.response.headers, 'content-type'), req.response.truncated, req.response.size),
    [req],
  );
  const query = Object.entries(req.query);

  return (
    <div className="flex flex-col h-full min-h-0" data-testid="mock-request-detail">
      <div className="flex flex-col gap-1.5 px-3 py-2 border-b border-edge shrink-0">
        <div className="flex items-center gap-2 min-w-0 text-xs">
          <span className={cn('font-semibold', METHOD_COLORS[req.method] ?? '')}>{req.method}</span>
          <span className="font-mono truncate flex-1" title={req.url}>
            {req.url}
          </span>
          <span className={cn('font-semibold', statusColor(req.response.status))}>{req.response.status}</span>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-muted flex-wrap">
          <Badge className={OUTCOME_CLASS[req.outcome]}>{OUTCOME_LABEL[req.outcome]}</Badge>
          <span>{new Date(req.at).toLocaleString()}</span>
          <span>{formatMs(req.response.durationMs)}</span>
          <span>{formatBytes(req.size)} in</span>
          <span>{formatBytes(req.response.size)} out</span>
          {req.remoteAddress && <span>from {req.remoteAddress}</span>}
          <span className="flex-1" />
          <Button size="sm" variant="ghost" icon={<Repeat className="size-3.5" />} loading={replaying} onClick={() => void doReplay()} title="Send this request to another server">
            Replay
          </Button>
          <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => onCreateRoute(req)} title="Add a route that answers this method and path">
            Route
          </Button>
          <Button size="sm" variant="ghost" icon={<ExternalLink className="size-3.5" />} onClick={() => void openInApi()} title="Open as an editable request in the API client">
            API client
          </Button>
          <Button size="sm" variant="ghost" icon={<Copy className="size-3.5" />} onClick={() => void copyCurl()}>
            curl
          </Button>
        </div>
        {(replay || replayError) && (
          <div className="text-[11px] flex items-center gap-2">
            <span className="text-muted">Replay:</span>
            {replay && (
              <>
                <span className={cn('font-semibold', statusColor(replay.status))}>
                  {replay.status} {replay.statusText}
                </span>
                <span className="text-muted">{formatMs(replay.durationMs)}</span>
                <span className="text-muted truncate">{replay.url}</span>
              </>
            )}
            {replayError && <span className="text-danger truncate">{replayError}</span>}
          </div>
        )}
      </div>
      <Segmented<DetailView>
        value={view}
        onChange={setView}
        className="shrink-0"
        options={[
          { value: 'body', label: 'Body' },
          { value: 'headers', label: `Headers (${req.headers.length})` },
          { value: 'query', label: `Query (${query.length})` },
          { value: 'response', label: replay ? 'Response / replay' : 'Response' },
        ]}
      />
      <div className="flex-1 min-h-0 p-2 overflow-auto">
        {view === 'body' && <BodyPane text={body.text} language={body.language} note={body.note} />}
        {view === 'headers' && <HeaderTable headers={req.headers} />}
        {view === 'query' && (query.length ? <HeaderTable headers={query} /> : <p className="text-xs text-muted px-1">No query parameters.</p>)}
        {view === 'response' && (
          <div className="flex flex-col gap-3 h-full min-h-0">
            <ResponseBlock title={`Answered ${req.response.status}`} headers={req.response.headers} text={responseBody.text} language={responseBody.language} note={responseBody.note} />
            {replay && (
              <ResponseBlock
                title={`Replay to ${replay.url}: ${replay.status} ${replay.statusText}`}
                headers={replay.headers}
                {...formatBody(replay.body, replay.bodyEncoding, headerOf(replay.headers, 'content-type'), replay.truncated, replay.size)}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ResponseBlock({ title, headers, text, language, note }: { title: string; headers: [string, string][]; text: string; language: CodeLanguage; note: string | null }) {
  return (
    <div className="flex flex-col gap-1 min-h-0">
      <p className="text-xs font-medium">{title}</p>
      {headers.length > 0 && (
        <div className="max-h-32 overflow-auto">
          <HeaderTable headers={headers} />
        </div>
      )}
      <BodyPane text={text} language={language} note={note} minHeight={120} />
    </div>
  );
}

function BodyPane({ text, language, note, minHeight = 200 }: { text: string; language: CodeLanguage; note: string | null; minHeight?: number }) {
  if (!text && !note) return <p className="text-xs text-muted px-1">Empty body.</p>;
  return (
    <div className="flex flex-col gap-1 h-full min-h-0">
      {note && <p className="text-[11px] text-warning px-1">{note}</p>}
      {text && (
        <div className="flex-1 min-h-0" style={{ minHeight }}>
          <CodeEditor value={text} readOnly language={language} wrap={language !== 'json'} />
        </div>
      )}
    </div>
  );
}

function HeaderTable({ headers }: { headers: [string, string][] }) {
  return (
    <div className="overflow-auto text-xs font-mono">
      <table className="w-full">
        <tbody>
          {headers.map(([k, v], i) => (
            <tr key={`${k}-${i}`} className="border-b border-edge/60 align-top">
              <td className="py-1 pr-3 text-muted whitespace-nowrap">{k}</td>
              <td className="py-1 break-all">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function headerOf(headers: [string, string][], name: string): string | null {
  return headers.find(([k]) => k.toLowerCase() === name)?.[1] ?? null;
}

function formatBody(body: string, encoding: 'utf8' | 'base64', contentType: string | null, truncated: boolean, size: number): { text: string; language: CodeLanguage; note: string | null } {
  const note = truncated ? `Only the first ${formatBytes(body.length)} of ${formatBytes(size)} were kept.` : null;
  if (!body) return { text: '', language: 'text', note };
  if (encoding === 'base64') return { text: `${body.slice(0, 4000)}${body.length > 4000 ? '…' : ''}`, language: 'text', note: `Binary body (${formatBytes(size)}), shown as base64.${note ? ` ${note}` : ''}` };
  const looksJson = /json/i.test(contentType ?? '') || /^\s*[[{]/.test(body);
  if (looksJson) {
    try {
      return { text: JSON.stringify(JSON.parse(body), null, 2), language: 'json', note };
    } catch {
      return { text: body, language: 'json', note };
    }
  }
  if (/html/i.test(contentType ?? '')) return { text: body, language: 'html', note };
  if (/xml/i.test(contentType ?? '')) return { text: body, language: 'xml', note };
  return { text: body, language: 'text', note };
}
