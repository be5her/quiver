import {
  McpServerSchema,
  capabilityLabels,
  describeMcpServer,
  joinCommandLine,
  splitCommandLine,
  toErrorPayload,
  transportLabel,
  type KeyValue,
  type McpServer,
  type McpServerSummary,
} from '@quiver/core';
import { Badge, Button, Checkbox, Input, KeyValueEditor, Label, Segmented, Select, Spinner, cn, invoke, notify, onHostEvent, useTabsStore, type TabProps } from '@quiver/ui';
import { Activity, Plug, Save, Trash2, Unplug } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AuthEditor } from '../../api/ui/RequestTab';
import { LogView } from './LogView';
import { PromptsView } from './PromptsView';
import { ResourcesView } from './ResourcesView';
import { TRANSPORT_COLOR, statusDot } from './Sidebar';
import { ToolsView, formatMs } from './ToolsView';
import { deleteServer, type ServerView } from './index';

const STATUS_LABEL: Record<McpServerSummary['status'], string> = {
  disconnected: 'disconnected',
  connecting: 'connecting…',
  connected: 'connected',
};

function definitionOf(summary: McpServerSummary): McpServer {
  return McpServerSchema.parse(summary);
}

export function ServerTab({ tab, scope }: TabProps) {
  const serverId = String(tab.data?.id ?? '');
  const [summary, setSummary] = useState<McpServerSummary | null>(null);
  const [draft, setDraft] = useState<McpServer | null>(null);
  const [saved, setSaved] = useState<McpServer | null>(null);
  const [commandLine, setCommandLine] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [view, setView] = useState<ServerView>((tab.data?.view as ServerView | undefined) ?? 'tools');
  const [busy, setBusy] = useState(false);
  const updateTab = useTabsStore((s) => s.updateTab);
  const dirtyRef = useRef(false);

  const load = useCallback(async () => {
    try {
      const next = await invoke<McpServerSummary>('mcp.server.get', { id: serverId });
      setSummary(next);
      const def = definitionOf(next);
      setSaved(def);
      setDraft((current) => (current && dirtyRef.current ? current : def));
      if (!dirtyRef.current) setCommandLine(joinCommandLine(def.command, def.args));
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
        if (p.collection === 'mcp-servers') void load();
      }),
    [load],
  );

  useEffect(
    () =>
      onHostEvent('mcp.changed', (p) => {
        if (p.serverId === serverId && p.reason !== 'log') void load();
      }),
    [load, serverId],
  );

  const nonce = tab.data?.nonce;
  useEffect(() => {
    const wanted = tab.data?.view as ServerView | undefined;
    if (wanted) setView(wanted);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce]);

  const dirty = useMemo(() => Boolean(draft && saved && JSON.stringify(draft) !== JSON.stringify(saved)), [draft, saved]);
  dirtyRef.current = dirty;

  useEffect(() => {
    if (tab.dirty !== dirty) updateTab(scope, tab.id, { dirty });
  }, [dirty, scope, tab.id, tab.dirty, updateTab]);

  const patch = useCallback((p: Partial<McpServer>) => setDraft((d) => (d ? { ...d, ...p } : d)), []);

  const setCommand = (text: string) => {
    setCommandLine(text);
    const [command = '', ...args] = splitCommandLine(text);
    patch({ command, args });
  };

  const save = useCallback(async (): Promise<boolean> => {
    if (!draft) return false;
    try {
      const stored = await invoke<McpServerSummary>('mcp.server.save', { server: draft });
      const def = definitionOf(stored);
      setSummary(stored);
      setSaved(def);
      setDraft(def);
      setCommandLine(joinCommandLine(def.command, def.args));
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
        const opened = await invoke<McpServerSummary>('mcp.connect', { id: serverId });
        setSummary(opened);
        if (opened.error && opened.status === 'disconnected') notify(opened.error, 'error');
      } else {
        setSummary(await invoke<McpServerSummary>('mcp.disconnect', { id: serverId }));
      }
    } catch (err) {
      notify(toErrorPayload(err).message, 'error');
    } finally {
      setBusy(false);
    }
  }, [summary, busy, save, serverId]);

  const ping = async () => {
    try {
      const out = await invoke<{ durationMs: number }>('mcp.ping', { id: serverId });
      notify(`Pong in ${formatMs(out.durationMs)}`, 'success');
    } catch (err) {
      notify(toErrorPayload(err).message, 'error');
    }
  };

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
  const isStdio = draft.transport === 'stdio';

  return (
    <div className="flex flex-col h-full min-h-0" onKeyDown={onKeyDown} data-testid="mcp-server-tab">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-edge shrink-0">
        <div className="w-56 shrink-0">
          <Input value={draft.name} onChange={(e) => patch({ name: e.target.value })} className="font-medium" aria-label="Server name" />
        </div>
        <span className={cn('text-[10px] font-bold shrink-0', TRANSPORT_COLOR[draft.transport])}>{transportLabel(draft.transport)}</span>
        <span className={cn('size-2 rounded-full shrink-0', statusDot(summary.status, summary.error))} />
        <span className="text-xs text-muted shrink-0" data-testid="mcp-status">
          {STATUS_LABEL[summary.status]}
          {summary.serverInfo ? ` · ${summary.serverInfo.name} ${summary.serverInfo.version}` : ''}
        </span>
        {summary.error && (
          <span className="text-xs text-danger truncate min-w-0" title={summary.error} data-testid="mcp-error">
            {summary.error}
          </span>
        )}
        <div className="flex-1 min-w-4" />
        {summary.status === 'connected' && (
          <Button size="sm" variant="ghost" icon={<Activity className="size-3.5" />} onClick={() => void ping()} title="Send a ping request">
            Ping
          </Button>
        )}
        <Button size="sm" variant={dirty ? 'secondary' : 'ghost'} icon={<Save className="size-3.5" />} onClick={() => void save().then((ok) => ok && notify('Saved', 'success'))} title="Ctrl+S">
          Save{dirty ? '*' : ''}
        </Button>
      </div>
      <div className="flex items-center gap-2 px-3 py-2 shrink-0">
        {isStdio ? (
          <Input
            value={commandLine}
            onChange={(e) => setCommand(e.target.value)}
            placeholder="npx -y @modelcontextprotocol/server-filesystem {{projectDir}}"
            className="font-mono"
            autoFocus={!draft.command}
            data-testid="mcp-command"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !open) void toggle();
            }}
          />
        ) : (
          <Input
            value={draft.url}
            onChange={(e) => patch({ url: e.target.value })}
            placeholder={draft.transport === 'sse' ? 'https://{{host}}/sse' : 'https://{{host}}/mcp'}
            className="font-mono"
            autoFocus={!draft.url}
            data-testid="mcp-url"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !open) void toggle();
            }}
          />
        )}
        <Button variant={open ? 'secondary' : 'primary'} icon={open ? <Unplug className="size-3.5" /> : <Plug className="size-3.5" />} loading={busy} onClick={() => void toggle()} data-testid="mcp-toggle">
          {open ? 'Disconnect' : 'Connect'}
        </Button>
      </div>
      <Segmented<ServerView>
        value={view}
        onChange={setView}
        className="shrink-0 px-1"
        options={[
          { value: 'tools', label: `Tools (${summary.toolCount})` },
          { value: 'resources', label: `Resources (${summary.resourceCount})` },
          { value: 'prompts', label: `Prompts (${summary.promptCount})` },
          { value: 'log', label: `Log (${summary.logCount})` },
          { value: 'info', label: 'Info' },
          { value: 'settings', label: 'Settings' },
        ]}
      />
      <div className="flex-1 min-h-0">
        {view === 'tools' && <ToolsView server={summary} />}
        {view === 'resources' && <ResourcesView server={summary} />}
        {view === 'prompts' && <PromptsView server={summary} />}
        {view === 'log' && <LogView server={summary} />}
        {view === 'info' && <InfoView summary={summary} />}
        {view === 'settings' && <SettingsView draft={draft} patch={patch} onDelete={() => void deleteServer(summary)} />}
      </div>
    </div>
  );
}

