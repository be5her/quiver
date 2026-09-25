import {
  DB_KIND_LABELS,
  DbKindSchema,
  defaultPort,
  newDbConnection,
  toErrorPayload,
  type DbAccess,
  type DbConnection,
  type DbConnectionSummary,
  type DbConnectionTest,
  type DbKind,
  type TeleportDatabase,
} from '@quiver/core';
import { Button, Checkbox, Input, Label, Select, Spinner, invoke, notify, selectActiveWorkspace, useAppStore, useInvoke, useTabsStore, type TabProps } from '@quiver/ui';
import { FolderOpen, PlugZap, Save } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { KindIcon } from './shared';

type AccessType = DbAccess['type'];

const ACCESS_LABELS: Record<AccessType, string> = {
  direct: 'Direct',
  teleport: 'Teleport tunnel (tsh proxy db)',
  command: 'Command tunnel (ssh and similar)',
};

export function ConnectionTab({ tab, scope }: TabProps) {
  const tabId = String(tab.data?.id ?? '');
  const isNew = tabId.startsWith('new-');
  const initialKind = DbKindSchema.safeParse(tab.data?.kind).data ?? 'mysql';
  const [conn, setConn] = useState<DbConnection | null>(isNew ? newDbConnection(initialKind, { name: '' }) : null);
  const [saved, setSaved] = useState<DbConnection | null>(null);
  const [hasPassword, setHasPassword] = useState(false);
  const [password, setPassword] = useState('');
  const [clearPassword, setClearPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const updateTab = useTabsStore((s) => s.updateTab);
  const workspacePath = useAppStore((s) => selectActiveWorkspace(s)?.path ?? '');

  useEffect(() => {
    if (isNew) return;
    let cancelled = false;
    invoke<DbConnectionSummary>('db.connection.get', { id: tabId })
      .then(({ hasPassword: hp, ...c }) => {
        if (cancelled) return;
        setConn(c);
        setSaved(c);
        setHasPassword(hp);
      })
      .catch((err) => !cancelled && setError(toErrorPayload(err).message));
    return () => {
      cancelled = true;
    };
  }, [tabId, isNew]);

  const dirty = useMemo(() => {
    if (!conn) return false;
    if (isNew) return true;
    return JSON.stringify(conn) !== JSON.stringify(saved) || password !== '' || clearPassword;
  }, [conn, saved, isNew, password, clearPassword]);

  useEffect(() => {
    if (tab.dirty !== dirty) updateTab(scope, tab.id, { dirty });
  }, [dirty, scope, tab.id, tab.dirty, updateTab]);

  const patch = (p: Partial<DbConnection>) => setConn((c) => (c ? { ...c, ...p } : c));

  const save = async () => {
    if (!conn) return;
    try {
      const name = conn.name.trim() || defaultName(conn);
      const stored = await invoke<DbConnectionSummary>('db.connection.save', {
        connection: { ...conn, name, ...(isNew ? { id: undefined } : {}) },
        password: password || undefined,
        clearPassword: clearPassword || undefined,
      });
      const { hasPassword: hp, ...c } = stored;
      setConn(c);
      setSaved(c);
      setHasPassword(hp);
      setPassword('');
      setClearPassword(false);
      updateTab(scope, tab.id, { title: c.name, data: { id: c.id } });
      notify('Connection saved', 'success');
    } catch (err) {
      notify(toErrorPayload(err).message, 'error');
    }
  };

  const test = async () => {
    if (!conn || testing) return;
    setTesting(true);
    setTestResult(null);
    try {
      const result = await invoke<DbConnectionTest>('db.connection.test', {
        connection: isNew ? { ...conn, id: undefined } : conn,
        password: password || (clearPassword ? '' : undefined),
      });
      setTestResult({ ok: true, message: `Connected to ${result.serverVersion} in ${result.latencyMs} ms` });
    } catch (err) {
      setTestResult({ ok: false, message: toErrorPayload(err).message });
    } finally {
      setTesting(false);
    }
  };

  const browseFile = async () => {
    const { path } = await invoke<{ path: string | null }>(
      'app.pickFile',
      { title: 'Choose SQLite database', defaultPath: workspacePath || undefined, filters: [{ name: 'SQLite', extensions: ['db', 'sqlite', 'sqlite3', 'db3'] }, { name: 'All files', extensions: ['*'] }] },
      null,
    );
    if (!path) return;
    patch({ file: relativeToWorkspace(path, workspacePath) });
  };

  if (error) return <div className="p-4 text-sm text-danger">{error}</div>;
  if (!conn)
    return (
      <div className="flex items-center justify-center h-full">
        <Spinner />
      </div>
    );

  const access = conn.access;
  const tunneled = access.type !== 'direct';

  return (
    <div
      className="flex flex-col h-full min-h-0"
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
          e.preventDefault();
          void save();
        }
      }}
    >
      <div className="flex items-center gap-2 px-3 py-2 border-b border-edge shrink-0">
        <KindIcon kind={conn.kind} className="size-4" />
        <Input value={conn.name} onChange={(e) => patch({ name: e.target.value })} className="w-64 h-7 font-medium" placeholder={`${DB_KIND_LABELS[conn.kind]} connection name`} autoFocus={isNew} />
        <div className="flex-1" />
        <Button size="sm" variant="ghost" icon={<PlugZap className="size-3.5" />} loading={testing} onClick={() => void test()}>
          Test
        </Button>
        <Button size="sm" variant={dirty ? 'primary' : 'ghost'} icon={<Save className="size-3.5" />} onClick={() => void save()} title="Ctrl+S">
          Save{dirty ? '*' : ''}
        </Button>
      </div>

      <div className="flex-1 overflow-auto p-4">
        <div className="max-w-xl flex flex-col gap-4">
          <div>
            <Label>Type</Label>
            <Select value={conn.kind} onChange={(e) => switchKind(e.target.value as DbKind)}>
              {DbKindSchema.options.map((k) => (
                <option key={k} value={k}>
                  {DB_KIND_LABELS[k]}
                </option>
              ))}
            </Select>
          </div>

          {conn.kind === 'sqlite' && (
            <>
              <div>
                <Label>Database file</Label>
                <div className="flex gap-2">
                  <Input className="font-mono" value={conn.file} onChange={(e) => patch({ file: e.target.value })} placeholder="data/app.db (relative to the project) or an absolute path" />
                  <Button variant="secondary" icon={<FolderOpen className="size-3.5" />} onClick={() => void browseFile()}>
                    Browse
                  </Button>
                </div>
                <p className="text-xs text-muted mt-1">A missing file is created on first connect. Relative paths keep the connection portable for teammates.</p>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={conn.readOnly} onChange={(e) => patch({ readOnly: e.target.checked })} /> Open read-only
              </label>
            </>
          )}

          {conn.kind !== 'sqlite' && (
            <>
              <div>
                <Label>Access</Label>
                <Select value={access.type} onChange={(e) => switchAccess(e.target.value as AccessType)} data-testid="db-access">
                  {(Object.keys(ACCESS_LABELS) as AccessType[]).map((t) => (
                    <option key={t} value={t}>
                      {ACCESS_LABELS[t]}
                    </option>
                  ))}
                </Select>
              </div>

              {access.type === 'teleport' && <TeleportAccessFields access={access} kind={conn.kind} onChange={(a) => patch({ access: a, user: conn.kind === 'mysql' ? a.dbUser : '' })} />}

              {access.type === 'command' && (
                <div>
                  <Label>Tunnel command</Label>
                  <Input className="font-mono" value={access.command} onChange={(e) => patch({ access: { type: 'command', command: e.target.value } })} placeholder="ssh -N -L {port}:db.internal:3306 bastion" />
                  <p className="text-xs text-muted mt-1">
                    <code className="font-mono">{'{port}'}</code> is replaced with a free local port. The command runs without a shell, is started before connecting and stopped on disconnect.
                  </p>
                </div>
              )}

              {!tunneled && (
                <div className="grid grid-cols-[1fr_120px] gap-2">
                  <div>
                    <Label>Host</Label>
                    <Input className="font-mono" value={conn.host} onChange={(e) => patch({ host: e.target.value })} placeholder="127.0.0.1" />
                  </div>
                  <div>
                    <Label>Port</Label>
                    <Input className="font-mono" type="number" value={conn.port || ''} onChange={(e) => patch({ port: Number(e.target.value) || 0 })} placeholder={String(defaultPort(conn.kind))} />
                  </div>
                </div>
              )}

              {access.type !== 'teleport' && (
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <Label>{conn.kind === 'redis' ? 'Username (ACL, optional)' : 'User'}</Label>
                    <Input className="font-mono" value={conn.user} onChange={(e) => patch({ user: e.target.value })} placeholder={conn.kind === 'redis' ? 'default' : 'root'} />
                  </div>
                  <div>
                    <Label>Password</Label>
                    <Input
                      type="password"
                      className="font-mono"
                      value={password}
                      disabled={clearPassword}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder={hasPassword && !clearPassword ? '•••••••• (stored, leave blank to keep)' : 'optional'}
                    />
                    {hasPassword && (
                      <label className="flex items-center gap-1.5 text-[11px] text-muted mt-1">
                        <Checkbox checked={clearPassword} onChange={(e) => setClearPassword(e.target.checked)} /> Remove stored password
                      </label>
                    )}
                  </div>
                </div>
              )}
              {conn.kind === 'mysql' && (
                <div>
                  <Label>Default database (optional)</Label>
                  <Input className="font-mono" value={conn.database} onChange={(e) => patch({ database: e.target.value })} placeholder="app" />
                </div>
              )}
              {conn.kind === 'redis' && (
                <div className="w-40">
                  <Label>Database index</Label>
                  <Input className="font-mono" type="number" min={0} value={conn.dbIndex} onChange={(e) => patch({ dbIndex: Math.max(0, Number(e.target.value) || 0) })} />
                </div>
              )}
              {access.type !== 'teleport' && (
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox checked={conn.ssl} onChange={(e) => patch({ ssl: e.target.checked })} /> Use TLS (self-signed certificates are accepted)
                </label>
              )}
            </>
          )}

          {testResult && (
            <div className={testResult.ok ? 'text-sm text-success' : 'text-sm text-danger break-words'} role="status">
              {testResult.message}
            </div>
          )}

          <p className="text-xs text-muted">
            Connection settings are saved in <code className="font-mono">.quiver/db-connections/</code> and can be committed. The password is encrypted with the OS keychain into
            <code className="font-mono"> .quiver/local/db-secrets.json</code>, which is gitignored, so each teammate enters their own.
            {access.type === 'teleport' && ' Teleport tunnels authenticate with your own certificate, so no password is needed.'}
          </p>
        </div>
      </div>
    </div>
  );

  function switchKind(kind: DbKind) {
    if (!conn || kind === conn.kind) return;
    patch({ kind, port: 0 });
    if (isNew) updateTab(scope, tab.id, { data: { ...tab.data, kind } });
  }

  function switchAccess(type: AccessType) {
    if (!conn || type === conn.access.type) return;
    if (type === 'direct') patch({ access: { type: 'direct' } });
    else if (type === 'teleport') patch({ access: { type: 'teleport', database: '', dbUser: conn.user }, host: '127.0.0.1', port: 0, user: conn.kind === 'mysql' ? conn.user : '' });
    else patch({ access: { type: 'command', command: '' }, host: '127.0.0.1', port: 0 });
  }
}

