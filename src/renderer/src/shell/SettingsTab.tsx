import type { GlobalConfig, TeleportStatus, Variable } from '@quiver/core';
import { Button, Checkbox, Input, KeyValueEditor, Label, Select, applyTheme, cn, invoke, notify, useAppStore, useInvoke, type TabProps } from '@quiver/ui';
import { Copy } from 'lucide-react';
import { useEffect, useState } from 'react';

export function SettingsTab(_props: TabProps) {
  const config = useAppStore((s) => s.config);
  const mcp = useAppStore((s) => s.mcpStatus);
  const [globals, setGlobals] = useState<Variable[]>([]);
  const [port, setPort] = useState(0);
  const [teleportProxy, setTeleportProxy] = useState('');
  const [tshPath, setTshPath] = useState('');
  const teleport = useInvoke<TeleportStatus>('teleport.status', {}, { workspaceId: null, refreshOnEvents: ['teleport.changed'] });

  useEffect(() => {
    if (config) {
      setGlobals(config.globalVariables);
      setPort(config.mcp.port);
      setTeleportProxy(config.teleport.proxy);
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
            Quiver drives the <code className="font-mono">tsh</code> CLI and shares its session with the tsh and kubectl in your terminal. Databases and Kubernetes clusters
            appear in the Teleport module; tunnels are app-wide.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Proxy address</Label>
              <Input
                className="font-mono"
                value={teleportProxy}
                placeholder="teleport.example.com:443"
                onChange={(e) => setTeleportProxy(e.target.value)}
                onBlur={() => teleportProxy.trim() !== config.teleport.proxy && void update({ teleport: { ...config.teleport, proxy: teleportProxy.trim() } })}
                data-testid="teleport-proxy"
              />
            </div>
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
            Log in on launch when the certificate has expired (opens the browser)
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
      </div>
    </div>
  );
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
