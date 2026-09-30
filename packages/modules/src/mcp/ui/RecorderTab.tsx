import { mcpAgentLabel, type McpRecordedCall, type McpRecordedCallSummary, type McpRecordingStatus } from '@quiver/core';
import { Badge, Button, Checkbox, CodeEditor, EmptyState, IconButton, Input, Select, Spinner, cn, formatBytes, formatMs, notify, useAppStore, useInvoke, type TabProps } from '@quiver/ui';
import { ArrowDownToLine, Circle, Download, Pause, Play, Square, Trash2, TriangleAlert } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { discardRecording, endRecording, pauseRecording, resumeRecording, saveRecording, startRecording } from './recording';

const IDLE: McpRecordingStatus = { state: 'idle', startedAt: null, endedAt: null, limitReached: false, count: 0, bytes: 0, savedTo: null };

const STATE_LABEL: Record<McpRecordingStatus['state'], string> = { idle: 'Not recording', recording: 'Recording', paused: 'Paused', ended: 'Ended' };

export function recordingDot(state: McpRecordingStatus['state']): string {
  if (state === 'recording') return 'bg-danger animate-pulse';
  if (state === 'paused') return 'bg-warning';
  return 'bg-muted/50';
}

const AGENT_COLORS = ['text-sky-600 dark:text-sky-400', 'text-violet-600 dark:text-violet-400', 'text-amber-600 dark:text-amber-400', 'text-emerald-600 dark:text-emerald-400', 'text-rose-600 dark:text-rose-400'];

/** The same agent gets the same colour in every row, so two agents working at once are easy to tell apart. */
function agentColor(name: string): string {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return AGENT_COLORS[hash % AGENT_COLORS.length];
}

const time = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString() : '');

