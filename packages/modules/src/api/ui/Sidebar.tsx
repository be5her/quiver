import type { ApiCollection, ApiRequest, Environment, HistoryEntry } from '@quiver/core';
import {
  IconButton,
  METHOD_COLORS,
  SectionHeader,
  cn,
  confirmDialog,
  invoke,
  notify,
  promptDialog,
  useInvoke,
  useAppStore,
  useTabsStore,
  selectScope,
  statusColor,
} from '@quiver/ui';
import { Braces, ChevronDown, ChevronRight, Copy, FolderPlus, Import, Pencil, Plus, Trash2, Check } from 'lucide-react';
import { useMemo, useState } from 'react';
import { createEnvironment, createGraphqlRequest, createRequest, importCurl, openEnvironmentTab, openRequestTab } from './index';

export function ApiSidebar() {
  const requests = useInvoke<ApiRequest[]>('api.request.list', {}, { refreshOn: ['requests'] });
  const collections = useInvoke<ApiCollection[]>('api.collection.list', {}, { refreshOn: ['collections'] });
  const environments = useInvoke<Environment[]>('api.environment.list', {}, { refreshOn: ['environments'] });
  const active = useInvoke<{ id: string | null }>('api.environment.active', {}, { refreshOnState: ['api.activeEnvironment'] });
  const history = useInvoke<HistoryEntry[]>('api.history.list', { limit: 30 }, { refreshOn: ['history'] });
  const [historyOpen, setHistoryOpen] = useState(false);
  const [envOpen, setEnvOpen] = useState(true);

  return (
    <div className="flex flex-col h-full min-h-0 overflow-y-auto text-sm">
      <SectionHeader
        title="Collections"
        actions={
          <>
            <IconButton label="New request" size="sm" onClick={() => void createRequest()}>
              <Plus className="size-3.5" />
            </IconButton>
            <IconButton label="New GraphQL request" size="sm" onClick={() => void createGraphqlRequest()}>
              <Braces className="size-3.5" />
            </IconButton>
            <IconButton label="New collection" size="sm" onClick={() => void newCollection(null)}>
              <FolderPlus className="size-3.5" />
            </IconButton>
            <IconButton label="Import from curl" size="sm" onClick={() => void importCurl()}>
              <Import className="size-3.5" />
            </IconButton>
          </>
        }
      />
      <CollectionTree collections={collections.data ?? []} requests={requests.data ?? []} parentId={null} depth={0} />
      {(requests.data?.length ?? 0) === 0 && (collections.data?.length ?? 0) === 0 && (
        <p className="px-3 py-2 text-xs text-muted">No requests yet. Create one or import a curl command.</p>
      )}

      <div className="mt-3">
        <SectionHeader
          title={
            <button type="button" className="flex items-center gap-1" onClick={() => setEnvOpen((o) => !o)}>
              {envOpen ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />} Environments
            </button>
          }
          actions={
            <IconButton label="New environment" size="sm" onClick={() => void createEnvironment()}>
              <Plus className="size-3.5" />
            </IconButton>
          }
        />
        {envOpen &&
          (environments.data ?? []).map((env) => (
            <Row
              key={env.id}
              onClick={() => openEnvironmentTab(env)}
              label={env.name}
              prefix={
                <button
                  type="button"
                  title={active.data?.id === env.id ? 'Active environment' : 'Activate'}
                  className={cn('size-4 rounded-full border flex items-center justify-center', active.data?.id === env.id ? 'border-accent bg-accent text-accent-fg' : 'border-edge text-transparent hover:text-muted')}
                  onClick={(e) => {
                    e.stopPropagation();
                    void invoke('api.environment.setActive', { id: active.data?.id === env.id ? null : env.id });
                  }}
                >
                  <Check className="size-3" />
                </button>
              }
              actions={
                <IconButton label="Delete environment" size="sm" onClick={(e) => void deleteEnvironment(e, env)}>
                  <Trash2 className="size-3.5" />
                </IconButton>
              }
            />
          ))}
        {envOpen && (environments.data?.length ?? 0) === 0 && <p className="px-3 py-1 text-xs text-muted">No environments. Variables like {'{{baseUrl}}'} come from here.</p>}
      </div>

      <div className="mt-3">
        <SectionHeader
          title={
            <button type="button" className="flex items-center gap-1" onClick={() => setHistoryOpen((o) => !o)}>
              {historyOpen ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />} History
            </button>
          }
          actions={
            (history.data?.length ?? 0) > 0 ? (
              <IconButton label="Clear history" size="sm" onClick={() => void clearHistory()}>
                <Trash2 className="size-3.5" />
              </IconButton>
            ) : undefined
          }
        />
        {historyOpen &&
          (history.data ?? []).map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => openRequestTab({ id: `history-${entry.id}`, name: entry.request.name }, { ...entry.request, id: `history-${entry.id}` })}
              className="w-full text-left px-3 py-1 hover:bg-elevated flex items-center gap-2 min-w-0"
              title={`${entry.at}\n${entry.url}`}
            >
              <span className={cn('text-[10px] font-bold w-10 shrink-0', METHOD_COLORS[entry.method])}>{entry.method}</span>
              <span className="truncate text-xs text-fg flex-1">{entry.url.replace(/^https?:\/\//, '')}</span>
              <span className={cn('text-[10px] font-mono shrink-0', entry.status ? statusColor(entry.status) : 'text-danger')}>{entry.status ?? 'ERR'}</span>
            </button>
          ))}
      </div>
    </div>
  );

  async function deleteEnvironment(e: React.MouseEvent, env: Environment) {
    e.stopPropagation();
    if (!(await confirmDialog({ title: `Delete environment "${env.name}"?`, danger: true, confirmLabel: 'Delete' }))) return;
    await invoke('api.environment.delete', { id: env.id });
    const scope = selectScope(useAppStore.getState());
    useTabsStore.getState().closeWhere(scope, (t) => t.type === 'api.environment' && t.data?.id === env.id);
  }

  async function clearHistory() {
    if (await confirmDialog({ title: 'Clear request history?', danger: true, confirmLabel: 'Clear' })) await invoke('api.history.clear');
  }
}