function InfoView({ summary }: { summary: McpServerSummary }) {
  const labels = capabilityLabels(summary.capabilities);
  return (
    <div className="flex flex-col gap-4 p-3 overflow-y-auto h-full max-w-3xl text-sm" data-testid="mcp-info">
      <section className="grid grid-cols-[10rem_1fr] gap-x-3 gap-y-1.5 text-xs">
        <span className="text-muted">Server</span>
        <span>{summary.serverInfo ? `${summary.serverInfo.title ?? summary.serverInfo.name} ${summary.serverInfo.version}${summary.serverInfo.title ? ` (${summary.serverInfo.name})` : ''}` : summary.status === 'connected' ? 'unknown' : 'not connected'}</span>
        <span className="text-muted">Protocol version</span>
        <span className="font-mono">{summary.protocolVersion ?? '–'}</span>
        <span className="text-muted">Transport</span>
        <span className="font-mono break-all">{describeMcpServer(summary)}</span>
        {summary.pid !== null && (
          <>
            <span className="text-muted">Process id</span>
            <span className="font-mono">{summary.pid}</span>
          </>
        )}
        <span className="text-muted">Connected since</span>
        <span>{summary.connectedAt ? new Date(summary.connectedAt).toLocaleString() : '–'}</span>
        {summary.importedFrom && (
          <>
            <span className="text-muted">Imported from</span>
            <span className="font-mono">{summary.importedFrom}</span>
          </>
        )}
      </section>
      <section>
        <Label>Capabilities</Label>
        <div className="flex flex-wrap gap-1" data-testid="mcp-capabilities">
          {labels.map((l) => (
            <Badge key={l}>{l}</Badge>
          ))}
          {labels.length === 0 && <span className="text-xs text-muted">{summary.status === 'connected' ? 'The server announced no capabilities.' : 'Connect to see what the server offers.'}</span>}
        </div>
      </section>
      <section>
        <Label>Instructions for agents</Label>
        {summary.instructions ? (
          <p className="text-xs whitespace-pre-wrap rounded-md border border-edge bg-surface px-2 py-1.5" data-testid="mcp-instructions">
            {summary.instructions}
          </p>
        ) : (
          <span className="text-xs text-muted">None.</span>
        )}
      </section>
      {summary.capabilities && (
        <section>
          <Label>Raw capabilities</Label>
          <pre className="text-[11px] font-mono rounded-md border border-edge bg-surface px-2 py-1.5 overflow-x-auto">{JSON.stringify(summary.capabilities, null, 2)}</pre>
        </section>
      )}
    </div>
  );
}