/** Every tool call agents make to Quiver's own MCP server between start and end, kept in memory until it is saved to a file. */
export function RecorderTab(_props: TabProps) {
  const recording = useInvoke<{ status: McpRecordingStatus; calls: McpRecordedCallSummary[] }>('mcp.recording.list', {}, { workspaceId: null, refreshOnEvents: ['mcp.recording'] });
  const server = useAppStore((s) => s.mcpStatus);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [agent, setAgent] = useState('');
  const [failedOnly, setFailedOnly] = useState(false);
  const [follow, setFollow] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);

  const status = recording.data?.status ?? IDLE;
  const calls = recording.data?.calls ?? [];
  const agents = useMemo(() => [...new Set(calls.map((c) => c.agent.name))].sort(), [calls]);
  const needle = filter.trim().toLowerCase();
  const filtered = useMemo(
    () => calls.filter((c) => (!agent || c.agent.name === agent) && (!failedOnly || c.ok === false) && (!needle || `${c.tool} ${mcpAgentLabel(c.agent)} ${c.workspace?.name ?? ''} ${c.preview}`.toLowerCase().includes(needle))),
    [calls, agent, failedOnly, needle],
  );
  const selected = calls.find((c) => c.id === selectedId) ?? null;
  const toggle = useCallback((id: string) => setSelectedId((current) => (current === id ? null : id)), []);
  const active = status.state === 'recording' || status.state === 'paused';

  useEffect(() => {
    if (follow && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [calls.length, follow]);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (atBottom !== follow) setFollow(atBottom);
  };

  return (
    <div className="flex flex-col h-full min-h-0" data-testid="mcp-recorder" data-state={status.state}>
      <div className="flex items-center gap-2 px-3 h-10 border-b border-edge shrink-0">
        <span className={cn('size-2 rounded-full shrink-0', recordingDot(status.state))} />
        <span className="text-sm font-medium shrink-0">{STATE_LABEL[status.state]}</span>
        {status.state !== 'idle' && (
          <span className="text-xs text-muted truncate" data-testid="mcp-recorder-summary">
            {status.count} call{status.count === 1 ? '' : 's'} · {formatBytes(status.bytes)} · {time(status.startedAt)}
            {status.endedAt && ` – ${time(status.endedAt)}`}
            {status.savedTo && <span title={status.savedTo}> · saved to {status.savedTo}</span>}
          </span>
        )}
        <div className="flex-1" />
        {status.state === 'idle' && (
          <Button size="sm" variant="primary" icon={<Circle className="size-3 fill-current" />} onClick={() => void startRecording()} data-testid="mcp-recorder-start">
            Start recording
          </Button>
        )}
        {status.state === 'recording' && (
          <Button size="sm" icon={<Pause className="size-3.5" />} onClick={() => void pauseRecording()} data-testid="mcp-recorder-pause">
            Pause
          </Button>
        )}
        {status.state === 'paused' && (
          <Button size="sm" icon={<Play className="size-3.5" />} onClick={() => void resumeRecording()} data-testid="mcp-recorder-resume">
            Resume
          </Button>
        )}
        {active && (
          <Button size="sm" icon={<Square className="size-3 fill-current" />} onClick={() => void endRecording()} data-testid="mcp-recorder-end">
            End
          </Button>
        )}
        {status.state === 'ended' && (
          <>
            <Button size="sm" variant="primary" icon={<Download className="size-3.5" />} disabled={status.count === 0} onClick={() => void saveRecording()} data-testid="mcp-recorder-save">
              Save as…
            </Button>
            <Button size="sm" icon={<Circle className="size-3 fill-current" />} onClick={() => void startRecording()} data-testid="mcp-recorder-start">
              New recording
            </Button>
            <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => void discardRecording(status)} data-testid="mcp-recorder-discard">
              Discard
            </Button>
          </>
        )}
      </div>
      {status.limitReached && (
        <Notice>The recording reached its size limit and ended itself. Save it, then start a new one to keep going.</Notice>
      )}
      {active && server && !server.running && <Notice>Quiver's MCP server is off, so no call can arrive. Turn it on in Settings.</Notice>}
      {calls.length === 0 ? (
        <Empty status={status} port={server?.port} />
      ) : (
        <div className="flex flex-1 min-h-0">
          <div className="flex-1 min-w-0 flex flex-col min-h-0">
            <div className="flex items-center gap-2 px-2 h-9 border-b border-edge shrink-0">
              <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by tool, agent or arguments" className="h-7 text-xs" data-testid="mcp-recorder-filter" />
              {agents.length > 1 && (
                <Select value={agent} onChange={(e) => setAgent(e.target.value)} className="h-7 text-xs w-40" title="Agent">
                  <option value="">All agents</option>
                  {agents.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </Select>
              )}
              <label className="flex items-center gap-1.5 text-xs text-muted shrink-0">
                <Checkbox checked={failedOnly} onChange={(e) => setFailedOnly(e.target.checked)} />
                Failed only
              </label>
              {!follow && (
                <IconButton label="Jump to latest" size="sm" onClick={() => setFollow(true)}>
                  <ArrowDownToLine className="size-3.5" />
                </IconButton>
              )}
            </div>
            <div ref={listRef} onScroll={onScroll} className="flex-1 overflow-y-auto" data-testid="mcp-recorder-list">
              {filtered.map((c) => (
                <CallRow key={c.id} call={c} selected={c.id === selectedId} onToggle={toggle} />
              ))}
              {filtered.length === 0 && <p className="px-3 py-3 text-xs text-muted">No call matches the filter.</p>}
            </div>
          </div>
          {selected && (
            <div className="w-[30rem] max-w-[55%] border-l border-edge flex flex-col min-h-0 shrink-0">
              <CallDetail key={selected.id} summary={selected} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 border-b border-edge text-xs text-warning shrink-0" data-testid="mcp-recorder-notice">
      <TriangleAlert className="size-3.5 shrink-0" />
      {children}
    </div>
  );
}

function Empty({ status, port }: { status: McpRecordingStatus; port: number | undefined }) {
  if (status.state === 'idle')
    return (
      <EmptyState
        title="Record what agents call"
        hint="Start a recording, then let an agent work. Every tool call that reaches Quiver's MCP server is listed with the agent that made it, its arguments and its result. The recording stays in memory until you end it and save it to a file."
        action={
          <Button variant="primary" icon={<Circle className="size-3 fill-current" />} onClick={() => void startRecording()}>
            Start recording
          </Button>
        }
      />
    );
  if (status.state === 'ended') return <EmptyState title="No call was recorded" hint="No agent called Quiver while this recording ran." />;
  return (
    <EmptyState
      title={status.state === 'paused' ? 'Paused' : 'Waiting for calls…'}
      hint={status.state === 'paused' ? 'Calls that arrive now are not kept. Resume to go on.' : `Agents reach Quiver at http://127.0.0.1:${port ?? 7411}/mcp. Their calls show up here as they arrive.`}
    />
  );
}

function Outcome({ ok }: { ok: boolean | null }) {
  if (ok === null) return <Spinner className="size-3" />;
  return <Badge className={cn('shrink-0', ok ? 'text-success' : 'text-danger')}>{ok ? 'ok' : 'failed'}</Badge>;
}

interface CallRowProps {
  call: McpRecordedCallSummary;
  selected: boolean;
  onToggle(id: string): void;
}

/** The list is fetched anew on every change, so a row re-renders only when its own call moved on. */
const CallRow = memo(CallRowView, (a, b) => a.selected === b.selected && a.onToggle === b.onToggle && a.call.id === b.call.id && a.call.ok === b.call.ok && a.call.size === b.call.size);

function CallRowView({ call, selected, onToggle }: CallRowProps) {
  return (
    <button
      type="button"
      onClick={() => onToggle(call.id)}
      className={cn('w-full text-left px-2 py-1 border-b border-edge/60 hover:bg-elevated flex items-center gap-2 min-w-0', selected && 'bg-elevated')}
      data-testid="mcp-recorded-call"
      data-tool={call.tool}
      data-agent={call.agent.name}
      data-ok={String(call.ok)}
    >
      <span className="text-[10px] text-muted shrink-0 w-16 whitespace-nowrap">{time(call.at)}</span>
      <span className={cn('text-[11px] font-medium shrink-0 w-28 truncate', agentColor(call.agent.name))} title={call.agent.userAgent ?? mcpAgentLabel(call.agent)}>
        {call.agent.name}
      </span>
      <span className="font-mono text-xs shrink-0 max-w-56 truncate">{call.tool}</span>
      <span className="truncate flex-1 text-xs font-mono text-muted">{call.preview === '{}' ? '' : call.preview}</span>
      <span className="w-12 shrink-0 flex justify-end">
        <Outcome ok={call.ok} />
      </span>
      <span className="text-[10px] text-muted shrink-0 w-14 text-right">{call.durationMs === null ? '' : formatMs(call.durationMs)}</span>
      <span className="text-[10px] text-muted shrink-0 w-14 text-right">{formatBytes(call.size)}</span>
    </button>
  );
}

const pretty = (value: unknown): string => (typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? ''));

function CallDetail({ summary }: { summary: McpRecordedCallSummary }) {
  const call = useInvoke<McpRecordedCall>('mcp.recording.get', { id: summary.id }, { workspaceId: null });
  const { refresh } = call;
  // The summary says when a running call has answered; fetch its result then.
  const answered = summary.ok !== null;
  const wasAnswered = useRef(answered);
  useEffect(() => {
    if (answered && !wasAnswered.current) void refresh();
    wasAnswered.current = answered;
  }, [answered, refresh]);

  const args = call.data ? pretty(call.data.arguments) : '';
  const result = call.data && call.data.ok !== null ? pretty(call.data.result) : '';
  const copy = (text: string) => navigator.clipboard.writeText(text).then(() => notify('Copied', 'success'));
  const heading = 'flex items-center justify-between px-3 h-7 text-[11px] font-semibold uppercase tracking-wide text-muted shrink-0';

  return (
    <div className="flex flex-col h-full min-h-0" data-testid="mcp-recorder-detail">
      <div className="flex flex-col gap-1 px-3 py-2 border-b border-edge shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-mono text-sm truncate">{summary.tool}</span>
          <Outcome ok={summary.ok} />
        </div>
        <div className="flex items-center gap-x-2 gap-y-0.5 flex-wrap text-[11px] text-muted">
          <span className={cn('font-medium', agentColor(summary.agent.name))} title={summary.agent.userAgent ?? undefined}>
            {mcpAgentLabel(summary.agent)}
          </span>
          {summary.workspace && <span title={summary.workspace.path}>in {summary.workspace.name}</span>}
          <span>{new Date(summary.at).toLocaleString()}</span>
          {summary.durationMs !== null && <span>{formatMs(summary.durationMs)}</span>}
          <span>{formatBytes(summary.size)}</span>
        </div>
      </div>
      <div className={heading}>
        <span>Arguments</span>
        <Button size="sm" variant="ghost" onClick={() => void copy(args)} disabled={!call.data}>
          Copy
        </Button>
      </div>
      <div className="px-2 max-h-[35%] overflow-y-auto shrink-0" data-testid="mcp-recorder-arguments">
        <CodeEditor value={args} readOnly language="json" fill={false} wrap />
      </div>
      <div className={heading}>
        <span>Result</span>
        <Button size="sm" variant="ghost" onClick={() => void copy(result)} disabled={!answered}>
          Copy
        </Button>
      </div>
      <div className="flex-1 min-h-0 px-2 pb-2" data-testid="mcp-recorder-result">
        {call.error ? (
          <p className="text-xs text-danger px-1">{call.error.message}</p>
        ) : answered ? (
          <CodeEditor value={result} readOnly language={typeof call.data?.result === 'string' ? 'text' : 'json'} wrap={typeof call.data?.result === 'string'} />
        ) : (
          <p className="text-xs text-muted px-1 flex items-center gap-2">
            <Spinner className="size-3" /> Still running…
          </p>
        )}
      </div>
    </div>
  );
}