async function newCollection(parentId: string | null) {
  const name = await promptDialog({ title: 'New collection', label: 'Name', confirmLabel: 'Create' });
  if (name?.trim()) await invoke('api.collection.create', { name: name.trim(), parentId });
}

function CollectionTree({ collections, requests, parentId, depth }: { collections: ApiCollection[]; requests: ApiRequest[]; parentId: string | null; depth: number }) {
  const children = useMemo(() => collections.filter((c) => (c.parentId ?? null) === parentId), [collections, parentId]);
  const items = useMemo(() => requests.filter((r) => (r.collectionId ?? null) === parentId), [requests, parentId]);
  return (
    <>
      {children.map((c) => (
        <CollectionNode key={c.id} collection={c} collections={collections} requests={requests} depth={depth} />
      ))}
      {items.map((r) => (
        <RequestRow key={r.id} request={r} depth={depth} />
      ))}
    </>
  );
}

function CollectionNode({ collection, collections, requests, depth }: { collection: ApiCollection; collections: ApiCollection[]; requests: ApiRequest[]; depth: number }) {
  const [open, setOpen] = useState(true);
  return (
    <div>
      <Row
        depth={depth}
        onClick={() => setOpen((o) => !o)}
        prefix={open ? <ChevronDown className="size-3.5 text-muted" /> : <ChevronRight className="size-3.5 text-muted" />}
        label={collection.name}
        bold
        actions={
          <>
            <IconButton label="New request here" size="sm" onClick={(e) => stop(e, () => createRequest(collection.id))}>
              <Plus className="size-3.5" />
            </IconButton>
            <IconButton label="New sub-collection" size="sm" onClick={(e) => stop(e, () => newCollection(collection.id))}>
              <FolderPlus className="size-3.5" />
            </IconButton>
            <IconButton label="Rename" size="sm" onClick={(e) => stop(e, () => renameCollection(collection))}>
              <Pencil className="size-3.5" />
            </IconButton>
            <IconButton label="Delete" size="sm" onClick={(e) => stop(e, () => deleteCollection(collection))}>
              <Trash2 className="size-3.5" />
            </IconButton>
          </>
        }
      />
      {open && <CollectionTree collections={collections} requests={requests} parentId={collection.id} depth={depth + 1} />}
    </div>
  );
}

