import { describeConnection, type RealtimeConnectionSummary } from '@quiver/core';
import { Button, IconButton, SectionHeader, Spinner, cn, useInvoke } from '@quiver/ui';
import { Cable, Plug, Plus, Rss, Trash2, Unplug } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createConnection, deleteConnection, openConnectionTab, toggleConnection } from './index';

export function statusDot(status: RealtimeConnectionSummary['status'], error: string | null): string {
  if (status === 'open') return 'bg-success';
  if (status === 'connecting' || status === 'reconnecting') return 'bg-warning animate-pulse';
  return error ? 'bg-danger' : 'bg-muted/50';
}

export function RealtimeSidebar() {
  const connections = useInvoke<RealtimeConnectionSummary[]>('realtime.connection.list', {}, { refreshOn: ['realtime-connections'], refreshOnEvents: ['realtime.changed'] });

  return (
    <div className="flex flex-col h-full min-h-0 overflow-y-auto text-sm">
      <SectionHeader title="Connections" actions={<NewConnectionMenu />} />
      {connections.loading && !connections.data && (
        <div className="px-3 py-2">
          <Spinner />
        </div>
      )}
      {(connections.data ?? []).map((conn) => (
        <ConnectionRow key={conn.id} conn={conn} />
      ))}
      {connections.data?.length === 0 && (
        <div className="px-3 py-2 flex flex-col gap-2">
          <p className="text-xs text-muted">WebSocket and Server-Sent Events connections saved with the project. Messages are logged live and agents can wait for the next one.</p>
          <div className="flex gap-1">
            <Button size="sm" variant="secondary" icon={<Cable className="size-3.5" />} onClick={() => void createConnection('websocket')}>
              WebSocket
            </Button>
            <Button size="sm" variant="secondary" icon={<Rss className="size-3.5" />} onClick={() => void createConnection('sse')}>
              Event stream
            </Button>
          </div>
        </div>
      )}
      {connections.error && <p className="px-3 py-2 text-xs text-danger">{connections.error.message}</p>}
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
  const pick = (kind: 'websocket' | 'sse') => {
    setOpen(false);
    void createConnection(kind);
  };
  return (
    <div ref={ref} className="relative">
      <IconButton label="New connection" size="sm" onClick={() => setOpen((o) => !o)}>
        <Plus className="size-3.5" />
      </IconButton>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-20 min-w-44 rounded-md border border-edge bg-elevated shadow-lg py-1 normal-case tracking-normal font-normal">
          <button type="button" className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-fg hover:bg-surface" onClick={() => pick('websocket')}>
            <Cable className="size-3.5 text-muted" /> WebSocket
          </button>
          <button type="button" className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-fg hover:bg-surface" onClick={() => pick('sse')}>
            <Rss className="size-3.5 text-muted" /> Event stream (SSE)
          </button>
        </div>
      )}
    </div>
  );
}

function ConnectionRow({ conn }: { conn: RealtimeConnectionSummary }) {
  const open = conn.status !== 'disconnected';
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => openConnectionTab(conn)}
      onKeyDown={(e) => e.key === 'Enter' && openConnectionTab(conn)}
      className="group flex items-center gap-1.5 pl-3 pr-1 h-7 cursor-pointer hover:bg-elevated min-w-0"
      title={conn.error ?? `${describeConnection(conn)} · ${conn.status}`}
      data-testid="realtime-connection"
      data-status={conn.status}
    >
      <span className={cn('size-2 rounded-full shrink-0', statusDot(conn.status, conn.error))} aria-label={conn.status} />
      <span className={cn('text-[9px] font-bold w-7 shrink-0', conn.kind === 'sse' ? 'text-violet-600 dark:text-violet-400' : 'text-sky-600 dark:text-sky-400')}>{conn.kind === 'sse' ? 'SSE' : 'WS'}</span>
      <span className="truncate flex-1 text-[13px]">{conn.name}</span>
      {conn.messageCount > 0 && (
        <span className="text-[10px] rounded-full bg-elevated px-1.5 text-muted shrink-0 group-hover:hidden" title={`${conn.messageCount} messages`}>
          {conn.messageCount}
        </span>
      )}
      <span className="hidden group-hover:flex items-center">
        <IconButton label={open ? 'Disconnect' : 'Connect'} size="sm" onClick={(e) => stop(e, () => toggleConnection(conn))}>
          {open ? <Unplug className="size-3.5" /> : <Plug className="size-3.5" />}
        </IconButton>
        <IconButton label="Delete connection" size="sm" onClick={(e) => stop(e, () => deleteConnection(conn))}>
          <Trash2 className="size-3.5" />
        </IconButton>
      </span>
    </div>
  );
}

function stop(e: React.MouseEvent, fn: () => unknown) {
  e.stopPropagation();
  void fn();
}
