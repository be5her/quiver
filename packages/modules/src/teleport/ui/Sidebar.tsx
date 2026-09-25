import {
  clusterLabel,
  formatRemaining,
  sameProxy,
  toErrorPayload,
  type DbConnectionSummary,
  type TeleportClusterStatus,
  type TeleportDatabase,
  type TeleportKubeCluster,
  type TeleportPin,
  type TeleportStatus,
  type TeleportTunnel,
} from '@quiver/core';
import { Badge, Button, IconButton, SectionHeader, Spinner, cn, confirmDialog, invoke, notify, promptDialog, runAction, useAppStore, useInvoke } from '@quiver/ui';
import { Boxes, Check, ChevronDown, ChevronRight, Copy, Database, LogIn, LogOut, Pin, PinOff, Plug, Plus, RefreshCw, Square, Terminal, Trash2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { revealDbConnection } from '../../db/ui';
import { DbError, teleportLoginAgain } from '../../db/ui/shared';

// ---------- small shared state ----------

function useNow(intervalMs: number): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** Collapsed clusters survive switching modules. */
const useCollapsed = create<{ collapsed: Record<string, boolean>; toggle(key: string): void }>((set, get) => ({
  collapsed: {},
  toggle: (key) => set({ collapsed: { ...get().collapsed, [key]: !get().collapsed[key] } }),
}));

/** Resource lists loaded by the cluster sections, so the Pinned section can show protocol and tunnel state. */
const useResources = create<{ dbs: Record<string, TeleportDatabase[]>; kubes: Record<string, TeleportKubeCluster[]>; setDbs(proxy: string, dbs: TeleportDatabase[]): void; setKubes(proxy: string, kubes: TeleportKubeCluster[]): void }>((set, get) => ({
  dbs: {},
  kubes: {},
  setDbs: (proxy, dbs) => set({ dbs: { ...get().dbs, [proxy]: dbs } }),
  setKubes: (proxy, kubes) => set({ kubes: { ...get().kubes, [proxy]: kubes } }),
}));

const STATE_LABEL: Record<TeleportClusterStatus['state'], string> = {
  'logged-out': 'Logged out',
  expired: 'Certificate expired',
  'logged-in': 'Logged in',
  expiring: 'Expiring soon',
};

const STATE_DOT: Record<TeleportClusterStatus['state'], string> = {
  'logged-out': 'bg-danger',
  expired: 'bg-danger',
  'logged-in': 'bg-success',
  expiring: 'bg-warning',
};

const PROTOCOL_COLORS: Record<string, string> = {
  mysql: 'bg-sky-500/15 text-sky-600 dark:text-sky-300',
  redis: 'bg-rose-500/15 text-rose-600 dark:text-rose-300',
  postgres: 'bg-indigo-500/15 text-indigo-600 dark:text-indigo-300',
  mongodb: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-300',
};

const isUsable = (c: TeleportClusterStatus | undefined): boolean => c?.state === 'logged-in' || c?.state === 'expiring';

interface ConnectResult {
  tunnel: TeleportTunnel;
  connection: DbConnectionSummary | null;
  message: string | null;
}

function connectionFor(connections: DbConnectionSummary[] | undefined, proxy: string, database: string): DbConnectionSummary | undefined {
  return connections?.find((c) => c.access.type === 'teleport' && c.access.database === database && (sameProxy(c.access.proxy, proxy) || c.access.proxy === ''));
}

/** Connect flow shared by database rows and pinned rows: pick the db user, start the tunnel, reveal the connection. */
async function connectDatabase(proxy: string, name: string, allowedUsers: string[] | undefined, connections: DbConnectionSummary[] | undefined): Promise<void> {
  const existing = connectionFor(connections, proxy, name);
  let dbUser = existing?.access.type === 'teleport' ? existing.access.dbUser : '';
  if (!dbUser && allowedUsers) {
    const concrete = allowedUsers.filter((u) => u !== '*');
    if (concrete.length === 1) dbUser = concrete[0];
    else {
      const picked = await promptDialog({
        title: `Database user for ${name}`,
        label: allowedUsers.length ? `Allowed: ${allowedUsers.join(', ')}` : 'Any user your Teleport role allows',
        defaultValue: concrete[0] ?? '',
        confirmLabel: 'Connect',
      });
      if (!picked?.trim()) return;
      dbUser = picked.trim();
    }
  }
  const result = await invoke<ConnectResult>('teleport.db.connect', { proxy, database: name, dbUser: dbUser || undefined });
  if (result.connection) {
    notify(`Tunnel to ${name} on 127.0.0.1:${result.tunnel.port}`, 'success');
    revealDbConnection(result.connection);
  } else {
    notify(result.message ?? `Tunnel to ${name} on 127.0.0.1:${result.tunnel.port}`, 'info');
  }
}

async function stopDatabase(proxy: string, name: string): Promise<void> {
  await invoke('teleport.db.disconnect', { proxy, database: name }, null);
}

async function useKubeCluster(proxy: string, name: string): Promise<void> {
  await invoke('teleport.kube.login', { proxy, cluster: name }, null);
  notify(`kubectl now points at ${name}`, 'success');
}

async function setPin(pin: TeleportPin, pinned: boolean): Promise<void> {
  await invoke('teleport.pin', { ...pin, pinned }, null);
}

const report = (err: unknown) => notify(toErrorPayload(err).message, 'error');

// ---------- sidebar ----------

export function TeleportSidebar() {
  const status = useInvoke<TeleportStatus>('teleport.status', {}, { workspaceId: null, refreshOnEvents: ['teleport.changed', 'config.changed'] });
  const hasWorkspace = useAppStore((s) => s.activeWorkspaceId !== null);
  const connections = useInvoke<DbConnectionSummary[]>('db.connection.list', {}, { enabled: hasWorkspace, refreshOn: ['db-connections'] });
  const s = status.data;
  const refreshNow = () => invoke('teleport.status', { refresh: true }, null).then(() => status.refresh(), report);

  const addCluster = async () => {
    const proxy = await promptDialog({ title: 'Add Teleport cluster', label: 'Proxy address', placeholder: 'teleport.example.com:443', confirmLabel: 'Add' });
    if (!proxy?.trim()) return;
    try {
      await invoke('teleport.cluster.add', { proxy: proxy.trim() }, null);
    } catch (err) {
      report(err);
    }
  };

  return (
    <div className="flex flex-col h-full min-h-0 overflow-y-auto text-sm">
      <SectionHeader
        title="Clusters"
        actions={
          <>
            <IconButton label="Add cluster" size="sm" onClick={() => void addCluster()}>
              <Plus className="size-3.5" />
            </IconButton>
            <IconButton label="Refresh status" size="sm" onClick={() => void refreshNow()}>
              <RefreshCw className={cn('size-3.5', status.loading && 'animate-spin')} />
            </IconButton>
          </>
        }
      />
      {!s && (
        <div className="px-3 py-2">
          <Spinner />
        </div>
      )}
      {s?.state === 'no-tsh' && <NoTshCard />}
      {s && s.state !== 'no-tsh' && s.clusters.length === 0 && (
        <p className="px-3 py-2 text-xs text-muted">
          No clusters yet. Add a proxy address with the plus button, or log in once with tsh in your terminal and it appears here.
        </p>
      )}
      {s?.error && <p className="px-3 py-1 text-[11px] text-danger break-words">{s.error}</p>}
      {s && s.pins.length > 0 && <PinnedSection status={s} connections={connections.data} />}
      {s?.clusters.map((c) => <ClusterSection key={c.proxy} cluster={c} status={s} connections={connections.data} />)}
      {s && s.tunnels.length > 0 && <TunnelsSection tunnels={s.tunnels} clusters={s.clusters} />}
      {s?.tshVersion && (
        <div className="px-3 py-2 mt-auto text-[10px] text-muted truncate" title={s.tsh?.join(' ')}>
          tsh {s.tshVersion} · {s.tshSource === 'connect' ? 'Teleport Connect' : s.tshSource === 'path' ? 'PATH' : 'settings'}
        </div>
      )}
    </div>
  );
}

function NoTshCard() {
  return (
    <div className="mx-2 mb-1 rounded-md border border-edge bg-canvas p-2.5 text-xs" data-testid="teleport-status" data-state="no-tsh">
      <div className="flex items-center gap-2 font-medium text-[13px] mb-1">
        <span className="size-2 rounded-full bg-muted" /> tsh not found
      </div>
      <p className="text-muted">
        Install Teleport Connect, add tsh to PATH, or set its path in{' '}
        <button type="button" className="underline hover:text-fg" onClick={() => runAction('settings.open')}>
          Settings
        </button>
        .
      </p>
    </div>
  );
}

// ---------- pinned ----------

function PinnedSection({ status, connections }: { status: TeleportStatus; connections: DbConnectionSummary[] | undefined }) {
  const dbs = useResources((r) => r.dbs);
  const kubes = useResources((r) => r.kubes);
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <div className="mb-1">
      <SectionHeader title="Pinned" />
      {status.pins.map((pin) => {
        const key = `${pin.kind}:${pin.proxy}:${pin.name}`;
        const cluster = status.clusters.find((c) => sameProxy(c.proxy, pin.proxy));
        const usable = isUsable(cluster);
        const db = pin.kind === 'db' ? Object.entries(dbs).find(([p]) => sameProxy(p, pin.proxy))?.[1]?.find((d) => d.name === pin.name) : undefined;
        const kube = pin.kind === 'kube' ? Object.entries(kubes).find(([p]) => sameProxy(p, pin.proxy))?.[1]?.find((k) => k.name === pin.name) : undefined;
        const tunnel = status.tunnels.find((t) => t.kind === 'teleport' && t.target === pin.name && sameProxy(t.proxy, pin.proxy));
        const conn = pin.kind === 'db' ? connectionFor(connections, pin.proxy, pin.name) : undefined;
        const act = async () => {
          if (busy) return;
          setBusy(key);
          try {
            if (pin.kind === 'db') {
              if (conn && tunnel) revealDbConnection(conn);
              else await connectDatabase(pin.proxy, pin.name, db?.allowedUsers, connections);
            } else {
              await useKubeCluster(pin.proxy, pin.name);
            }
          } catch (err) {
            report(err);
          } finally {
            setBusy(null);
          }
        };
        return (
          <div
            key={key}
            role="button"
            tabIndex={0}
            onClick={() => void act()}
            onKeyDown={(e) => e.key === 'Enter' && void act()}
            className={cn('group flex flex-col gap-0.5 px-3 py-1 hover:bg-elevated cursor-pointer min-w-0', !usable && 'opacity-70')}
            title={`${pin.name} on ${cluster ? clusterLabel(cluster) : pin.proxy}${usable ? '' : ' (log in to use)'}`}
            data-testid="teleport-pin"
          >
            <div className="flex items-center gap-2 min-w-0">
              {pin.kind === 'db' ? <Database className="size-3.5 text-muted shrink-0" /> : <Boxes className="size-3.5 text-muted shrink-0" />}
              <span className="truncate text-[13px] flex-1">{pin.name}</span>
              {tunnel ? (
                <span className="text-[11px] text-success font-mono shrink-0" title={`Tunnel as ${tunnel.dbUser}`}>
                  :{tunnel.port}
                </span>
              ) : db ? (
                <Badge className={cn('font-mono text-[10px]', PROTOCOL_COLORS[db.protocol] ?? '')}>{db.protocol}</Badge>
              ) : kube?.selected ? (
                <Check className="size-3.5 text-success shrink-0" aria-label="active" />
              ) : null}
              {busy === key && <Spinner className="size-3.5" />}
            </div>
            <div className="flex items-center gap-2 min-w-0 h-5 pl-[22px]">
              <span className="truncate text-[11px] text-muted flex-1">
                {cluster ? clusterLabel(cluster) : pin.proxy}
                {!usable && ' · log in to use'}
              </span>
              <span className="hidden group-hover:flex items-center gap-0.5 shrink-0">
                {pin.kind === 'db' && tunnel && (
                  <IconButton
                    label="Stop tunnel"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      void stopDatabase(pin.proxy, pin.name).catch(report);
                    }}
                  >
                    <Square className="size-3" />
                  </IconButton>
                )}
                <IconButton
                  label="Unpin"
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    void setPin(pin, false).catch(report);
                  }}
                >
                  <PinOff className="size-3.5" />
                </IconButton>
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------- one cluster ----------

function ClusterSection({ cluster, status, connections }: { cluster: TeleportClusterStatus; status: TeleportStatus; connections: DbConnectionSummary[] | undefined }) {
  const now = useNow(30_000);
  const collapsed = useCollapsed((s) => Boolean(s.collapsed[cluster.proxy]));
  const toggle = useCollapsed((s) => s.toggle);
  const [busy, setBusy] = useState<'login' | 'logout' | null>(null);
  const [showLog, setShowLog] = useState(false);
  const usable = isUsable(cluster);
  const loggingIn = status.loginInProgress && sameProxy(status.loginProxy, cluster.proxy);
  const lastLogHere = !status.loginInProgress && sameProxy(status.loginProxy, cluster.proxy) && status.loginOutput.length > 0;

  const login = async () => {
    setBusy('login');
    try {
      await teleportLoginAgain(cluster.proxy);
    } finally {
      setBusy(null);
    }
  };
  const logout = async () => {
    if (!(await confirmDialog({ title: `Log out of ${clusterLabel(cluster)}?`, message: 'This also logs out tsh and kubectl in your terminal for this cluster and stops its tunnels.', confirmLabel: 'Log out', danger: true }))) return;
    setBusy('logout');
    try {
      await invoke('teleport.logout', { proxy: cluster.proxy }, null);
      notify(`Logged out of ${clusterLabel(cluster)}`);
    } catch (err) {
      report(err);
    } finally {
      setBusy(null);
    }
  };
  const remove = async () => {
    if (!(await confirmDialog({ title: `Remove ${clusterLabel(cluster)} from Quiver?`, message: 'Its pins are removed and its tunnels stopped. The tsh profile stays on disk.', confirmLabel: 'Remove', danger: true }))) return;
    try {
      await invoke('teleport.cluster.remove', { proxy: cluster.proxy }, null);
    } catch (err) {
      report(err);
    }
  };
  const cancel = () => void invoke('teleport.login.cancel', {}, null).catch(() => {});

  return (
    <div className="mt-1" data-testid="teleport-cluster" data-state={cluster.state} data-proxy={cluster.proxy}>
      <div
        role="button"
        tabIndex={0}
        onClick={() => toggle(cluster.proxy)}
        onKeyDown={(e) => e.key === 'Enter' && toggle(cluster.proxy)}
        className="group flex items-center gap-1.5 px-2 h-8 hover:bg-elevated cursor-pointer min-w-0"
        title={`${cluster.proxy}\n${STATE_LABEL[cluster.state]}${cluster.validUntil ? `\nValid until ${new Date(cluster.validUntil).toLocaleString()}` : ''}`}
      >
        {collapsed ? <ChevronRight className="size-3.5 text-muted shrink-0" /> : <ChevronDown className="size-3.5 text-muted shrink-0" />}
        <span className={cn('size-2 rounded-full shrink-0', STATE_DOT[cluster.state])} />
        <span className="truncate text-[13px] font-medium flex-1">{clusterLabel(cluster)}</span>
        {cluster.current && <Terminal className="size-3 text-muted shrink-0" aria-label="Current tsh profile in your terminal" />}
        {usable && cluster.validUntil ? (
          <span className={cn('text-[11px] shrink-0 group-hover:hidden', cluster.state === 'expiring' ? 'text-warning' : 'text-muted')}>{formatRemaining(cluster.validUntil, now)}</span>
        ) : (
          <span className="text-[11px] text-muted shrink-0 group-hover:hidden">{cluster.state === 'expired' ? 'expired' : 'logged out'}</span>
        )}
        <span className="hidden group-hover:flex items-center shrink-0">
          {!loggingIn && (
            <IconButton
              label={usable ? 'Log in again (refresh certificate)' : 'Log in'}
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                void login();
              }}
            >
              <LogIn className="size-3.5" />
            </IconButton>
          )}
          {usable && (
            <IconButton
              label="Log out"
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                void logout();
              }}
            >
              <LogOut className="size-3.5" />
            </IconButton>
          )}
          {cluster.configured && (
            <IconButton
              label="Remove cluster from Quiver"
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                void remove();
              }}
            >
              <Trash2 className="size-3.5" />
            </IconButton>
          )}
        </span>
      </div>

      {!collapsed && (
        <div className="pb-1">
          <div className="px-3 text-[11px] text-muted truncate" title={cluster.proxy}>
            {cluster.user ? (
              <>
                {cluster.user} <span>@</span> {cluster.proxy}
              </>
            ) : (
              cluster.proxy
            )}
          </div>

          {loggingIn ? (
            <div className="mx-2 mt-1 rounded-md border border-edge bg-canvas p-2 flex flex-col gap-1.5">
              <div className="flex items-center gap-2 text-xs">
                <Spinner className="size-3.5" />
                <span className="flex-1">Waiting for the browser…</span>
                <Button size="sm" variant="ghost" icon={<X className="size-3.5" />} onClick={cancel}>
                  Cancel
                </Button>
              </div>
              {status.loginOutput.length > 0 && <LoginLog lines={status.loginOutput} />}
            </div>
          ) : !usable ? (
            <div className="px-3 pt-1.5 pb-1 flex items-center gap-2 flex-wrap">
              <Button size="sm" variant="primary" icon={<LogIn className="size-3.5" />} loading={busy === 'login'} onClick={() => void login()} title="tsh login (opens the browser)">
                {cluster.state === 'expired' ? 'Log in again' : 'Log in'}
              </Button>
              {cluster.state === 'expired' && cluster.validUntil && <span className="text-[11px] text-muted">expired {new Date(cluster.validUntil).toLocaleString()}</span>}
            </div>
          ) : null}
          {lastLogHere && (
            <div className="px-3 pt-1">
              <button type="button" className="text-[11px] text-muted hover:text-fg underline" onClick={() => setShowLog((v) => !v)}>
                {showLog ? 'Hide' : 'Show'} last login output
              </button>
              {showLog && <LoginLog lines={status.loginOutput} />}
            </div>
          )}

          {usable && (
            <>
              <DatabasesList cluster={cluster} status={status} connections={connections} />
              <KubeList cluster={cluster} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

function LoginLog({ lines }: { lines: string[] }) {
  return (
    <div className="relative mt-1">
      <pre className="max-h-40 overflow-auto rounded border border-edge bg-surface p-1.5 pr-7 text-[10px] font-mono whitespace-pre-wrap break-all text-muted" data-testid="teleport-login-log">
        {lines.join('\n')}
      </pre>
      <IconButton label="Copy output" size="sm" className="absolute top-0.5 right-0.5" onClick={() => void navigator.clipboard.writeText(lines.join('\n')).then(() => notify('Copied', 'success'))}>
        <Copy className="size-3" />
      </IconButton>
    </div>
  );
}

// ---------- databases of one cluster ----------

function DatabasesList({ cluster, status, connections }: { cluster: TeleportClusterStatus; status: TeleportStatus; connections: DbConnectionSummary[] | undefined }) {
  const dbs = useInvoke<TeleportDatabase[]>('teleport.db.list', { proxy: cluster.proxy }, { workspaceId: null, refreshOnEvents: ['teleport.changed'] });
  const setDbs = useResources((r) => r.setDbs);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    if (dbs.data) setDbs(cluster.proxy, dbs.data);
  }, [dbs.data, cluster.proxy, setDbs]);
  const refresh = () => invoke('teleport.db.list', { proxy: cluster.proxy, refresh: true }, null).then(() => dbs.refresh(), report);

  const connect = async (db: TeleportDatabase) => {
    if (busy) return;
    setBusy(db.name);
    try {
      await connectDatabase(db.proxy, db.name, db.allowedUsers, connections);
    } catch (err) {
      report(err);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mt-1">
      <SubHeader title="Databases" loading={dbs.loading} onRefresh={() => void refresh()} />
      {dbs.error && <DbError error={dbs.error} onRetry={() => void dbs.refresh()} compact />}
      {!dbs.data && !dbs.error && (
        <div className="px-4 py-1">
          <Spinner className="size-3.5" />
        </div>
      )}
      {dbs.data?.map((db) => {
        const conn = connectionFor(connections, db.proxy, db.name);
        const tunnel = db.tunnel ?? status.tunnels.find((t) => t.kind === 'teleport' && t.target === db.name && sameProxy(t.proxy, db.proxy)) ?? null;
        const pinned = status.pins.some((p) => p.kind === 'db' && p.name === db.name && sameProxy(p.proxy, db.proxy));
        return (
          <div
            key={db.name}
            role="button"
            tabIndex={0}
            onClick={() => (conn && tunnel ? revealDbConnection(conn) : void connect(db))}
            onKeyDown={(e) => e.key === 'Enter' && void connect(db)}
            className="group flex flex-col gap-0.5 pl-4 pr-2 py-1 hover:bg-elevated cursor-pointer min-w-0"
            title={[db.description, db.uri].filter(Boolean).join('\n')}
            data-testid="teleport-db"
          >
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="truncate text-[13px] flex-1">{db.name}</span>
              <Badge className={cn('font-mono text-[10px]', PROTOCOL_COLORS[db.protocol] ?? '')}>{db.protocol}</Badge>
            </div>
            <div className="flex items-center gap-1.5 min-w-0 h-5">
              {tunnel && (
                <span className="flex items-center gap-1 text-[11px] text-success font-mono shrink-0" title={`Tunnel as ${tunnel.dbUser} · pid ${tunnel.pid ?? '?'}`}>
                  <span className="size-1.5 rounded-full bg-success" />:{tunnel.port}
                </span>
              )}
              <span className="truncate text-[11px] text-muted flex-1" title={`Allowed users: ${db.allowedUsers.join(', ') || 'none'}`}>
                {tunnel ? `as ${tunnel.dbUser}` : db.allowedUsers.length ? db.allowedUsers.join(', ') : 'no users allowed'}
              </span>
              <span className="hidden group-hover:flex items-center gap-0.5 shrink-0">
                <IconButton
                  label={pinned ? 'Unpin' : 'Pin'}
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    void setPin({ proxy: db.proxy, kind: 'db', name: db.name }, !pinned).catch(report);
                  }}
                >
                  {pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
                </IconButton>
                {tunnel ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Square className="size-3" />}
                    onClick={(e) => {
                      e.stopPropagation();
                      void stopDatabase(db.proxy, db.name).catch(report);
                    }}
                  >
                    Stop
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Plug className="size-3" />}
                    loading={busy === db.name}
                    onClick={(e) => {
                      e.stopPropagation();
                      void connect(db);
                    }}
                  >
                    Connect
                  </Button>
                )}
              </span>
              {pinned && <Pin className="size-3 text-muted shrink-0 group-hover:hidden" aria-label="pinned" />}
            </div>
          </div>
        );
      })}
      {dbs.data?.length === 0 && <p className="px-4 py-1 text-xs text-muted">No databases are visible to your roles here.</p>}
    </div>
  );
}

