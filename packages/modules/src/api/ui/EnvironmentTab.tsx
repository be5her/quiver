import { toErrorPayload, type Environment, type Variable } from '@quiver/core';
import { Button, Checkbox, Input, KeyValueEditor, Spinner, invoke, notify, useTabsStore, type TabProps } from '@quiver/ui';
import { Save } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

export function EnvironmentTab({ tab, scope }: TabProps) {
  const id = String(tab.data?.id ?? '');
  const [env, setEnv] = useState<Environment | null>(null);
  const [saved, setSaved] = useState<Environment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const updateTab = useTabsStore((s) => s.updateTab);

  useEffect(() => {
    let cancelled = false;
    invoke<Environment>('api.environment.get', { id })
      .then((e) => {
        if (cancelled) return;
        setEnv(e);
        setSaved(e);
      })
      .catch((err) => !cancelled && setError(toErrorPayload(err).message));
    return () => {
      cancelled = true;
    };
  }, [id]);

  const dirty = useMemo(() => JSON.stringify(env) !== JSON.stringify(saved), [env, saved]);
  useEffect(() => {
    if (tab.dirty !== dirty) updateTab(scope, tab.id, { dirty });
  }, [dirty, scope, tab.id, tab.dirty, updateTab]);

  const save = async () => {
    if (!env) return;
    try {
      const stored = await invoke<Environment>('api.environment.save', { environment: env });
      setEnv(stored);
      setSaved(stored);
      updateTab(scope, tab.id, { title: `Env: ${stored.name}` });
      notify('Environment saved', 'success');
    } catch (err) {
      notify(toErrorPayload(err).message, 'error');
    }
  };

  if (error) return <div className="p-4 text-sm text-danger">{error}</div>;
  if (!env)
    return (
      <div className="flex items-center justify-center h-full">
        <Spinner />
      </div>
    );

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
        <Input value={env.name} onChange={(e) => setEnv({ ...env, name: e.target.value })} className="w-56 h-7 font-medium" placeholder="Environment name" />
        <div className="flex-1" />
        <Button size="sm" variant={dirty ? 'primary' : 'ghost'} icon={<Save className="size-3.5" />} onClick={() => void save()}>
          Save{dirty ? '*' : ''}
        </Button>
      </div>
      <div className="flex-1 overflow-auto p-3">
        <KeyValueEditor<Variable>
          rows={env.variables}
          onChange={(variables) => setEnv({ ...env, variables })}
          keyPlaceholder="Variable"
          valuePlaceholder="Value"
          extraHeader="Secret"
          extra={(row, update) => (
            <label className="flex items-center gap-1 text-[11px] text-muted" title="Stored encrypted on this machine, never committed">
              <Checkbox checked={Boolean(row.secret)} onChange={(e) => update({ secret: e.target.checked })} />
            </label>
          )}
        />
        <p className="text-xs text-muted mt-3 max-w-lg">
          Use variables as <code className="font-mono">{'{{name}}'}</code> in URLs, headers, bodies and auth fields. Secret values live in
          <code className="font-mono"> .quiver/local/secrets.json</code>, encrypted by the OS keychain, and are masked for MCP clients.
        </p>
      </div>
    </div>
  );
}