function RequestRow({ request, depth }: { request: ApiRequest; depth: number }) {
  const scope = useAppStore(selectScope);
  const activeTab = useTabsStore((s) => s.scopes[scope]?.tabs.find((t) => t.id === s.scopes[scope]?.activeTabId));
  const isActive = activeTab?.type === 'api.request' && activeTab.data?.id === request.id;
  return (
    <Row
      depth={depth}
      active={isActive}
      onClick={() => openRequestTab(request)}
      prefix={
        request.body.type === 'graphql' ? (
          <span className="text-[10px] font-bold w-10 shrink-0 text-right text-pink-600 dark:text-pink-400" title={`GraphQL over ${request.method}`}>
            GQL
          </span>
        ) : (
          <span className={cn('text-[10px] font-bold w-10 shrink-0 text-right', METHOD_COLORS[request.method])}>{request.method}</span>
        )
      }
      label={request.name}
      actions={
        <>
          <IconButton label="Rename" size="sm" onClick={(e) => stop(e, () => renameRequest(request))}>
            <Pencil className="size-3.5" />
          </IconButton>
          <IconButton label="Duplicate" size="sm" onClick={(e) => stop(e, () => invoke('api.request.duplicate', { id: request.id }))}>
            <Copy className="size-3.5" />
          </IconButton>
          <IconButton label="Delete" size="sm" onClick={(e) => stop(e, () => deleteRequest(request))}>
            <Trash2 className="size-3.5" />
          </IconButton>
        </>
      }
    />
  );
}

function Row({
  depth = 0,
  onClick,
  prefix,
  label,
  actions,
  bold,
  active,
}: {
  depth?: number;
  onClick(): void;
  prefix?: React.ReactNode;
  label: string;
  actions?: React.ReactNode;
  bold?: boolean;
  active?: boolean;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => e.key === 'Enter' && onClick()}
      className={cn('group flex items-center gap-1.5 pr-1 h-7 cursor-pointer hover:bg-elevated min-w-0', active && 'bg-elevated')}
      style={{ paddingLeft: 8 + depth * 14 }}
    >
      {prefix}
      <span className={cn('truncate flex-1 text-[13px]', bold && 'font-medium')}>{label}</span>
      <span className="hidden group-hover:flex items-center">{actions}</span>
    </div>
  );
}

function stop(e: React.MouseEvent, fn: () => unknown) {
  e.stopPropagation();
  void Promise.resolve(fn()).catch((err) => notify((err as Error).message, 'error'));
}

async function renameRequest(request: ApiRequest) {
  const name = await promptDialog({ title: 'Rename request', defaultValue: request.name, confirmLabel: 'Rename' });
  if (name?.trim() && name !== request.name) await invoke('api.request.save', { request: { ...request, name: name.trim() } });
}

async function deleteRequest(request: ApiRequest) {
  if (!(await confirmDialog({ title: `Delete "${request.name}"?`, danger: true, confirmLabel: 'Delete' }))) return;
  await invoke('api.request.delete', { id: request.id });
  const scope = selectScope(useAppStore.getState());
  useTabsStore.getState().closeWhere(scope, (t) => t.type === 'api.request' && t.data?.id === request.id);
}

async function renameCollection(collection: ApiCollection) {
  const name = await promptDialog({ title: 'Rename collection', defaultValue: collection.name, confirmLabel: 'Rename' });
  if (name?.trim() && name !== collection.name) await invoke('api.collection.rename', { id: collection.id, name: name.trim() });
}

async function deleteCollection(collection: ApiCollection) {
  if (!(await confirmDialog({ title: `Delete "${collection.name}" and everything inside?`, danger: true, confirmLabel: 'Delete' }))) return;
  await invoke('api.collection.delete', { id: collection.id });
}