/** Teleport database name and user, with suggestions from `tsh db ls` when logged in. */
function TeleportAccessFields({ access, kind, onChange }: { access: Extract<DbAccess, { type: 'teleport' }>; kind: DbKind; onChange(access: Extract<DbAccess, { type: 'teleport' }>): void }) {
  const dbs = useInvoke<TeleportDatabase[]>('teleport.db.list', {}, { workspaceId: null, refreshOnEvents: ['teleport.changed'] });
  const match = dbs.data?.find((d) => d.name === access.database);
  const users = match?.allowedUsers.filter((u) => u !== '*') ?? [];
  const mismatch = match && match.protocol !== kind;
  return (
    <div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label>Teleport database</Label>
          <Input
            className="font-mono"
            list="teleport-db-names"
            value={access.database}
            onChange={(e) => {
              const database = e.target.value;
              const picked = dbs.data?.find((d) => d.name === database);
              const single = picked?.allowedUsers.filter((u) => u !== '*');
              onChange({ ...access, database, dbUser: access.dbUser || (single?.length === 1 ? single[0] : '') });
            }}
            placeholder="name from tsh db ls"
          />
          <datalist id="teleport-db-names">{dbs.data?.map((d) => <option key={d.name} value={d.name}>{`${d.protocol} · ${d.description || d.uri}`}</option>)}</datalist>
        </div>
        <div>
          <Label>Database user</Label>
          <Input className="font-mono" list="teleport-db-users" value={access.dbUser} onChange={(e) => onChange({ ...access, dbUser: e.target.value })} placeholder={users[0] ?? 'app'} />
          <datalist id="teleport-db-users">
            {users.map((u) => (
              <option key={u} value={u} />
            ))}
          </datalist>
        </div>
      </div>
      <p className="text-xs text-muted mt-1">
        {dbs.error
          ? `Suggestions unavailable: ${dbs.error.message}`
          : mismatch
            ? `Teleport reports this database as ${match.protocol}; pick the matching type above.`
            : 'Quiver starts tsh proxy db --tunnel on a free port and connects there. The tunnel is shared by every workspace.'}
      </p>
    </div>
  );
}

function defaultName(conn: DbConnection): string {
  if (conn.kind === 'sqlite') return `${DB_KIND_LABELS.sqlite} ${conn.file.split(/[\\/]/).pop() ?? ''}`.trim();
  if (conn.access.type === 'teleport') return conn.access.database || `${DB_KIND_LABELS[conn.kind]} via Teleport`;
  if (conn.access.type === 'command') return `${DB_KIND_LABELS[conn.kind]} tunnel`;
  return `${DB_KIND_LABELS[conn.kind]} ${conn.host}`;
}

function relativeToWorkspace(file: string, workspacePath: string): string {
  if (!workspacePath) return file;
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
  const f = norm(file);
  const w = norm(workspacePath);
  const same = navigator.platform.startsWith('Win') ? f.toLowerCase().startsWith(`${w.toLowerCase()}/`) : f.startsWith(`${w}/`);
  return same ? f.slice(w.length + 1) : file;
}
