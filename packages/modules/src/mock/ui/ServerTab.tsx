import {
  MockMethodSchema,
  MockServerSchema,
  describeRoute,
  mockServerUrl,
  newMockRoute,
  toErrorPayload,
  type KeyValue,
  type MockCapturedRequest,
  type MockFallback,
  type MockMethod,
  type MockRoute,
  type MockServer,
  type MockServerSummary,
} from '@quiver/core';
import {
  Button,
  Checkbox,
  CodeEditor,
  EmptyState,
  IconButton,
  Input,
  KeyValueEditor,
  Label,
  METHOD_COLORS,
  Segmented,
  Select,
  Spinner,
  cn,
  invoke,
  notify,
  onHostEvent,
  useTabsStore,
  type TabProps,
} from '@quiver/ui';
import { ArrowDown, ArrowUp, Copy, Play, Plus, Save, Square, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RequestsView } from './RequestsView';
import { deleteServer, toggleServer, type ServerView } from './index';

const TEMPLATE_HINT = 'Templates: {{params.id}} {{query.page}} {{headers.authorization}} {{body.user.email}} {{$uuid}} {{$isoTimestamp}} {{$randomInt}}';

function definitionOf(summary: MockServerSummary): MockServer {
  return MockServerSchema.parse(summary);
}

