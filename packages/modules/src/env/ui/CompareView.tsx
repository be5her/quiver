import { toErrorPayload, type EnvDiff, type EnvFileContent, type EnvFileSummary } from '@quiver/core';
import { Button, EmptyState, Label, Select, Spinner, cn, invoke, notify, useInvoke } from '@quiver/ui';
import { Plus } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

/** Pick the most useful file to compare with: an example in the same folder, else `.env`, else any sibling. */
function defaultAgainst(content: EnvFileContent, files: EnvFileSummary[]): string {
  const sameDir = files.filter((f) => f.dir === content.dir);
  if (content.kind !== 'example') {
    const example = sameDir.find((f) => f.kind === 'example');
    if (example) return example.path;
  }
  const main = sameDir.find((f) => f.kind === 'main');
  if (main) return main.path;
  return sameDir[0]?.path ?? files[0]?.path ?? '';
}

export function CompareView({ content, files, onChanged }: { content: EnvFileContent; files: EnvFileSummary[]; onChanged(): Promise<void> }) {
  const [against, setAgainst] = useState<string>('');
  const [busy, setBusy] = useState<string | null>(null);
  const initial = useMemo(() => defaultAgainst(content, files), [content, files]);
  const chosen = against && files.some((f) => f.path === against) ? against : initial;
  const diff = useInvoke<EnvDiff>('env.file.diff', { path: content.path, against: chosen }, { enabled: Boolean(chosen), refreshOnEvents: ['env.changed'] });

  useEffect(() => {
    if (!against && initial) setAgainst(initial);
  }, [against, initial]);

  const add = async (keys?: string[]) => {
    setBusy(keys ? keys.join(',') : '*');
    try {
      const out = await invoke<{ added: string[] }>('env.file.sync', { path: content.path, from: chosen, ...(keys ? { keys } : {}) });
      notify(out.added.length ? `Added ${out.added.join(', ')}` : 'Nothing to add', out.added.length ? 'success' : 'info');
      await onChanged();
      await diff.refresh();
    } catch (err) {
      notify(toErrorPayload(err).message, 'error');
    } finally {
      setBusy(null);
    }
  };

  if (!files.length) return <EmptyState title="Nothing to compare with" hint="Add another env file, for example .env.example, to see which keys are missing here." />;

  return (
    <div className="flex flex-col h-full min-h-0" data-testid="env-compare">
      <div className="flex items-end gap-2 px-3 py-2 border-b border-edge shrink-0">
        <div>
          <Label>Compare {content.name} with</Label>
          <Select value={chosen} onChange={(e) => setAgainst(e.target.value)} className="h-7 text-xs font-mono" data-testid="env-compare-select">
            {files.map((f) => (
              <option key={f.path} value={f.path}>
                {f.path}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex-1" />
        {diff.data && diff.data.missing.length > 0 && (
          <Button size="sm" variant="primary" icon={<Plus className="size-3.5" />} loading={busy === '*'} onClick={() => void add()} data-testid="env-compare-add-all">
            Add all {diff.data.missing.length} missing
          </Button>
        )}
      </div>
      <div className="flex-1 min-h-0 overflow-auto p-3 flex flex-col gap-4 text-sm">
        {diff.loading && !diff.data && <Spinner />}
        {diff.error && <p className="text-xs text-danger">{diff.error.message}</p>}
        {diff.data && (
          <>
            <KeyList
              title={`Missing here (${diff.data.missing.length})`}
              hint={`Defined in ${diff.data.against} but not in ${content.name}.`}
              keys={diff.data.missing}
              tone="danger"
              testId="env-compare-missing"
              action={(key) => (
                <Button size="sm" variant="ghost" icon={<Plus className="size-3" />} loading={busy === key} onClick={() => void add([key])} className="h-6 text-[11px]">
                  Add
                </Button>
              )}
            />
            <KeyList title={`Empty here (${diff.data.empty.length})`} hint="Present in both, but without a value in this file." keys={diff.data.empty} tone="warning" testId="env-compare-empty" />
            <KeyList title={`Only here (${diff.data.extra.length})`} hint={`Not in ${diff.data.against}. Maybe the example is out of date.`} keys={diff.data.extra} tone="muted" testId="env-compare-extra" />
            <KeyList title={`Different values (${diff.data.different.length})`} hint="Present in both with different values (expected for placeholders)." keys={diff.data.different} tone="muted" testId="env-compare-different" />
            <p className="text-xs text-muted">{diff.data.same.length} keys have the same value in both files.</p>
          </>
        )}
      </div>
    </div>
  );
}

function KeyList({ title, hint, keys, tone, testId, action }: { title: string; hint: string; keys: string[]; tone: 'danger' | 'warning' | 'muted'; testId: string; action?: (key: string) => React.ReactNode }) {
  return (
    <section data-testid={testId}>
      <h3 className={cn('text-xs font-semibold', tone === 'danger' && keys.length ? 'text-danger' : tone === 'warning' && keys.length ? 'text-warning' : 'text-muted')}>{title}</h3>
      <p className="text-[11px] text-muted mb-1">{hint}</p>
      {keys.length === 0 ? (
        <p className="text-[11px] text-muted/70">None.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-edge/60 border border-edge rounded-md">
          {keys.map((key) => (
            <li key={key} className="flex items-center justify-between px-2 h-7 font-mono text-xs">
              <span>{key}</span>
              {action?.(key)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