// ---------- kubernetes clusters of one cluster ----------

function KubeList({ cluster }: { cluster: TeleportClusterStatus }) {
  const kubes = useInvoke<TeleportKubeCluster[]>('teleport.kube.list', { proxy: cluster.proxy }, { workspaceId: null, refreshOnEvents: ['teleport.changed'] });
  const setKubes = useResources((r) => r.setKubes);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    if (kubes.data) setKubes(cluster.proxy, kubes.data);
  }, [kubes.data, cluster.proxy, setKubes]);
  const refresh = () => invoke('teleport.kube.list', { proxy: cluster.proxy, refresh: true }, null).then(() => kubes.refresh(), report);

  const use = async (k: TeleportKubeCluster) => {
    setBusy(k.name);
    try {
      await useKubeCluster(k.proxy, k.name);
      await kubes.refresh();
    } catch (err) {
      report(err);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mt-1">
      <SubHeader title="Kubernetes" loading={kubes.loading} onRefresh={() => void refresh()} />
      {kubes.error && <DbError error={kubes.error} onRetry={() => void kubes.refresh()} compact />}
      {kubes.data?.map((k) => {
        const active = k.selected || cluster.kubeCluster === k.name;
        return (
          <div key={k.name} className="group flex items-center gap-2 pl-4 pr-2 h-7 hover:bg-elevated min-w-0" title={Object.entries(k.labels).map(([a, b]) => `${a}=${b}`).join('\n')} data-testid="teleport-kube">
            {active ? <Check className="size-3.5 text-success shrink-0" /> : <span className="size-3.5 shrink-0" />}
            <span className={cn('truncate text-[13px] flex-1', active && 'font-medium')}>{k.name}</span>
            {k.pinned && <Pin className="size-3 text-muted shrink-0 group-hover:hidden" aria-label="pinned" />}
            {active && <span className="text-[10px] text-muted group-hover:hidden">active</span>}
            <span className="hidden group-hover:flex items-center gap-0.5 shrink-0">
              <IconButton label={k.pinned ? 'Unpin' : 'Pin'} size="sm" onClick={() => void setPin({ proxy: k.proxy, kind: 'kube', name: k.name }, !k.pinned).catch(report)}>
                {k.pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
              </IconButton>
              {!active && (
                <Button size="sm" variant="ghost" loading={busy === k.name} onClick={() => void use(k)}>
                  Use
                </Button>
              )}
            </span>
          </div>
        );
      })}
      {kubes.data?.length === 0 && <p className="px-4 py-1 text-xs text-muted">No Kubernetes clusters are visible to your roles here.</p>}
    </div>
  );
}

function SubHeader({ title, loading, onRefresh }: { title: string; loading: boolean; onRefresh(): void }) {
  return (
    <div className="flex items-center justify-between pl-4 pr-2 h-6 text-[10px] font-semibold uppercase tracking-wide text-muted">
      <span>{title}</span>
      <IconButton label={`Refresh ${title.toLowerCase()}`} size="sm" onClick={onRefresh}>
        <RefreshCw className={cn('size-3', loading && 'animate-spin')} />
      </IconButton>
    </div>
  );
}

// ---------- tunnels ----------

function TunnelsSection({ tunnels, clusters }: { tunnels: TeleportTunnel[]; clusters: TeleportClusterStatus[] }) {
  const stop = async (t: TeleportTunnel) => {
    try {
      await invoke('teleport.db.disconnect', { tunnelId: t.id }, null);
    } catch (err) {
      report(err);
    }
  };
  return (
    <div className="mt-2">
      <SectionHeader title="Tunnels" />
      {tunnels.map((t) => {
        const cluster = clusters.find((c) => sameProxy(c.proxy, t.proxy));
        return (
          <div key={t.id} className="group flex items-center gap-2 px-3 h-7 hover:bg-elevated min-w-0" title={t.output.slice(-5).join('\n') || t.target} data-testid="teleport-tunnel">
            <span className="size-1.5 rounded-full bg-success shrink-0" />
            <span className="truncate text-xs flex-1">
              {t.kind === 'teleport' ? (
                <>
                  {t.target} <span className="text-muted">as {t.dbUser}</span>
                  {cluster && <span className="text-muted"> · {clusterLabel(cluster)}</span>}
                </>
              ) : (
                <span className="font-mono">{t.target}</span>
              )}
            </span>
            <span className="text-[11px] font-mono text-muted shrink-0">:{t.port}</span>
            <IconButton label="Stop tunnel" size="sm" className="hidden group-hover:inline-flex" onClick={() => void stop(t)}>
              <Square className="size-3" />
            </IconButton>
          </div>
        );
      })}
    </div>
  );
}
