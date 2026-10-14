import { Component, inject, input, output, signal } from '@angular/core';
import type { EnvBackup, EnvFileContent } from '@quiver/core';
import { Button, Dialogs, EmptyState, HostBridge, Spinner, Toasts, formatBytes, invokeResource } from '@quiver/ui';
import { RotateCcw } from 'lucide';

/** The previous contents Quiver kept of this file, newest first, each one restorable. */
@Component({
  selector: 'q-env-history-view',
  imports: [Button, EmptyState, Spinner],
  template: `
    @if (backups.isLoading() && !backups.value()) {
      <div class="p-3"><svg qSpinner></svg></div>
    } @else if (!backups.value()?.length) {
      <q-empty-state title="No backups yet" hint="Every change Quiver makes to this file keeps the previous content here (the last 20), including profile switches and deletes." />
    } @else {
      <div class="h-full overflow-auto" data-testid="env-history">
        <table class="w-full text-[12.5px] border-collapse">
          <thead class="sticky top-0 bg-canvas">
            <tr class="text-[11px] uppercase tracking-wide text-muted text-left">
              <th class="px-3 py-1.5 font-medium">Kept</th>
              <th class="px-2 py-1.5 font-medium">Before</th>
              <th class="px-2 py-1.5 font-medium w-20">Size</th>
              <th class="px-2 py-1.5 w-24"></th>
            </tr>
          </thead>
          <tbody>
            @for (b of backups.value(); track b.id) {
              <tr class="border-t border-edge/60 hover:bg-elevated/60" data-testid="env-backup">
                <td class="px-3 py-1 whitespace-nowrap">{{ at(b) }}</td>
                <td class="px-2 py-1 text-muted">{{ b.reason }}</td>
                <td class="px-2 py-1 text-muted">{{ formatBytes(b.size) }}</td>
                <td class="px-2 py-1 text-right">
                  <button qButton size="sm" variant="ghost" [icon]="restoreIcon" iconClass="size-3" [loading]="busy() === b.id" class="h-6 text-[11px]" (click)="restore(b)">Restore</button>
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    }
  `,
  host: { class: 'contents' },
})
export class EnvHistoryView {
  private readonly host = inject(HostBridge);
  private readonly dialogs = inject(Dialogs);
  private readonly toasts = inject(Toasts);

  readonly content = input.required<EnvFileContent>();
  readonly changed = output<void>();

  protected readonly restoreIcon = RotateCcw;
  protected readonly formatBytes = formatBytes;
  protected readonly backups = invokeResource<EnvBackup[]>('env.backup.list', () => ({ path: this.content().path }), { refreshOnEvents: ['env.changed'] });
  protected readonly busy = signal<string | null>(null);

  protected at(backup: EnvBackup): string {
    return new Date(backup.at).toLocaleString();
  }

  protected async restore(backup: EnvBackup): Promise<void> {
    if (!(await this.dialogs.confirm({ title: `Restore the version from ${this.at(backup)}?`, message: 'The current content is kept as a new backup.', confirmLabel: 'Restore' }))) return;
    this.busy.set(backup.id);
    try {
      await this.host.invoke('env.backup.restore', { path: this.content().path, id: backup.id });
      this.toasts.notify('Restored', 'success');
      this.changed.emit();
      this.backups.reload();
    } catch (err) {
      this.toasts.error(err);
    } finally {
      this.busy.set(null);
    }
  }
}
