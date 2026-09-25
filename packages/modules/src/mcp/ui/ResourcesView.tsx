import { expandUriTemplate, templateVariables, toErrorPayload, type McpReadResourceResult, type McpResource, type McpResourceTemplate, type McpServerSummary } from '@quiver/core';
import { Badge, Button, EmptyState, Input, Label, Spinner, cn, invoke, notify } from '@quiver/ui';
import { BookOpen, FileText, RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { ResourceContentsView } from './content';
import { useServerQuery } from './hooks';
import { formatMs } from './ToolsView';

type Lists = { resources: McpResource[]; templates: McpResourceTemplate[] };
type Selection = { kind: 'resource'; uri: string } | { kind: 'template'; uriTemplate: string };
type ReadState = { uri: string; result: (McpReadResourceResult & { durationMs: number }) | null; error: string | null };

export function ResourcesView({ server }: { server: McpServerSummary }) {
  const lists = useServerQuery<Lists>('mcp.resource.list', { id: server.id }, server, ['lists', 'status']);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [filter, setFilter] = useState('');
  const [read, setRead] = useState<ReadState | null>(null);
  const [busy, setBusy] = useState(false);

  const resources = lists.data?.resources ?? [];
  const templates = lists.data?.templates ?? [];
  const needle = filter.trim().toLowerCase();
  const match = (r: { name: string; title?: string; description?: string; uri?: string; uriTemplate?: string }) =>
    !needle || `${r.name} ${r.title ?? ''} ${r.description ?? ''} ${r.uri ?? r.uriTemplate ?? ''}`.toLowerCase().includes(needle);

  const refresh = async () => {
    try {
      await invoke('mcp.resource.list', { id: server.id, refresh: true });
      await lists.refresh();
    } catch (err) {
      notify(toErrorPayload(err).message, 'error');
    }
  };

  const readUri = async (uri: string) => {
    setBusy(true);
    try {
      const result = await invoke<McpReadResourceResult & { durationMs: number }>('mcp.resource.read', { id: server.id, uri });
      setRead({ uri, result, error: null });
    } catch (err) {
      setRead({ uri, result: null, error: toErrorPayload(err).message });
    } finally {
      setBusy(false);
    }
  };

  const selectedResource = selection?.kind === 'resource' ? (resources.find((r) => r.uri === selection.uri) ?? null) : null;
  const selectedTemplate = selection?.kind === 'template' ? (templates.find((t) => t.uriTemplate === selection.uriTemplate) ?? null) : null;

  useEffect(() => {
    if (selectedResource) void readUri(selectedResource.uri);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedResource?.uri]);

  if (server.status !== 'connected') return <EmptyState title="Not connected" hint="Connect to list the resources of this server." />;

  return (
    <div className="flex h-full min-h-0">
      <div className="w-72 border-r border-edge flex flex-col min-h-0 shrink-0">
        <div className="flex items-center gap-1 px-2 h-9 border-b border-edge shrink-0">
          <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter resources" className="h-7 text-xs" />
          <Button size="sm" variant="ghost" icon={<RefreshCw className="size-3.5" />} onClick={() => void refresh()} title="Ask the server for its resources again" />
        </div>
        <div className="flex-1 overflow-y-auto">
          {lists.loading && !lists.data && (
            <div className="px-3 py-2">
              <Spinner />
            </div>
          )}
          {resources.filter(match).map((r) => (
            <button
              key={r.uri}
              type="button"
              onClick={() => setSelection({ kind: 'resource', uri: r.uri })}
              className={cn('w-full text-left px-3 py-1.5 border-b border-edge/60 hover:bg-elevated flex items-start gap-2 min-w-0', selection?.kind === 'resource' && selection.uri === r.uri && 'bg-elevated')}
              data-testid="mcp-resource"
            >
              <FileText className="size-3.5 text-muted shrink-0 mt-0.5" />
              <span className="flex flex-col min-w-0 flex-1">
                <span className="text-xs truncate">{r.title ?? r.name}</span>
                <span className="font-mono text-[11px] text-muted truncate">{r.uri}</span>
              </span>
            </button>
          ))}
          {templates.filter(match).map((t) => (
            <button
              key={t.uriTemplate}
              type="button"
              onClick={() => setSelection({ kind: 'template', uriTemplate: t.uriTemplate })}
              className={cn('w-full text-left px-3 py-1.5 border-b border-edge/60 hover:bg-elevated flex items-start gap-2 min-w-0', selection?.kind === 'template' && selection.uriTemplate === t.uriTemplate && 'bg-elevated')}
              data-testid="mcp-resource-template"
            >
              <BookOpen className="size-3.5 text-muted shrink-0 mt-0.5" />
              <span className="flex flex-col min-w-0 flex-1">
                <span className="text-xs truncate">
                  {t.title ?? t.name} <span className="text-muted">(template)</span>
                </span>
                <span className="font-mono text-[11px] text-muted truncate">{t.uriTemplate}</span>
              </span>
            </button>
          ))}
          {lists.data && resources.length === 0 && templates.length === 0 && <p className="px-3 py-3 text-xs text-muted">This server has no resources.</p>}
        </div>
      </div>
      <div className="flex-1 min-w-0 min-h-0 overflow-y-auto">
        {selectedTemplate ? (
          <TemplateReader key={selectedTemplate.uriTemplate} template={selectedTemplate} busy={busy} onRead={(uri) => void readUri(uri)} read={read} />
        ) : selectedResource ? (
          <div className="flex flex-col gap-2 p-3">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-medium">{selectedResource.title ?? selectedResource.name}</span>
              {selectedResource.mimeType && <Badge>{selectedResource.mimeType}</Badge>}
              {selectedResource.size !== undefined && <Badge>{selectedResource.size} bytes</Badge>}
              <div className="flex-1" />
              <Button size="sm" variant="ghost" icon={<RefreshCw className="size-3.5" />} loading={busy} onClick={() => void readUri(selectedResource.uri)}>
                Read again
              </Button>
            </div>
            {selectedResource.description && <p className="text-xs text-muted">{selectedResource.description}</p>}
            <ReadResult read={read?.uri === selectedResource.uri ? read : null} busy={busy} />
          </div>
        ) : (
          <EmptyState title="Pick a resource" hint="Resources are read as soon as you pick them; templates take their variables first." />
        )}
      </div>
    </div>
  );
}

function TemplateReader({ template, busy, onRead, read }: { template: McpResourceTemplate; busy: boolean; onRead(uri: string): void; read: ReadState | null }) {
  const variables = useMemo(() => templateVariables(template.uriTemplate), [template.uriTemplate]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [uri, setUri] = useState(() => expandUriTemplate(template.uriTemplate, {}));
  const [touched, setTouched] = useState(false);
  const expanded = expandUriTemplate(template.uriTemplate, values);
  const target = touched ? uri : expanded;
  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm font-medium">{template.title ?? template.name}</span>
        <Badge>template</Badge>
        {template.mimeType && <Badge>{template.mimeType}</Badge>}
      </div>
      {template.description && <p className="text-xs text-muted">{template.description}</p>}
      <div className="grid grid-cols-2 gap-2 max-w-2xl">
        {variables.map((name) => (
          <div key={name}>
            <Label>{name}</Label>
            <Input
              value={values[name] ?? ''}
              onChange={(e) => {
                setValues((v) => ({ ...v, [name]: e.target.value }));
                setTouched(false);
              }}
              className="font-mono"
              data-testid="mcp-template-variable"
            />
          </div>
        ))}
      </div>
      <div className="flex items-end gap-2 max-w-2xl">
        <div className="flex-1">
          <Label>URI</Label>
          <Input
            value={target}
            onChange={(e) => {
              setUri(e.target.value);
              setTouched(true);
            }}
            className="font-mono"
            onKeyDown={(e) => e.key === 'Enter' && onRead(target)}
          />
        </div>
        <Button variant="primary" loading={busy} onClick={() => onRead(target)} data-testid="mcp-resource-read">
          Read
        </Button>
      </div>
      <ReadResult read={read} busy={busy} />
    </div>
  );
}

function ReadResult({ read, busy }: { read: ReadState | null; busy: boolean }) {
  if (busy && !read) return <Spinner />;
  if (!read) return null;
  return (
    <div className="flex flex-col gap-2" data-testid="mcp-resource-result">
      {read.error && <p className="text-xs text-danger whitespace-pre-wrap rounded-md border border-danger/40 bg-danger/5 px-2 py-1.5">{read.error}</p>}
      {read.result && (
        <>
          <span className="text-[11px] text-muted">
            {read.result.contents.length} part{read.result.contents.length === 1 ? '' : 's'} · {formatMs(read.result.durationMs)}
          </span>
          {read.result.contents.map((c, i) => (
            <div key={i} className="rounded-md border border-edge p-2">
              <ResourceContentsView contents={c} />
            </div>
          ))}
        </>
      )}
    </div>
  );
}
