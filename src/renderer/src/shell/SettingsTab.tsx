import { PALETTES, resolvePalette, type GlobalConfig, type TeleportStatus, type UpdateState, type Variable } from '@quiver/core';
import { Button, Checkbox, Input, KeyValueEditor, Label, Select, applyTheme, cn, invoke, notify, useAppStore, useInvoke, type TabProps } from '@quiver/ui';
import { Copy, Download, ExternalLink, RotateCw, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { QuiverMark } from './Logo';
import { checkForUpdates, downloadUpdate, installUpdate, openExternal } from './updates';

const RELEASES_URL = 'https://github.com/be5her/quiver/releases';
const ISSUES_URL = 'https://github.com/be5her/quiver/issues';
const PLATFORM_NAMES: Record<string, string> = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };

export function SettingsTab(_props: TabProps) {
  const config = useAppStore((s) => s.config);
  const mcp = useAppStore((s) => s.mcpStatus);
  const [globals, setGlobals] = useState<Variable[]>([]);
  const [port, setPort] = useState(0);
  const [newProxy, setNewProxy] = useState('');
  const [tshPath, setTshPath] = useState('');
  const teleport = useInvoke<TeleportStatus>('teleport.status', {}, { workspaceId: null, refreshOnEvents: ['teleport.changed'] });

  useEffect(() => {
    if (config) {
      setGlobals(config.globalVariables);
      setPort(config.mcp.port);
      setTshPath(config.teleport.tshPath);
    }
  }, [config]);

  if (!config) return null;

  const update = async (patch: Partial<GlobalConfig>) => {
    try {
      await invoke('config.update', { patch }, null);
    } catch (err) {
      notify((err as Error).message, 'error');
    }
  };

  const addProxy = async () => {
    const proxy = newProxy.trim();
    if (!proxy) return;
    try {
      await invoke('teleport.cluster.add', { proxy }, null);
      setNewProxy('');
    } catch (err) {
      notify((err as Error).message, 'error');
    }
  };

  const httpUrl = `http://127.0.0.1:${config.mcp.port}/mcp`;
  const snippet = `claude mcp add --transport http quiver "${httpUrl}"`;

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="max-w-2xl flex flex-col gap-8">
        <Section title="Appearance">
          <Label>Theme</Label>
          <Select
            value={config.theme}
            onChange={(e) => {
              const theme = e.target.value as GlobalConfig['theme'];
              applyTheme(theme);
              void update({ theme });
            }}
            className="w-48"
          >
            <option value="system">Follow system</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </Select>
          <Label className="mt-4">Palette</Label>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Palette">
            {PALETTES.map((palette) => {
              const selected = resolvePalette(config.palette).key === palette.key;
              return (
                <button
                  key={palette.key}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  data-testid="palette-option"
                  data-palette={palette.key}
                  onClick={() => {
                    applyTheme(config.theme, palette.key);
                    void update({ palette: palette.key });
                  }}
                  className={cn(
                    'flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs hover:bg-elevated',
                    selected ? 'border-accent bg-elevated text-fg' : 'border-edge text-muted',
                  )}
                >
                  <span className="flex size-4 items-center justify-center rounded" style={{ background: palette.brand.ground }}>
                    <span className="size-2 rounded-full" style={{ background: palette.brand.accent }} />
                  </span>
                  {palette.name}
                </button>
              );
            })}
          </div>
        </Section>

        <Section title="MCP server">
          <p className="text-xs text-muted mb-3">
            Every non-hidden command is exposed as an MCP tool over Streamable HTTP. Add <code className="font-mono">?workspace=&lt;folder&gt;</code> to the URL to bind a
            client to a specific project, otherwise it follows the workspace you are viewing.
          </p>
          <div className="flex items-center gap-4 flex-wrap">
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={config.mcp.enabled} onChange={(e) => void update({ mcp: { ...config.mcp, enabled: e.target.checked } })} />
              Enabled
            </label>
            <label className="flex items-center gap-2 text-sm">
              Port
              <Input type="number" className="w-24" value={port} onChange={(e) => setPort(Number(e.target.value))} onBlur={() => port !== config.mcp.port && void update({ mcp: { ...config.mcp, port } })} />
            </label>
            <label className="flex items-center gap-2 text-sm" title="Lets agents run commands that delete data or send mutating database statements">
              <Checkbox checked={config.mcp.allowMutating} onChange={(e) => void update({ mcp: { ...config.mcp, allowMutating: e.target.checked } })} />
              Allow mutating commands
            </label>
            <span className={cn('text-xs', mcp?.running ? 'text-success' : 'text-danger')}>{mcp?.running ? `running on ${mcp.port}` : (mcp?.error ?? 'stopped')}</span>
          </div>
          <div className="mt-3">
            <Label>Claude Code</Label>
            <CopyRow text={snippet} />
          </div>
          <div className="mt-2">
            <Label>Generic HTTP endpoint</Label>
            <CopyRow text={httpUrl} />
          </div>
        </Section>

        <Section title="Teleport">
          <p className="text-xs text-muted mb-3">
            Quiver drives the <code className="font-mono">tsh</code> CLI and shares its profiles with the tsh and kubectl in your terminal. Each cluster is a proxy address; clusters
            you have logged into with tsh appear on their own. Databases, Kubernetes clusters and pins live in the Teleport module; tunnels are app-wide.
          </p>
          <Label>Clusters</Label>
          <div className="flex flex-col gap-1 mb-2">
            {config.teleport.proxies.map((proxy) => (
              <div key={proxy} className="flex items-center gap-2" data-testid="teleport-proxy">
                <code className="flex-1 text-xs font-mono bg-surface border border-edge rounded-md px-2 py-1.5 truncate">{proxy}</code>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<X className="size-3.5" />}
                  onClick={() => void invoke('teleport.cluster.remove', { proxy }, null).catch((err) => notify((err as Error).message, 'error'))}
                  title="Remove this cluster and its pins"
                >
                  Remove
                </Button>
              </div>
            ))}
            {config.teleport.proxies.length === 0 && <p className="text-xs text-muted">No clusters configured.</p>}
            <div className="flex items-center gap-2">
              <Input
                className="font-mono"
                value={newProxy}
                placeholder="teleport.example.com:443"
                onChange={(e) => setNewProxy(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void addProxy()}
              />
              <Button size="sm" variant="secondary" disabled={!newProxy.trim()} onClick={() => void addProxy()}>
                Add
              </Button>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>tsh path (optional)</Label>
              <Input
                className="font-mono"
                value={tshPath}
                placeholder="found on PATH or in Teleport Connect"
                onChange={(e) => setTshPath(e.target.value)}
                onBlur={() => tshPath.trim() !== config.teleport.tshPath && void update({ teleport: { ...config.teleport, tshPath: tshPath.trim() } })}
              />
            </div>
          </div>
          <p className="text-[11px] text-muted mt-1 font-mono truncate" title={teleport.data?.tsh?.join(' ')}>
            {teleport.data?.tsh
              ? `using ${teleport.data.tsh.join(' ')}${teleport.data.tshVersion ? ` (v${teleport.data.tshVersion})` : ''}`
              : teleport.data
                ? 'tsh not found'
                : ''}
          </p>
          <label className="flex items-center gap-2 text-sm mt-3">
            <Checkbox checked={config.teleport.loginOnLaunch} onChange={(e) => void update({ teleport: { ...config.teleport, loginOnLaunch: e.target.checked } })} />
            Log in on launch to every cluster whose certificate has expired (opens the browser, one cluster at a time)
          </label>
        </Section>

        <Section title="Global variables">
          <p className="text-xs text-muted mb-2">Available in every workspace as {'{{name}}'}. Workspace environments override them. Do not put secrets here.</p>
          <KeyValueEditor rows={globals} onChange={setGlobals} keyPlaceholder="Variable" />
          <div className="mt-2">
            <Button
              size="sm"
              variant="primary"
              disabled={JSON.stringify(globals) === JSON.stringify(config.globalVariables)}
              onClick={() => void update({ globalVariables: globals }).then(() => notify('Global variables saved', 'success'))}
            >
              Save variables
            </Button>
          </div>
        </Section>

        <Section title="About">
          <AboutPanel />
        </Section>
      </div>
    </div>
  );
}

