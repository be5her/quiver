import { describeMcpServer, transportLabel, type McpConfigFile, type McpServerSummary, type McpTransport } from '@quiver/core';
import { Button, IconButton, SectionHeader, Spinner, cn, useInvoke } from '@quiver/ui';
import { Download, FileJson, Globe, Plug, Plus, Radio, Terminal, Trash2, Unplug } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { addThisQuiver, createServer, deleteServer, importServers, openServerTab, toggleServer } from './index';

export function statusDot(status: McpServerSummary['status'], error: string | null): string {
  if (status === 'connected') return 'bg-success';
  if (status === 'connecting') return 'bg-warning animate-pulse';
  return error ? 'bg-danger' : 'bg-muted/50';
}

export const TRANSPORT_COLOR: Record<McpTransport, string> = {
  stdio: 'text-emerald-600 dark:text-emerald-400',
  http: 'text-sky-600 dark:text-sky-400',
  sse: 'text-violet-600 dark:text-violet-400',
};

export function McpSidebar() {
  const servers = useInvoke<McpServerSummary[]>('mcp.server.list', {}, { refreshOn: ['mcp-servers'], refreshOnEvents: ['mcp.changed'] });
  const discovered = useInvoke<McpConfigFile[]>('mcp.server.discover', {}, { refreshOn: ['mcp-servers'] });
  const pending = (discovered.data ?? []).filter((f) => f.error || f.servers.some((s) => !s.imported));

  return (
    <div className="flex flex-col h-full min-h-0 overflow-y-auto text-sm">
      <SectionHeader title="Servers" actions={<NewServerMenu />} />
      {servers.loading && !servers.data && (
        <div className="px-3 py-2">
          <Spinner />
        </div>
      )}
      {(servers.data ?? []).map((server) => (
        <ServerRow key={server.id} server={server} />
      ))}
      {servers.data?.length === 0 && (
        <div className="px-3 py-2 flex flex-col gap-2">
          <p className="text-xs text-muted">Connect to MCP servers, browse their tools, resources and prompts, call them and watch the JSON-RPC traffic.</p>
          <div className="flex gap-1 flex-wrap">
            <Button size="sm" variant="secondary" icon={<Terminal className="size-3.5" />} onClick={() => void createServer('stdio')}>
              Command
            </Button>
            <Button size="sm" variant="secondary" icon={<Globe className="size-3.5" />} onClick={() => void createServer('http')}>
              HTTP
            </Button>
            <Button size="sm" variant="secondary" icon={<Radio className="size-3.5" />} onClick={() => void addThisQuiver()} title="Add Quiver's own MCP server for this workspace">
              This Quiver
            </Button>
          </div>
        </div>
      )}
      {servers.error && <p className="px-3 py-2 text-xs text-danger">{servers.error.message}</p>}
      {pending.length > 0 && (
        <>
          <SectionHeader title="Found in project" />
          {pending.map((file) => (
            <ConfigFileRow key={file.file} file={file} />
          ))}
        </>
      )}
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
  const pick = (fn: () => Promise<void>) => {
    setOpen(false);
    void fn();
  };
  const item = 'w-full flex items-center gap-2 px-3 py-1.5 text-xs text-fg hover:bg-surface';
  return (
    <div ref={ref} className="relative">
      <IconButton label="New server" size="sm" onClick={() => setOpen((o) => !o)}>
        <Plus className="size-3.5" />
      </IconButton>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-20 min-w-52 rounded-md border border-edge bg-elevated shadow-lg py-1 normal-case tracking-normal font-normal">
          <button type="button" className={item} onClick={() => pick(() => createServer('stdio'))}>
            <Terminal className="size-3.5 text-muted" /> Command (stdio)
          </button>
          <button type="button" className={item} onClick={() => pick(() => createServer('http'))}>
            <Globe className="size-3.5 text-muted" /> Streamable HTTP
          </button>
          <button type="button" className={item} onClick={() => pick(() => createServer('sse'))}>
            <Radio className="size-3.5 text-muted" /> SSE (legacy)
          </button>
          <div className="border-t border-edge my-1" />
          <button type="button" className={item} onClick={() => pick(() => importServers())}>
            <FileJson className="size-3.5 text-muted" /> Import from .mcp.json
          </button>
          <button type="button" className={item} onClick={() => pick(() => addThisQuiver())}>
            <Plug className="size-3.5 text-muted" /> This Quiver
          </button>
        </div>
      )}
    </div>
  );
}

function ServerRow({ server }: { server: McpServerSummary }) {
  const open = server.status !== 'disconnected';
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => openServerTab(server)}
      onKeyDown={(e) => e.key === 'Enter' && openServerTab(server)}
      className="group flex items-center gap-1.5 pl-3 pr-1 h-7 cursor-pointer hover:bg-elevated min-w-0"
      title={server.error ?? `${describeMcpServer(server)} · ${server.status}`}
      data-testid="mcp-server"
      data-status={server.status}
    >
      <span className={cn('size-2 rounded-full shrink-0', statusDot(server.status, server.error))} aria-label={server.status} />
      <span className={cn('text-[9px] font-bold w-8 shrink-0', TRANSPORT_COLOR[server.transport])}>{transportLabel(server.transport)}</span>
      <span className="truncate flex-1 text-[13px]">{server.name}</span>
      {server.status === 'connected' && (
        <span className="text-[10px] rounded-full bg-elevated px-1.5 text-muted shrink-0 group-hover:hidden" title={`${server.toolCount} tools, ${server.resourceCount} resources, ${server.promptCount} prompts`}>
          {server.toolCount}
        </span>
      )}
      <span className="hidden group-hover:flex items-center">
        <IconButton label={open ? 'Disconnect' : 'Connect'} size="sm" onClick={(e) => stop(e, () => toggleServer(server))}>
          {open ? <Unplug className="size-3.5" /> : <Plug className="size-3.5" />}
        </IconButton>
        <IconButton label="Delete server" size="sm" onClick={(e) => stop(e, () => deleteServer(server))}>
          <Trash2 className="size-3.5" />
        </IconButton>
      </span>
    </div>
  );
}

function ConfigFileRow({ file }: { file: McpConfigFile }) {
  const names = file.servers.filter((s) => !s.imported).map((s) => s.name);
  return (
    <div className="px-3 py-1.5 flex flex-col gap-1 min-w-0" data-testid="mcp-config-file">
      <div className="flex items-center gap-1.5 min-w-0">
        <FileJson className="size-3.5 text-muted shrink-0" />
        <span className="font-mono text-xs truncate flex-1" title={file.file}>
          {file.file}
        </span>
        {!file.error && (
          <Button size="sm" variant="ghost" icon={<Download className="size-3.5" />} onClick={() => void importServers(file.file)} data-testid="mcp-import" title={`Import ${names.join(', ')}`}>
            Import
          </Button>
        )}
      </div>
      {file.error ? <p className="text-[11px] text-danger truncate">{file.error}</p> : <p className="text-[11px] text-muted truncate">{names.join(', ')}</p>}
    </div>
  );
}

function stop(e: React.MouseEvent, fn: () => unknown) {
  e.stopPropagation();
  void fn();
}
