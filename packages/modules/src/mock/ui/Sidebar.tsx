import { describeRoute, type MockRoute, type MockServerSummary } from '@quiver/core';
import { Button, IconButton, METHOD_COLORS, SectionHeader, Spinner, cn, notify, useInvoke } from '@quiver/ui';
import { ChevronDown, ChevronRight, Inbox, Pencil, Play, Plus, Square, Trash2, Webhook } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useExpanded } from '../../db/ui/tree-store';
import { createServer, deleteServer, openServerTab, toggleServer } from './index';

export function MockSidebar() {
  const servers = useInvoke<MockServerSummary[]>('mock.server.list', {}, { refreshOn: ['mock-servers'], refreshOnEvents: ['mock.changed'] });

  return (
    <div className="flex flex-col h-full min-h-0 overflow-y-auto text-sm">
      <SectionHeader title="Servers" actions={<NewServerMenu />} />
      {servers.loading && !servers.data && (
        <div className="px-3 py-2">
          <Spinner />
        </div>
      )}
      {(servers.data ?? []).map((server) => (
        <ServerNode key={server.id} server={server} />
      ))}
      {servers.data?.length === 0 && (
        <div className="px-3 py-2 flex flex-col gap-2">
          <p className="text-xs text-muted">Local HTTP servers that answer with canned responses or capture whatever they receive. Requests, routes and settings are saved with the project.</p>
          <div className="flex gap-1">
            <Button size="sm" variant="secondary" icon={<Plus className="size-3.5" />} onClick={() => void createServer('mock')}>
              Mock server
            </Button>
            <Button size="sm" variant="secondary" icon={<Webhook className="size-3.5" />} onClick={() => void createServer('webhook')}>
              Webhook receiver
            </Button>
          </div>
        </div>
      )}
      {servers.error && <p className="px-3 py-2 text-xs text-danger">{servers.error.message}</p>}
    </div>
  );
}

function NewServerMenu() {
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
  const pick = (kind: 'mock' | 'webhook') => {
    setOpen(false);
    void createServer(kind);
  };
  return (
    <div ref={ref} className="relative">
      <IconButton label="New server" size="sm" onClick={() => setOpen((o) => !o)}>
        <Plus className="size-3.5" />
      </IconButton>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-20 min-w-44 rounded-md border border-edge bg-elevated shadow-lg py-1 normal-case tracking-normal font-normal">
          <button type="button" className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-fg hover:bg-surface" onClick={() => pick('mock')}>
            <Play className="size-3.5 text-muted" /> Mock API server
          </button>
          <button type="button" className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-fg hover:bg-surface" onClick={() => pick('webhook')}>
            <Webhook className="size-3.5 text-muted" /> Webhook receiver
          </button>
        </div>
      )}
    </div>
  );
}

function ServerNode({ server }: { server: MockServerSummary }) {
  const [open, toggle] = useExpanded(`mock/${server.id}`);
  const dot = server.running ? 'bg-success' : server.error ? 'bg-danger' : 'bg-muted/50';
  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        onClick={() => openServerTab(server)}
        onKeyDown={(e) => e.key === 'Enter' && openServerTab(server)}
        className="group flex items-center gap-1.5 pr-1 h-7 cursor-pointer hover:bg-elevated min-w-0 pl-2"
        title={server.error ?? (server.running ? `Listening on ${server.url}` : `Stopped, port ${server.port}`)}
        data-testid="mock-server"
        data-running={server.running ? 'true' : 'false'}
      >
        <button
          type="button"
          className="text-muted hover:text-fg shrink-0"
          onClick={(e) => {
            e.stopPropagation();
            toggle();
          }}
          aria-label={open ? 'Collapse' : 'Expand'}
        >
          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </button>
        <span className={cn('size-2 rounded-full shrink-0', dot)} aria-label={server.running ? 'running' : 'stopped'} />
        <span className="truncate flex-1 text-[13px] font-medium">{server.name}</span>
        <span className="text-[10px] font-mono text-muted shrink-0 group-hover:hidden">:{server.port}</span>
        {server.requestCount > 0 && (
          <span className="text-[10px] rounded-full bg-elevated px-1.5 text-muted shrink-0 group-hover:hidden" title={`${server.requestCount} captured requests`}>
            {server.requestCount}
          </span>
        )}
        <span className="hidden group-hover:flex items-center">
          <IconButton label={server.running ? 'Stop' : 'Start'} size="sm" onClick={(e) => stop(e, () => toggleServer(server))}>
            {server.running ? <Square className="size-3" /> : <Play className="size-3.5" />}
          </IconButton>
          <IconButton label="Edit routes" size="sm" onClick={(e) => stop(e, () => openServerTab(server, 'routes'))}>
            <Pencil className="size-3.5" />
          </IconButton>
          <IconButton label="Delete server" size="sm" onClick={(e) => stop(e, () => deleteServer(server))}>
            <Trash2 className="size-3.5" />
          </IconButton>
        </span>
      </div>
      {open && (
        <>
          {server.routes.map((route) => (
            <RouteRow key={route.id} server={server} route={route} />
          ))}
          {server.routes.length === 0 && (
            <p className="text-[11px] text-muted py-1" style={{ paddingLeft: 26 }}>
              No routes: every request gets the fallback answer.
            </p>
          )}
          <div
            role="button"
            tabIndex={0}
            onClick={() => openServerTab(server, 'requests')}
            onKeyDown={(e) => e.key === 'Enter' && openServerTab(server, 'requests')}
            className="flex items-center gap-1.5 pr-1 h-7 cursor-pointer hover:bg-elevated min-w-0"
            style={{ paddingLeft: 26 }}
          >
            <Inbox className="size-3.5 text-muted shrink-0" />
            <span className="truncate flex-1 text-[12px]">Requests</span>
            <span className="text-[10px] text-muted shrink-0">{server.requestCount}</span>
          </div>
        </>
      )}
    </div>
  );
}

function RouteRow({ server, route }: { server: MockServerSummary; route: MockRoute }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => openServerTab(server, 'routes', route.id)}
      onKeyDown={(e) => e.key === 'Enter' && openServerTab(server, 'routes', route.id)}
      className={cn('flex items-center gap-1.5 pr-1 h-7 cursor-pointer hover:bg-elevated min-w-0', !route.enabled && 'opacity-50')}
      style={{ paddingLeft: 26 }}
      title={`${describeRoute(route)} → ${route.status}${route.description ? `\n${route.description}` : ''}`}
      data-testid="mock-route"
    >
      <span className={cn('text-[10px] font-semibold w-11 shrink-0', METHOD_COLORS[route.method] ?? 'text-muted')}>{route.method}</span>
      <span className="truncate flex-1 text-[12px] font-mono">{route.path || '/'}</span>
      <span className="text-[10px] text-muted shrink-0">{route.status}</span>
    </div>
  );
}

function stop(e: React.MouseEvent, fn: () => unknown) {
  e.stopPropagation();
  void Promise.resolve(fn()).catch((err) => notify((err as Error).message, 'error'));
}