function AboutPanel() {
  const update = useAppStore((s) => s.update);
  const [checking, setChecking] = useState(false);
  const version = update?.current ?? window.quiver.version;
  const platform = PLATFORM_NAMES[window.quiver.platform] ?? window.quiver.platform;
  const check = async () => {
    setChecking(true);
    try {
      await checkForUpdates();
    } finally {
      setChecking(false);
    }
  };
  const hasRelease = update?.status === 'available' || update?.status === 'downloaded';
  return (
    <div className="flex items-start gap-4">
      <QuiverMark className="size-14 shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold" data-testid="about-version">
          Quiver {version}
        </p>
        <p className="text-xs text-muted mt-0.5">
          {platform} ·{' '}
          <button type="button" className="underline hover:text-fg" onClick={() => openExternal(RELEASES_URL)}>
            Releases
          </button>{' '}
          ·{' '}
          <button type="button" className="underline hover:text-fg" onClick={() => openExternal(ISSUES_URL)}>
            Report an issue
          </button>
        </p>
        <div className="flex items-center gap-2 mt-3 flex-wrap">
          <Button
            size="sm"
            variant="secondary"
            icon={<RotateCw className="size-3.5" />}
            loading={checking || update?.status === 'checking'}
            disabled={!update?.supported}
            onClick={() => void check()}
            data-testid="update-check"
          >
            Check for updates
          </Button>
          {update?.status === 'available' && update.installable && (
            <Button size="sm" variant="primary" icon={<Download className="size-3.5" />} onClick={() => void downloadUpdate()}>
              Download {update.version}
            </Button>
          )}
          {update?.status === 'available' && !update.installable && (
            <Button size="sm" variant="primary" icon={<ExternalLink className="size-3.5" />} onClick={() => openExternal(update.url)}>
              Get {update.version} from GitHub
            </Button>
          )}
          {update?.status === 'downloaded' && (
            <Button size="sm" variant="primary" icon={<RotateCw className="size-3.5" />} onClick={() => void installUpdate()}>
              Restart to install {update.version}
            </Button>
          )}
          {hasRelease && (
            <Button size="sm" variant="ghost" onClick={() => openExternal(update?.url)}>
              Release notes
            </Button>
          )}
        </div>
        <p className={cn('text-xs mt-2', update?.status === 'error' ? 'text-danger' : 'text-muted')} data-testid="update-note">
          {describeUpdate(update)}
        </p>
        {update?.status === 'downloading' && (
          <div className="h-1 mt-2 rounded bg-elevated overflow-hidden max-w-xs">
            <div className="h-full bg-accent transition-[width]" style={{ width: `${update.progress?.percent ?? 0}%` }} />
          </div>
        )}
      </div>
    </div>
  );
}