export function ServerTab({ tab, scope }: TabProps) {
  const serverId = String(tab.data?.id ?? '');
  const [server, setServer] = useState<MockServerSummary | null>(null);
  const [draft, setDraft] = useState<MockServer | null>(null);
  const [saved, setSaved] = useState<MockServer | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [view, setView] = useState<ServerView>((tab.data?.view as ServerView | undefined) ?? 'routes');
  const [routeId, setRouteId] = useState<string | null>((tab.data?.routeId as string | undefined) ?? null);
  const updateTab = useTabsStore((s) => s.updateTab);
  const dirtyRef = useRef(false);

  const load = useCallback(async () => {
    try {
      const summary = await invoke<MockServerSummary>('mock.server.get', { id: serverId });
      setServer(summary);
      const def = definitionOf(summary);
      setSaved(def);
      // Keep unsaved edits; otherwise follow changes made elsewhere (MCP, another tab).
      setDraft((current) => (current && dirtyRef.current ? current : def));
      setLoadError(null);
    } catch (err) {
      setLoadError(toErrorPayload(err).message);
    }
  }, [serverId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(
    () =>
      onHostEvent('store.changed', (p) => {
        if (p.collection === 'mock-servers') void load();
      }),
    [load],
  );

  useEffect(
    () =>
      onHostEvent('mock.changed', (p) => {
        if (p.serverId === serverId) void load();
      }),
    [load, serverId],
  );

  const nonce = tab.data?.nonce;
  useEffect(() => {
    const wanted = tab.data?.view as ServerView | undefined;
    if (wanted) setView(wanted);
    const wantedRoute = tab.data?.routeId as string | undefined;
    if (wantedRoute) setRouteId(wantedRoute);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce]);

  const dirty = useMemo(() => Boolean(draft && saved && JSON.stringify(draft) !== JSON.stringify(saved)), [draft, saved]);
  dirtyRef.current = dirty;

  useEffect(() => {
    if (tab.dirty !== dirty) updateTab(scope, tab.id, { dirty });
  }, [dirty, scope, tab.id, tab.dirty, updateTab]);

  const patch = useCallback((p: Partial<MockServer>) => setDraft((d) => (d ? { ...d, ...p } : d)), []);

  const save = useCallback(async () => {
    if (!draft) return;
    try {
      const stored = await invoke<MockServerSummary>('mock.server.save', { server: draft });
      const def = definitionOf(stored);
      setServer(stored);
      setSaved(def);
      setDraft(def);
      updateTab(scope, tab.id, { title: stored.name });
      notify(stored.running ? 'Saved and applied to the running server' : 'Saved', 'success');
    } catch (err) {
      notify(toErrorPayload(err).message, 'error');
    }
  }, [draft, scope, tab.id, updateTab]);

  const addRouteFromRequest = useCallback(
    (req: MockCapturedRequest) => {
      const method = (MockMethodSchema.options as string[]).includes(req.method) ? (req.method as MockMethod) : 'ANY';
      const forwarded = req.outcome === 'forwarded' && req.response.bodyEncoding === 'utf8';
      const contentType = req.response.headers.find(([k]) => k.toLowerCase() === 'content-type')?.[1];
      const route = newMockRoute({
        method,
        path: req.path,
        status: forwarded ? req.response.status : 200,
        headers: forwarded && contentType ? [{ id: `h-${Date.now()}`, key: 'Content-Type', value: contentType, enabled: true }] : [],
        body: forwarded ? req.response.body : '{\n  "ok": true\n}',
        description: `From request at ${new Date(req.at).toLocaleString()}`,
      });
      setDraft((d) => (d ? { ...d, routes: [...d.routes, route] } : d));
      setRouteId(route.id);
      setView('routes');
      notify('Route added. Save to apply it.', 'info');
    },
    [],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void save();
    }
  };

  if (loadError) return <div className="p-4 text-sm text-danger">{loadError}</div>;
  if (!draft || !server)
    return (
      <div className="flex items-center justify-center h-full">
        <Spinner />
      </div>
    );

  const url = server.url ?? mockServerUrl(server);

  return (
    <div className="flex flex-col h-full min-h-0" onKeyDown={onKeyDown} data-testid="mock-server-tab">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-edge shrink-0">
        <div className="w-56 shrink-0">
          <Input value={draft.name} onChange={(e) => patch({ name: e.target.value })} className="font-medium" aria-label="Server name" />
        </div>
        <span className={cn('size-2 rounded-full shrink-0', server.running ? 'bg-success' : server.error ? 'bg-danger' : 'bg-muted/50')} />
        <span className="text-xs font-mono text-muted truncate shrink" data-testid="mock-server-url">
          {server.running ? url : `stopped · port ${server.port}`}
        </span>
        {server.host === '0.0.0.0' && <span className="text-[10px] text-muted shrink-0">all interfaces</span>}
        <IconButton label="Copy URL" size="sm" onClick={() => void navigator.clipboard.writeText(url).then(() => notify('Copied', 'success'))}>
          <Copy className="size-3.5" />
        </IconButton>
        {server.error && (
          <span className="text-xs text-danger truncate min-w-0" title={server.error}>
            {server.error}
          </span>
        )}
        <div className="flex-1 min-w-4" />
        <Button size="sm" variant={server.running ? 'secondary' : 'primary'} icon={server.running ? <Square className="size-3" /> : <Play className="size-3.5" />} onClick={() => void toggleServer(server)}>
          {server.running ? 'Stop' : 'Start'}
        </Button>
        <Button size="sm" variant={dirty ? 'secondary' : 'ghost'} icon={<Save className="size-3.5" />} onClick={() => void save()} title="Ctrl+S">
          Save{dirty ? '*' : ''}
        </Button>
      </div>
      <Segmented<ServerView>
        value={view}
        onChange={setView}
        className="shrink-0 px-1"
        options={[
          { value: 'routes', label: `Routes (${draft.routes.length})` },
          { value: 'requests', label: `Requests (${server.requestCount})` },
          { value: 'settings', label: 'Settings' },
        ]}
      />
      <div className="flex-1 min-h-0">
        {view === 'routes' && <RoutesView draft={draft} routeId={routeId} onSelect={setRouteId} onChange={(routes) => patch({ routes })} />}
        {view === 'requests' && <RequestsView server={server} onCreateRoute={addRouteFromRequest} />}
        {view === 'settings' && <SettingsView draft={draft} patch={patch} onDelete={() => void deleteServer(server)} />}
      </div>
    </div>
  );
}

// ---------- routes ----------

function RoutesView({ draft, routeId, onSelect, onChange }: { draft: MockServer; routeId: string | null; onSelect(id: string | null): void; onChange(routes: MockRoute[]): void }) {
  const index = draft.routes.findIndex((r) => r.id === routeId);
  const selected = index >= 0 ? draft.routes[index] : null;

  const add = () => {
    const route = newMockRoute({ method: 'GET', path: '/', status: 200, body: '{\n  "ok": true\n}' });
    onChange([...draft.routes, route]);
    onSelect(route.id);
  };
  const update = (p: Partial<MockRoute>) => onChange(draft.routes.map((r) => (r.id === routeId ? { ...r, ...p } : r)));
  const remove = () => {
    onChange(draft.routes.filter((r) => r.id !== routeId));
    onSelect(null);
  };
  const move = (dir: -1 | 1) => {
    const target = index + dir;
    if (index < 0 || target < 0 || target >= draft.routes.length) return;
    const routes = [...draft.routes];
    [routes[index], routes[target]] = [routes[target], routes[index]];
    onChange(routes);
  };

  return (
    <div className="flex h-full min-h-0">
      <div className="w-64 border-r border-edge flex flex-col min-h-0 shrink-0">
        <div className="flex items-center justify-between pl-3 pr-1 h-9 border-b border-edge shrink-0">
          <span className="text-[11px] text-muted">First match wins, top to bottom</span>
          <IconButton label="Add route" size="sm" onClick={add}>
            <Plus className="size-3.5" />
          </IconButton>
        </div>
        <div className="flex-1 overflow-y-auto">
          {draft.routes.map((route) => (
            <button
              key={route.id}
              type="button"
              onClick={() => onSelect(route.id)}
              className={cn('w-full text-left flex items-center gap-2 px-3 h-8 hover:bg-elevated min-w-0', route.id === routeId && 'bg-elevated', !route.enabled && 'opacity-50')}
              title={describeRoute(route)}
              data-testid="mock-route-item"
            >
              <span className={cn('text-[10px] font-semibold w-11 shrink-0', METHOD_COLORS[route.method] ?? 'text-muted')}>{route.method}</span>
              <span className="truncate flex-1 text-xs font-mono">{route.path || '/'}</span>
              <span className="text-[10px] text-muted shrink-0">{route.status}</span>
            </button>
          ))}
          {draft.routes.length === 0 && (
            <div className="px-3 py-3 text-xs text-muted flex flex-col gap-2">
              <p>No routes yet. Every request gets the fallback answer from Settings, which is all a webhook receiver needs.</p>
              <Button size="sm" variant="secondary" icon={<Plus className="size-3.5" />} onClick={add} className="self-start">
                Add route
              </Button>
            </div>
          )}
        </div>
      </div>
      <div className="flex-1 min-w-0 overflow-y-auto">
        {selected ? (
          <RouteEditor route={selected} onChange={update} onDelete={remove} onMove={move} canUp={index > 0} canDown={index < draft.routes.length - 1} />
        ) : (
          <EmptyState title="Pick a route" hint="Routes answer with a status, headers and a templated body. Requests that match none get the fallback." action={<Button onClick={add}>Add route</Button>} />
        )}
      </div>
    </div>
  );
}

function RouteEditor({
  route,
  onChange,
  onDelete,
  onMove,
  canUp,
  canDown,
}: {
  route: MockRoute;
  onChange(patch: Partial<MockRoute>): void;
  onDelete(): void;
  onMove(dir: -1 | 1): void;
  canUp: boolean;
  canDown: boolean;
}) {
  const language = /^\s*[[{]/.test(route.body) ? 'json' : /^\s*</.test(route.body) ? 'html' : 'text';
  return (
    <div className="flex flex-col gap-3 p-3" data-testid="mock-route-editor">
      <div className="flex items-end gap-2 flex-wrap">
        <label className="flex items-center gap-1.5 text-xs h-8">
          <Checkbox checked={route.enabled} onChange={(e) => onChange({ enabled: e.target.checked })} /> Enabled
        </label>
        <div>
          <Label>Method</Label>
          <Select value={route.method} onChange={(e) => onChange({ method: e.target.value as MockMethod })} className="w-24" data-testid="mock-route-method">
            {MockMethodSchema.options.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex-1 min-w-48">
          <Label>Path</Label>
          <Input value={route.path} onChange={(e) => onChange({ path: e.target.value })} placeholder="/users/:id or /files/*" className="font-mono" data-testid="mock-route-path" />
        </div>
        <div>
          <Label>Status</Label>
          <Input type="number" min={100} max={599} value={route.status} onChange={(e) => onChange({ status: clampInt(e.target.value, 100, 599, 200) })} className="w-20 font-mono" />
        </div>
        <div>
          <Label>Delay (ms)</Label>
          <Input type="number" min={0} max={120000} value={route.delayMs} onChange={(e) => onChange({ delayMs: clampInt(e.target.value, 0, 120_000, 0) })} className="w-24 font-mono" />
        </div>
        <div className="flex items-center gap-0.5 h-8">
          <IconButton label="Move up" size="sm" disabled={!canUp} onClick={() => onMove(-1)}>
            <ArrowUp className="size-3.5" />
          </IconButton>
          <IconButton label="Move down" size="sm" disabled={!canDown} onClick={() => onMove(1)}>
            <ArrowDown className="size-3.5" />
          </IconButton>
          <IconButton label="Delete route" size="sm" onClick={onDelete}>
            <Trash2 className="size-3.5" />
          </IconButton>
        </div>
      </div>
      <div>
        <Label>Description</Label>
        <Input value={route.description} onChange={(e) => onChange({ description: e.target.value })} placeholder="What this route stands in for" />
      </div>
      <div>
        <Label>Response headers</Label>
        <KeyValueEditor<KeyValue> rows={route.headers} onChange={(headers) => onChange({ headers })} keyPlaceholder="Header" valuePlaceholder="Value" />
        <p className="text-[11px] text-muted mt-1">Content-Type is inferred from the body when not set.</p>
      </div>
      <div className="flex flex-col gap-1">
        <Label>Response body</Label>
        <div className="border border-edge rounded-md min-h-[200px] h-[280px]">
          <CodeEditor value={route.body} onChange={(body) => onChange({ body })} language={language} fill placeholder="Leave empty for no body" />
        </div>
        <p className="text-[11px] text-muted font-mono">{TEMPLATE_HINT}</p>
      </div>
    </div>
  );
}

// ---------- settings ----------

function SettingsView({ draft, patch, onDelete }: { draft: MockServer; patch(p: Partial<MockServer>): void; onDelete(): void }) {
  const fallback = draft.fallback;
  const setFallback = (next: MockFallback) => patch({ fallback: next });
  const fallbackLanguage = fallback.type === 'respond' && /^\s*[[{]/.test(fallback.body) ? 'json' : 'text';
  return (
    <div className="flex flex-col gap-4 p-3 overflow-y-auto h-full max-w-3xl">
      <section className="grid grid-cols-2 gap-3">
        <div>
          <Label>Port</Label>
          <Input type="number" min={1} max={65535} value={draft.port} onChange={(e) => patch({ port: clampInt(e.target.value, 0, 65535, 0) })} className="font-mono" data-testid="mock-port" />
        </div>
        <div>
          <Label>Listen on</Label>
          <Select value={draft.host} onChange={(e) => patch({ host: e.target.value as MockServer['host'] })} className="w-full">
            <option value="127.0.0.1">This machine only (127.0.0.1)</option>
            <option value="0.0.0.0">All interfaces (containers, other devices)</option>
          </Select>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={draft.autoStart} onChange={(e) => patch({ autoStart: e.target.checked })} /> Start when the workspace opens
        </label>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={draft.cors} onChange={(e) => patch({ cors: e.target.checked })} /> Allow browser calls (CORS headers and preflight)
        </label>
        <div>
          <Label>Captured requests to keep</Label>
          <Input type="number" min={10} max={5000} value={draft.logLimit} onChange={(e) => patch({ logLimit: clampInt(e.target.value, 10, 5000, 500) })} className="font-mono" />
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <div>
          <Label>When no route matches</Label>
          <Select
            value={fallback.type}
            onChange={(e) =>
              setFallback(e.target.value === 'forward' ? { type: 'forward', url: '' } : { type: 'respond', status: 404, headers: [], body: '{"error":"no mock route matched"}' })
            }
            className="w-full"
            data-testid="mock-fallback-type"
          >
            <option value="respond">Answer with a fixed response (404 by default, 200 for a webhook receiver)</option>
            <option value="forward">Forward to a real server and record the exchange</option>
          </Select>
        </div>
        {fallback.type === 'respond' ? (
          <>
            <div className="flex items-end gap-2">
              <div>
                <Label>Status</Label>
                <Input type="number" min={100} max={599} value={fallback.status} onChange={(e) => setFallback({ ...fallback, status: clampInt(e.target.value, 100, 599, 404) })} className="w-20 font-mono" />
              </div>
              <p className="text-[11px] text-muted pb-2">Body and headers accept the same templates as routes.</p>
            </div>
            <div>
              <Label>Headers</Label>
              <KeyValueEditor<KeyValue> rows={fallback.headers} onChange={(headers) => setFallback({ ...fallback, headers })} keyPlaceholder="Header" valuePlaceholder="Value" />
            </div>
            <div>
              <Label>Body</Label>
              <div className="border border-edge rounded-md h-40">
                <CodeEditor value={fallback.body} onChange={(body) => setFallback({ ...fallback, body })} language={fallbackLanguage} fill />
              </div>
            </div>
          </>
        ) : (
          <div>
            <Label>Forward to</Label>
            <Input value={fallback.url} onChange={(e) => setFallback({ ...fallback, url: e.target.value })} placeholder="http://localhost:3000 or https://api.example.com/v1" className="font-mono" data-testid="mock-forward-url" />
            <p className="text-[11px] text-muted mt-1">The request path and query are appended. Routes still take precedence, so you can override single endpoints of a real API.</p>
          </div>
        )}
      </section>

      <section className="border-t border-edge pt-3">
        <Button variant="danger" size="sm" icon={<Trash2 className="size-3.5" />} onClick={onDelete}>
          Delete this server
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
