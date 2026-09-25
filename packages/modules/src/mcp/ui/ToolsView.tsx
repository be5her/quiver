import { skeletonFromSchema, toErrorPayload, type McpServerSummary, type McpTool, type McpToolCallOutcome } from '@quiver/core';
import { Badge, Button, CodeEditor, EmptyState, Input, Spinner, cn, invoke, notify } from '@quiver/ui';
import { Copy, Play, RefreshCw } from 'lucide-react';
import { useMemo, useState } from 'react';
import { ContentBlocks, TextBlock } from './content';
import { useServerQuery } from './hooks';

type CallState = { at: string; outcome: McpToolCallOutcome | null; error: string | null };

export function ToolsView({ server }: { server: McpServerSummary }) {
  const tools = useServerQuery<McpTool[]>('mcp.tool.list', { id: server.id }, server, ['lists', 'status']);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [argsByTool, setArgsByTool] = useState<Record<string, string>>({});
  const [calls, setCalls] = useState<Record<string, CallState>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const list = tools.data ?? [];
  const needle = filter.trim().toLowerCase();
  const filtered = needle ? list.filter((t) => `${t.name} ${t.title ?? ''} ${t.description ?? ''}`.toLowerCase().includes(needle)) : list;
  const selected = list.find((t) => t.name === selectedName) ?? null;

  const refresh = async () => {
    try {
      await invoke('mcp.tool.list', { id: server.id, refresh: true });
      await tools.refresh();
    } catch (err) {
      notify(toErrorPayload(err).message, 'error');
    }
  };

  const call = async (tool: McpTool, argsText: string) => {
    let args: Record<string, unknown>;
    try {
      const parsed: unknown = argsText.trim() ? JSON.parse(argsText) : {};
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Arguments must be a JSON object');
      args = parsed as Record<string, unknown>;
    } catch (err) {
      notify(`Arguments: ${(err as Error).message}`, 'error');
      return;
    }
    setBusy(tool.name);
    try {
      const outcome = await invoke<McpToolCallOutcome>('mcp.tool.call', { id: server.id, name: tool.name, arguments: args });
      setCalls((c) => ({ ...c, [tool.name]: { at: new Date().toISOString(), outcome, error: null } }));
    } catch (err) {
      setCalls((c) => ({ ...c, [tool.name]: { at: new Date().toISOString(), outcome: null, error: toErrorPayload(err).message } }));
    } finally {
      setBusy(null);
    }
  };

  if (server.status !== 'connected') return <EmptyState title="Not connected" hint="Connect to list the tools of this server." />;

  return (
    <div className="flex h-full min-h-0">
      <div className="w-64 border-r border-edge flex flex-col min-h-0 shrink-0">
        <div className="flex items-center gap-1 px-2 h-9 border-b border-edge shrink-0">
          <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter tools" className="h-7 text-xs" />
          <Button size="sm" variant="ghost" icon={<RefreshCw className="size-3.5" />} onClick={() => void refresh()} title="Ask the server for its tool list again" />
        </div>
        <div className="flex-1 overflow-y-auto">
          {tools.loading && !tools.data && (
            <div className="px-3 py-2">
              <Spinner />
            </div>
          )}
          {filtered.map((tool) => (
            <button
              key={tool.name}
              type="button"
              onClick={() => setSelectedName(tool.name)}
              className={cn('w-full text-left px-3 py-1.5 border-b border-edge/60 hover:bg-elevated flex flex-col gap-0.5 min-w-0', tool.name === selectedName && 'bg-elevated')}
              data-testid="mcp-tool"
            >
              <span className="flex items-center gap-1.5 min-w-0">
                <span className="font-mono text-xs truncate flex-1">{tool.name}</span>
                {tool.annotations?.readOnlyHint && <span className="size-1.5 rounded-full bg-success shrink-0" title="read-only" />}
                {tool.annotations?.destructiveHint && <span className="size-1.5 rounded-full bg-danger shrink-0" title="destructive" />}
              </span>
              {(tool.title || tool.description) && <span className="text-[11px] text-muted truncate">{tool.title ?? tool.description}</span>}
            </button>
          ))}
          {tools.data && list.length === 0 && <p className="px-3 py-3 text-xs text-muted">This server has no tools.</p>}
          {list.length > 0 && filtered.length === 0 && <p className="px-3 py-3 text-xs text-muted">No tool matches the filter.</p>}
        </div>
      </div>
      <div className="flex-1 min-w-0 min-h-0">
        {selected ? (
          <ToolDetail
            key={selected.name}
            tool={selected}
            argsText={argsByTool[selected.name] ?? JSON.stringify(skeletonFromSchema(selected.inputSchema) ?? {}, null, 2)}
            onArgsChange={(text) => setArgsByTool((a) => ({ ...a, [selected.name]: text }))}
            state={calls[selected.name] ?? null}
            busy={busy === selected.name}
            onCall={(text) => void call(selected, text)}
          />
        ) : (
          <EmptyState title="Pick a tool" hint="Tools show their description and input schema; arguments are prefilled from the schema." />
        )}
      </div>
    </div>
  );
}