function SettingsView({ draft, patch, onDelete }: { draft: McpServer; patch(p: Partial<McpServer>): void; onDelete(): void }) {
  const isStdio = draft.transport === 'stdio';
  return (
    <div className="flex flex-col gap-4 p-3 overflow-y-auto h-full max-w-3xl">
      <section className="grid grid-cols-2 gap-3">
        <div>
          <Label>Transport</Label>
          <Select value={draft.transport} onChange={(e) => patch({ transport: e.target.value as McpServer['transport'] })} className="w-full" data-testid="mcp-transport">
            <option value="stdio">Command (stdio): Quiver starts the process</option>
            <option value="http">Streamable HTTP</option>
            <option value="sse">SSE (legacy HTTP+SSE)</option>
          </Select>
        </div>
        {isStdio ? (
          <div>
            <Label>Working directory</Label>
            <Input value={draft.cwd} onChange={(e) => patch({ cwd: e.target.value })} placeholder="project folder" className="font-mono" />
          </div>
        ) : (
          <label className="flex items-center gap-2 text-sm self-end pb-2">
            <Checkbox checked={draft.insecure} onChange={(e) => patch({ insecure: e.target.checked })} /> Accept self-signed certificates
          </label>
        )}
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={draft.autoConnect} onChange={(e) => patch({ autoConnect: e.target.checked })} /> Connect when the workspace opens
        </label>
        <div>
          <Label>Log entries to keep</Label>
          <Input type="number" min={10} max={5000} value={draft.logLimit} onChange={(e) => patch({ logLimit: clampInt(e.target.value, 10, 5000, 500) })} className="font-mono" />
        </div>
      </section>
      {isStdio ? (
        <section>
          <Label>Environment variables</Label>
          <KeyValueEditor<KeyValue> rows={draft.env} onChange={(env) => patch({ env })} keyPlaceholder="Variable" />
          <p className="text-[11px] text-muted px-1 mt-1">Added to Quiver's own environment when the process starts.</p>
        </section>
      ) : (
        <>
          <section>
            <Label>Headers</Label>
            <KeyValueEditor<KeyValue> rows={draft.headers} onChange={(headers) => patch({ headers })} keyPlaceholder="Header" />
            <p className="text-[11px] text-muted px-1 mt-1">Sent with every request of the session.</p>
          </section>
          <section>
            <Label>Auth</Label>
            <AuthEditor auth={draft.auth} onChange={(auth) => patch({ auth })} />
          </section>
        </>
      )}
      <p className="text-[11px] text-muted">
        {'{{variables}}'} resolve from the active environment and {'${NAME}'} or {'${NAME:-default}'} from Quiver's environment when connecting. Quiver announces the project folder as the root.
      </p>
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
