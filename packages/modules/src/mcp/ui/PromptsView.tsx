import { toErrorPayload, type McpPrompt, type McpPromptResult, type McpServerSummary } from '@quiver/core';
import { Badge, Button, EmptyState, Input, Label, Spinner, cn, invoke, notify } from '@quiver/ui';
import { MessageSquare, Play, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { ContentBlock } from './content';
import { useServerQuery } from './hooks';
import { formatMs } from './ToolsView';

type GetState = { result: (McpPromptResult & { durationMs: number }) | null; error: string | null };

export function PromptsView({ server }: { server: McpServerSummary }) {
  const prompts = useServerQuery<McpPrompt[]>('mcp.prompt.list', { id: server.id }, server, ['lists', 'status']);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const list = prompts.data ?? [];
  const needle = filter.trim().toLowerCase();
  const filtered = needle ? list.filter((p) => `${p.name} ${p.title ?? ''} ${p.description ?? ''}`.toLowerCase().includes(needle)) : list;
  const selected = list.find((p) => p.name === selectedName) ?? null;

  const refresh = async () => {
    try {
      await invoke('mcp.prompt.list', { id: server.id, refresh: true });
      await prompts.refresh();
    } catch (err) {
      notify(toErrorPayload(err).message, 'error');
    }
  };

  if (server.status !== 'connected') return <EmptyState title="Not connected" hint="Connect to list the prompts of this server." />;

  return (
    <div className="flex h-full min-h-0">
      <div className="w-64 border-r border-edge flex flex-col min-h-0 shrink-0">
        <div className="flex items-center gap-1 px-2 h-9 border-b border-edge shrink-0">
          <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter prompts" className="h-7 text-xs" />
          <Button size="sm" variant="ghost" icon={<RefreshCw className="size-3.5" />} onClick={() => void refresh()} title="Ask the server for its prompts again" />
        </div>
        <div className="flex-1 overflow-y-auto">
          {prompts.loading && !prompts.data && (
            <div className="px-3 py-2">
              <Spinner />
            </div>
          )}
          {filtered.map((p) => (
            <button
              key={p.name}
              type="button"
              onClick={() => setSelectedName(p.name)}
              className={cn('w-full text-left px-3 py-1.5 border-b border-edge/60 hover:bg-elevated flex items-start gap-2 min-w-0', p.name === selectedName && 'bg-elevated')}
              data-testid="mcp-prompt"
            >
              <MessageSquare className="size-3.5 text-muted shrink-0 mt-0.5" />
              <span className="flex flex-col min-w-0 flex-1">
                <span className="font-mono text-xs truncate">{p.name}</span>
                {(p.title || p.description) && <span className="text-[11px] text-muted truncate">{p.title ?? p.description}</span>}
              </span>
            </button>
          ))}
          {prompts.data && list.length === 0 && <p className="px-3 py-3 text-xs text-muted">This server has no prompts.</p>}
        </div>
      </div>
      <div className="flex-1 min-w-0 min-h-0 overflow-y-auto">
        {selected ? <PromptDetail key={selected.name} server={server} prompt={selected} /> : <EmptyState title="Pick a prompt" hint="Fill in its arguments and render it to see the messages an agent would receive." />}
      </div>
    </div>
  );
}

function PromptDetail({ server, prompt }: { server: McpServerSummary; prompt: McpPrompt }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [state, setState] = useState<GetState | null>(null);
  const [busy, setBusy] = useState(false);
  const args = prompt.arguments ?? [];

  const get = async () => {
    const missing = args.filter((a) => a.required && !(values[a.name] ?? '').trim()).map((a) => a.name);
    if (missing.length) {
      notify(`Required: ${missing.join(', ')}`, 'error');
      return;
    }
    setBusy(true);
    try {
      const filled = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== ''));
      const result = await invoke<McpPromptResult & { durationMs: number }>('mcp.prompt.get', { id: server.id, name: prompt.name, arguments: filled });
      setState({ result, error: null });
    } catch (err) {
      setState({ result: null, error: toErrorPayload(err).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-mono text-sm font-medium">{prompt.name}</span>
        {prompt.title && <span className="text-xs text-muted">{prompt.title}</span>}
        <div className="flex-1" />
        <Button size="sm" variant="primary" icon={<Play className="size-3.5" />} loading={busy} onClick={() => void get()} data-testid="mcp-prompt-get">
          Get prompt
        </Button>
      </div>
      {prompt.description && <p className="text-xs text-muted whitespace-pre-wrap">{prompt.description}</p>}
      {args.length > 0 && (
        <div className="grid grid-cols-2 gap-2 max-w-2xl">
          {args.map((a) => (
            <div key={a.name}>
              <Label>
                {a.name}
                {a.required ? ' *' : ''}
              </Label>
              <Input value={values[a.name] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [a.name]: e.target.value }))} placeholder={a.description} onKeyDown={(e) => e.key === 'Enter' && void get()} data-testid="mcp-prompt-argument" />
            </div>
          ))}
        </div>
      )}
      {state && (
        <div className="flex flex-col gap-2" data-testid="mcp-prompt-result">
          {state.error && <p className="text-xs text-danger whitespace-pre-wrap rounded-md border border-danger/40 bg-danger/5 px-2 py-1.5">{state.error}</p>}
          {state.result && (
            <>
              <span className="text-[11px] text-muted">
                {state.result.messages.length} message{state.result.messages.length === 1 ? '' : 's'} · {formatMs(state.result.durationMs)}
                {state.result.description ? ` · ${state.result.description}` : ''}
              </span>
              {state.result.messages.map((m, i) => (
                <div key={i} className="rounded-md border border-edge p-2 flex flex-col gap-1">
                  <Badge className={cn('self-start', m.role === 'user' ? 'text-sky-600 dark:text-sky-400' : 'text-violet-600 dark:text-violet-400')}>{m.role}</Badge>
                  <ContentBlock content={m.content} />
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
