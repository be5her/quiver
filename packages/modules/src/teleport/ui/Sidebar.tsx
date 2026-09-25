import { formatRemaining, toErrorPayload, type DbConnectionSummary, type TeleportDatabase, type TeleportKubeCluster, type TeleportStatus, type TeleportTunnel } from '@quiver/core';
import { Badge, Button, IconButton, SectionHeader, Spinner, cn, confirmDialog, invoke, notify, promptDialog, runAction, useAppStore, useInvoke } from '@quiver/ui';
import { Check, Copy, LogIn, LogOut, Plug, RefreshCw, Square, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { revealDbConnection } from '../../db/ui';
import { DbError, teleportLoginAgain } from '../../db/ui/shared';

function useNow(intervalMs: number): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

const STATE_LABEL: Record<TeleportStatus['state'], string> = {
  'no-tsh': 'tsh not found',
  'logged-out': 'Logged out',
  expired: 'Certificate expired',
  'logged-in': 'Logged in',
  expiring: 'Expiring soon',
};

const STATE_DOT: Record<TeleportStatus['state'], string> = {
  'no-tsh': 'bg-muted',
  'logged-out': 'bg-danger',
  expired: 'bg-danger',
  'logged-in': 'bg-success',
  expiring: 'bg-warning',
};

const isLoggedIn = (s: TeleportStatus | undefined): boolean => s?.state === 'logged-in' || s?.state === 'expiring';

export function TeleportSidebar() {
  const status = useInvoke<TeleportStatus>('teleport.status', {}, { workspaceId: null, refreshOnEvents: ['teleport.changed', 'config.changed'] });
  const s = status.data;
  const refreshNow = () => invoke('teleport.status', { refresh: true }, null).then(() => status.refresh(), (err) => notify(toErrorPayload(err).message, 'error'));

  return (
    <div className="flex flex-col h-full min-h-0 overflow-y-auto text-sm">
      <SectionHeader
        title="Session"
        actions={
          <IconButton label="Refresh status" size="sm" onClick={() => void refreshNow()}>
            <RefreshCw className={cn('size-3.5', status.loading && 'animate-spin')} />
          </IconButton>
        }
      />
      {s ? (
        <StatusCard status={s} />
      ) : (
        <div className="px-3 py-2">
          <Spinner />
        </div>
      )}
      {isLoggedIn(s) && <DatabasesSection />}
      {s && s.tunnels.length > 0 && <TunnelsSection tunnels={s.tunnels} />}
      {isLoggedIn(s) && <KubeSection status={s!} />}
    </div>
  );
}

function StatusCard({ status }: { status: TeleportStatus }) {
  const now = useNow(30_000);
  const [busy, setBusy] = useState<'login' | 'logout' | null>(null);
  const [showLog, setShowLog] = useState(false);
  const loggedIn = isLoggedIn(status);

  const login = async () => {
    setBusy('login');
    try {
      await teleportLoginAgain();
    } finally {
      setBusy(null);
    }
  };
  const logout = async () => {
    if (!(await confirmDialog({ title: 'Log out of Teleport?', message: 'This also logs out tsh and kubectl in your terminal and stops running tunnels.', confirmLabel: 'Log out', danger: true }))) return;
    setBusy('logout');
    try {
      await invoke('teleport.logout', {}, null);
      notify('Logged out of Teleport');
    } catch (err) {
      notify(toErrorPayload(err).message, 'error');
    } finally {
      setBusy(null);
    }
  };
  const cancel = () => void invoke('teleport.login.cancel', {}, null).catch(() => {});

  return (
    <div className="mx-2 mb-1 rounded-md border border-edge bg-canvas p-2.5 flex flex-col gap-1.5" data-testid="teleport-status" data-state={status.state}>
      <div className="flex items-center gap-2 min-w-0">
        <span className={cn('size-2 rounded-full shrink-0', STATE_DOT[status.state])} />
        <span className="font-medium text-[13px] truncate">{STATE_LABEL[status.state]}</span>
        <div className="flex-1" />
        {loggedIn && status.validUntil && (
          <span className={cn('text-[11px] shrink-0', status.state === 'expiring' ? 'text-warning' : 'text-muted')} title={`Certificate valid until ${new Date(status.validUntil).toLocaleString()}`}>
            {formatRemaining(status.validUntil, now)} left
          </span>
        )}
      </div>
      {status.user && status.cluster && (
        <div className="text-xs truncate" title={`${status.user} on ${status.cluster}`}>
          {status.user} <span className="text-muted">@</span> {status.cluster}
        </div>
      )}
      {status.proxy && (
        <div className="text-[11px] text-muted font-mono truncate" title="Proxy">
          {status.proxy}
        </div>
      )}
      {status.state === 'expired' && status.validUntil && <div className="text-[11px] text-muted">Expired {new Date(status.validUntil).toLocaleString()}</div>}
      {status.state === 'no-tsh' && (
        <p className="text-xs text-muted">
          Install Teleport Connect, add tsh to PATH, or set its path in{' '}
          <button type="button" className="underline hover:text-fg" onClick={() => runAction('settings.open')}>
            Settings
          </button>
          .
        </p>
      )}
      {status.state !== 'no-tsh' && !status.proxy && (
        <p className="text-xs text-muted">
          Set the proxy address in{' '}
          <button type="button" className="underline hover:text-fg" onClick={() => runAction('settings.open')}>
            Settings
          </button>{' '}
          to log in.
        </p>
      )}
      {status.error && <p className="text-[11px] text-danger break-words">{status.error}</p>}

      {status.loginInProgress ? (
        <div className="flex items-center gap-2 text-xs pt-1">
          <Spinner className="size-3.5" />
          <span className="flex-1">Waiting for the browser…</span>
          <Button size="sm" variant="ghost" icon={<X className="size-3.5" />} onClick={cancel}>
            Cancel
          </Button>
        </div>
      ) : (
        status.state !== 'no-tsh' && (
          <div className="flex items-center gap-1.5 pt-1 flex-wrap">
            <Button size="sm" variant={loggedIn ? 'ghost' : 'primary'} icon={<LogIn className="size-3.5" />} loading={busy === 'login'} disabled={!status.proxy} onClick={() => void login()} title="tsh login (opens the browser)">
              {status.state === 'expired' ? 'Log in again' : 'Log in'}
            </Button>
            {loggedIn && (
              <Button size="sm" variant="ghost" icon={<LogOut className="size-3.5" />} loading={busy === 'logout'} onClick={() => void logout()}>
                Log out
              </Button>
            )}
          </div>
        )
      )}

      {status.loginInProgress && status.loginOutput.length > 0 && <LoginLog lines={status.loginOutput} />}
      {!status.loginInProgress && status.loginOutput.length > 0 && (
        <div>
          <button type="button" className="text-[11px] text-muted hover:text-fg underline" onClick={() => setShowLog((v) => !v)}>
            {showLog ? 'Hide' : 'Show'} last login output
          </button>
          {showLog && <LoginLog lines={status.loginOutput} />}
        </div>
      )}
      {status.tshVersion && (
        <div className="text-[10px] text-muted truncate" title={status.tsh?.join(' ')}>
          tsh {status.tshVersion} · {status.tshSource === 'connect' ? 'Teleport Connect' : status.tshSource === 'path' ? 'PATH' : 'settings'}
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

// ---------- databases ----------

const PROTOCOL_COLORS: Record<string, string> = {
  mysql: 'bg-sky-500/15 text-sky-600 dark:text-sky-300',
  redis: 'bg-rose-500/15 text-rose-600 dark:text-rose-300',
  postgres: 'bg-indigo-500/15 text-indigo-600 dark:text-indigo-300',
  mongodb: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-300',
};

interface ConnectResult {
  tunnel: TeleportTunnel;
  connection: DbConnectionSummary | null;
  message: string | null;
}

function DatabasesSection() {
  const dbs = useInvoke<TeleportDatabase[]>('teleport.db.list', {}, { workspaceId: null, refreshOnEvents: ['teleport.changed'] });
  const hasWorkspace = useAppStore((s) => s.activeWorkspaceId !== null);
  const connections = useInvoke<DbConnectionSummary[]>('db.connection.list', {}, { enabled: hasWorkspace, refreshOn: ['db-connections'] });
  const [busy, setBusy] = useState<string | null>(null);
  const refresh = () => invoke('teleport.db.list', { refresh: true }, null).then(() => dbs.refresh(), (err) => notify(toErrorPayload(err).message, 'error'));

  const connectionFor = (db: TeleportDatabase) => (hasWorkspace ? connections.data?.find((c) => c.access.type === 'teleport' && c.access.database === db.name) : undefined);

  const connect = async (db: TeleportDatabase) => {
    if (busy) return;
    const existing = connectionFor(db);
    let dbUser = existing?.access.type === 'teleport' ? existing.access.dbUser : '';
    if (!dbUser) {
      const concrete = db.allowedUsers.filter((u) => u !== '*');
      if (concrete.length === 1) dbUser = concrete[0];
      else {
        const picked = await promptDialog({
          title: `Database user for ${db.name}`,
          label: db.allowedUsers.length ? `Allowed: ${db.allowedUsers.join(', ')}` : 'Any user your Teleport role allows',
          defaultValue: concrete[0] ?? '',
          confirmLabel: 'Connect',
        });
        if (!picked?.trim()) return;
        dbUser = picked.trim();
      }
    }
    setBusy(db.name);
    try {
      const result = await invoke<ConnectResult>('teleport.db.connect', { database: db.name, dbUser });
      if (result.connection) {
        notify(`Tunnel to ${db.name} on 127.0.0.1:${result.tunnel.port}`, 'success');
        revealDbConnection(result.connection);
      } else {
        notify(result.message ?? `Tunnel to ${db.name} on 127.0.0.1:${result.tunnel.port}`, 'info');
      }
    } catch (err) {
      notify(toErrorPayload(err).message, 'error');
    } finally {
      setBusy(null);
    }
  };

  const stop = async (db: TeleportDatabase) => {
    try {
      await invoke('teleport.db.disconnect', { database: db.name }, null);
    } catch (err) {
      notify(toErrorPayload(err).message, 'error');
    }
  };

  return (
    <div className="mt-2">
      <SectionHeader
        title="Databases"
        actions={
          <IconButton label="Refresh databases" size="sm" onClick={() => void refresh()}>
            <RefreshCw className={cn('size-3.5', dbs.loading && 'animate-spin')} />
          </IconButton>
        }
      />
      {dbs.error && <DbError error={dbs.error} onRetry={() => void dbs.refresh()} compact />}
      {!dbs.data && !dbs.error && (
        <div className="px-3 py-1">
          <Spinner className="size-3.5" />
        </div>
      )}
      {dbs.data?.map((db) => {
        const conn = connectionFor(db);
        const tunnel = db.tunnel;
        return (
          <div
            key={db.name}
            role="button"
            tabIndex={0}
            onClick={() => (conn && tunnel ? revealDbConnection(conn) : void connect(db))}
            onKeyDown={(e) => e.key === 'Enter' && void connect(db)}
            className="group flex flex-col gap-0.5 px-3 py-1.5 hover:bg-elevated cursor-pointer min-w-0"
            title={[db.description, db.uri].filter(Boolean).join('\n')}
            data-testid="teleport-db"
          >
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="truncate text-[13px] font-medium flex-1">{db.name}</span>
              <Badge className={cn('font-mono text-[10px]', PROTOCOL_COLORS[db.protocol] ?? '')}>{db.protocol}</Badge>
            </div>
            <div className="flex items-center gap-1.5 min-w-0 h-5">
              {tunnel ? (
                <span className="flex items-center gap-1 text-[11px] text-success font-mono shrink-0" title={`Tunnel as ${tunnel.dbUser} · pid ${tunnel.pid ?? '?'}`}>
                  <span className="size-1.5 rounded-full bg-success" />:{tunnel.port}
                </span>
              ) : null}
              <span className="truncate text-[11px] text-muted flex-1" title={`Allowed users: ${db.allowedUsers.join(', ') || 'none'}`}>
                {tunnel ? `as ${tunnel.dbUser}` : db.allowedUsers.length ? db.allowedUsers.join(', ') : 'no users allowed'}
              </span>
              <span className="hidden group-hover:flex items-center gap-1 shrink-0">
                {tunnel ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Square className="size-3" />}
                    onClick={(e) => {
                      e.stopPropagation();
                      void stop(db);
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
            </div>
          </div>
        );
      })}
      {dbs.data?.length === 0 && <p className="px-3 py-1 text-xs text-muted">No databases are visible to your Teleport roles.</p>}
    </div>
  );
}

// ---------- tunnels ----------

function TunnelsSection({ tunnels }: { tunnels: TeleportTunnel[] }) {
  const stop = async (t: TeleportTunnel) => {
    try {
      await invoke('teleport.db.disconnect', { tunnelId: t.id }, null);
    } catch (err) {
      notify(toErrorPayload(err).message, 'error');
    }
  };
  return (
    <div className="mt-2">
      <SectionHeader title="Tunnels" />
      {tunnels.map((t) => (
        <div key={t.id} className="group flex items-center gap-2 px-3 h-7 hover:bg-elevated min-w-0" title={t.output.slice(-5).join('\n') || t.target} data-testid="teleport-tunnel">
          <span className="size-1.5 rounded-full bg-success shrink-0" />
          <span className="truncate text-xs flex-1">
            {t.kind === 'teleport' ? (
              <>
                {t.target} <span className="text-muted">as {t.dbUser}</span>
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
      ))}
    </div>
  );
}

// ---------- kubernetes ----------

function KubeSection({ status }: { status: TeleportStatus }) {
  const clusters = useInvoke<TeleportKubeCluster[]>('teleport.kube.list', {}, { workspaceId: null, refreshOnEvents: ['teleport.changed'] });
  const [busy, setBusy] = useState<string | null>(null);
  const refresh = () => invoke('teleport.kube.list', { refresh: true }, null).then(() => clusters.refresh(), (err) => notify(toErrorPayload(err).message, 'error'));

  const use = async (cluster: TeleportKubeCluster) => {
    setBusy(cluster.name);
    try {
      await invoke('teleport.kube.login', { cluster: cluster.name }, null);
      notify(`kubectl now points at ${cluster.name}`, 'success');
      await clusters.refresh();
    } catch (err) {
      notify(toErrorPayload(err).message, 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mt-2">
      <SectionHeader
        title="Kubernetes"
        actions={
          <IconButton label="Refresh clusters" size="sm" onClick={() => void refresh()}>
            <RefreshCw className={cn('size-3.5', clusters.loading && 'animate-spin')} />
          </IconButton>
        }
      />
      {clusters.error && <DbError error={clusters.error} onRetry={() => void clusters.refresh()} compact />}
      {clusters.data?.map((c) => {
        const active = c.selected || status.kubeCluster === c.name;
        return (
          <div key={c.name} className="group flex items-center gap-2 px-3 h-7 hover:bg-elevated min-w-0" title={Object.entries(c.labels).map(([k, v]) => `${k}=${v}`).join('\n')} data-testid="teleport-kube">
            {active ? <Check className="size-3.5 text-success shrink-0" /> : <span className="size-3.5 shrink-0" />}
            <span className={cn('truncate text-[13px] flex-1', active && 'font-medium')}>{c.name}</span>
            {active ? (
              <span className="text-[10px] text-muted group-hover:hidden">active</span>
            ) : (
              <Button size="sm" variant="ghost" className="hidden group-hover:inline-flex" loading={busy === c.name} onClick={() => void use(c)}>
                Use
              </Button>
            )}
          </div>
        );
      })}
      {clusters.data?.length === 0 && <p className="px-3 py-1 text-xs text-muted">No Kubernetes clusters are visible to your Teleport roles.</p>}
    </div>
  );
}