function describeUpdate(update: UpdateState | null): string {
  if (!update) return '';
  if (!update.supported) return update.reason ?? 'Updates are not available in this build.';
  const when = update.checkedAt ? ` Checked at ${new Date(update.checkedAt).toLocaleTimeString()}.` : '';
  switch (update.status) {
    case 'idle':
      return 'Quiver looks for a new release shortly after launch and every six hours. Nothing is downloaded until you ask.';
    case 'checking':
      return 'Checking GitHub Releases…';
    case 'none':
      return `You are on the latest version.${when}`;
    case 'available':
      return `Quiver ${update.version} is available.${update.installable ? ' Download it here; it installs when you restart.' : ` ${update.reason ?? ''}`}`;
    case 'downloading': {
      const rate = update.progress?.bytesPerSecond ? ` at ${(update.progress.bytesPerSecond / 1048576).toFixed(1)} MB/s` : '';
      return `Downloading Quiver ${update.version}: ${update.progress?.percent ?? 0}%${rate}`;
    }
    case 'downloaded':
      return `Quiver ${update.version} is downloaded and installs on the next restart.`;
    case 'error':
      return `${update.error ?? 'The update check failed.'}${when}`;
  }
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-sm font-semibold mb-3 pb-1 border-b border-edge">{title}</h2>
      {children}
    </section>
  );
}

function CopyRow({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-2">
      <code className="flex-1 text-xs font-mono bg-surface border border-edge rounded-md px-2 py-1.5 truncate">{text}</code>
      <Button size="sm" variant="ghost" icon={<Copy className="size-3.5" />} onClick={() => navigator.clipboard.writeText(text).then(() => notify('Copied', 'success'))}>
        Copy
      </Button>
    </div>
  );
}