function ToolDetail({
  tool,
  argsText,
  onArgsChange,
  state,
  busy,
  onCall,
}: {
  tool: McpTool;
  argsText: string;
  onArgsChange(text: string): void;
  state: CallState | null;
  busy: boolean;
  onCall(argsText: string): void;
}) {
  const [showSchema, setShowSchema] = useState(false);
  const annotations = useMemo(() => {
    const a = tool.annotations ?? {};
    return [a.readOnlyHint && 'read-only', a.destructiveHint && 'destructive', a.idempotentHint && 'idempotent', a.openWorldHint && 'open world'].filter((x): x is string => Boolean(x));
  }, [tool.annotations]);
  const hasArgs = Object.keys(tool.inputSchema.properties ?? {}).length > 0;

  return (
    <div className="flex flex-col h-full min-h-0" data-testid="mcp-tool-detail">
      <div className="flex flex-col gap-1 px-3 py-2 border-b border-edge shrink-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-mono text-sm font-medium">{tool.name}</span>
          {tool.title && <span className="text-xs text-muted">{tool.title}</span>}
          {annotations.map((a) => (
            <Badge key={a} className={cn(a === 'destructive' && 'text-danger', a === 'read-only' && 'text-success')}>
              {a}
            </Badge>
          ))}
          <div className="flex-1" />
          <Button size="sm" variant={showSchema ? 'secondary' : 'ghost'} onClick={() => setShowSchema((s) => !s)}>
            Schema
          </Button>
        </div>
        {tool.description && <p className="text-xs text-muted whitespace-pre-wrap">{tool.description}</p>}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-3 p-3">
        {showSchema && (
          <section className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-muted">Input schema</span>
            <div className="border border-edge rounded-md">
              <TextBlock text={JSON.stringify(tool.inputSchema, null, 2)} mime="application/json" />
            </div>
            {tool.outputSchema && (
              <>
                <span className="text-[11px] font-medium text-muted mt-1">Output schema</span>
                <div className="border border-edge rounded-md">
                  <TextBlock text={JSON.stringify(tool.outputSchema, null, 2)} mime="application/json" />
                </div>
              </>
            )}
          </section>
        )}
        <section className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-medium text-muted">Arguments (JSON)</span>
            <div className="flex-1" />
            <Button size="sm" variant="primary" icon={<Play className="size-3.5" />} loading={busy} onClick={() => onCall(argsText)} title="Ctrl+Enter" data-testid="mcp-tool-call">
              Call
            </Button>
          </div>
          <div className={cn('border border-edge rounded-md', hasArgs ? 'h-36' : 'h-16')} data-testid="mcp-tool-args">
            <CodeEditor value={argsText} onChange={onArgsChange} language="json" fill onRun={() => onCall(argsText)} placeholder="{}" />
          </div>
        </section>
        {state && (
          <section className="flex flex-col gap-1" data-testid="mcp-tool-result">
            <div className="flex items-center gap-2 text-[11px] text-muted">
              <span className="font-medium">Result</span>
              {state.outcome && <span>{formatMs(state.outcome.durationMs)}</span>}
              {state.outcome?.result.isError && <Badge className="text-danger">isError</Badge>}
              {state.outcome?.result.structuredContent && <Badge>structured</Badge>}
              <span>{new Date(state.at).toLocaleTimeString()}</span>
              <div className="flex-1" />
              {state.outcome && (
                <Button size="sm" variant="ghost" icon={<Copy className="size-3.5" />} onClick={() => void navigator.clipboard.writeText(JSON.stringify(state.outcome!.result, null, 2)).then(() => notify('Copied', 'success'))}>
                  Copy
                </Button>
              )}
            </div>
            {state.error && <p className="text-xs text-danger whitespace-pre-wrap rounded-md border border-danger/40 bg-danger/5 px-2 py-1.5">{state.error}</p>}
            {state.outcome && (
              <div className={cn('rounded-md border p-2 flex flex-col gap-2', state.outcome.result.isError ? 'border-danger/40 bg-danger/5' : 'border-edge')}>
                <ContentBlocks content={state.outcome.result.content} />
                {state.outcome.result.structuredContent && (
                  <div className="flex flex-col gap-1">
                    <span className="text-[11px] font-medium text-muted">structuredContent</span>
                    <TextBlock text={JSON.stringify(state.outcome.result.structuredContent, null, 2)} mime="application/json" />
                  </div>
                )}
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

export function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`;
}
