import { toErrorPayload, type EnvBackup, type EnvFileContent } from '@quiver/core';
import { Button, EmptyState, Spinner, confirmDialog, formatBytes, invoke, notify, useInvoke } from '@quiver/ui';
import { RotateCcw } from 'lucide-react';
import { useState } from 'react';

export function HistoryView({ content, onChanged }: { content: EnvFileContent; onChanged(): Promise<void> }) {
  const backups = useInvoke<EnvBackup[]>('env.backup.list', { path: content.path }, { refreshOnEvents: ['env.changed'] });
  const [busy, setBusy] = useState<string | null>(null);

  const restore = async (backup: EnvBackup) => {
    if (!(await confirmDialog({ title: `Restore the version from ${new Date(backup.at).toLocaleString()}?`, message: 'The current content is kept as a new backup.', confirmLabel: 'Restore' }))) return;
    setBusy(backup.id);
    try {
      await invoke('env.backup.restore', { path: content.path, id: backup.id });
      notify('Restored', 'success');
      await onChanged();
      await backups.refresh();
    } catch (err) {
      notify(toErrorPayload(err).message, 'error');
    } finally {
      setBusy(null);
    }
  };

  if (backups.loading && !backups.data)
    return (
      <div className="p-3">
        <Spinner />
      </div>
    );
  if (!backups.data?.length) return <EmptyState title="No backups yet" hint="Every change Quiver makes to this file keeps the previous content here (the last 20), including profile switches and deletes." />;

  return (
    <div className="h-full overflow-auto" data-testid="env-history">
      <table className="w-full text-[12.5px] border-collapse">
        <thead className="sticky top-0 bg-canvas">
          <tr className="text-[11px] uppercase tracking-wide text-muted text-left">
            <th className="px-3 py-1.5 font-medium">Kept</th>
            <th className="px-2 py-1.5 font-medium">Before</th>
            <th className="px-2 py-1.5 font-medium w-20">Size</th>
            <th className="px-2 py-1.5 w-24" />
          </tr>
        </thead>
        <tbody>
          {backups.data.map((b) => (
            <tr key={b.id} className="border-t border-edge/60 hover:bg-elevated/60" data-testid="env-backup">
              <td className="px-3 py-1 whitespace-nowrap">{new Date(b.at).toLocaleString()}</td>
              <td className="px-2 py-1 text-muted">{b.reason}</td>
              <td className="px-2 py-1 text-muted">{formatBytes(b.size)}</td>
              <td className="px-2 py-1 text-right">
                <Button size="sm" variant="ghost" icon={<RotateCcw className="size-3" />} loading={busy === b.id} onClick={() => void restore(b)} className="h-6 text-[11px]">
                  Restore
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
