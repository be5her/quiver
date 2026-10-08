import { Component, booleanAttribute, computed, inject, input, output } from '@angular/core';
import { kubeOperationInfo, type ErrorPayload, type KubeHistoryEntry } from '@quiver/core';
import { Dialogs, HostBridge, Icon, IconButton, Toasts } from '@quiver/ui';
import { Play, Star, Trash2 } from 'lucide';
import { DbError } from '../../db/ui';
import { ago, summarizeQuery } from './kube-query-model';

type HistoryItem = { key: string; heading: string; entry?: undefined } | { key: string; entry: KubeHistoryEntry; heading?: undefined };

/** The queries run on this cluster, favourites first; click one to fill the form, or run it again. */
@Component({
  selector: 'aside[qKubeHistory]',
  imports: [DbError, Icon, IconButton],
  templateUrl: './kube-history-panel.html',
  host: { class: 'w-72 shrink-0 border-l border-edge flex flex-col min-h-0', 'data-testid': 'kube-history' },
})
export class KubeHistoryPanel {
  private readonly host = inject(HostBridge);
  private readonly dialogs = inject(Dialogs);
  private readonly toasts = inject(Toasts);

  readonly entries = input.required<KubeHistoryEntry[]>();
  readonly error = input<ErrorPayload | null>(null);
  readonly loading = input(false, { transform: booleanAttribute });
  readonly proxy = input.required<string>();
  readonly cluster = input.required<string>();
  /** A run is in progress, so "Run again" waits. */
  readonly busy = input(false, { transform: booleanAttribute });
  readonly fill = output<KubeHistoryEntry>();
  readonly rerun = output<KubeHistoryEntry>();
  readonly reload = output<void>();

  protected readonly icons = { Play, Star, Trash2 };
  protected readonly ago = ago;
  protected readonly recent = computed(() => this.entries().filter((e) => !e.pinned));
  /** Favourites, then the rest; the headings show only when there are favourites. */
  protected readonly items = computed<HistoryItem[]>(() => {
    const pinned = this.entries().filter((e) => e.pinned);
    const recent = this.recent();
    if (!pinned.length) return recent.map((entry) => ({ key: entry.id, entry }));
    return [
      { key: 'favourites', heading: 'Favourites' },
      ...pinned.map((entry) => ({ key: entry.id, entry })),
      ...(recent.length ? [{ key: 'recent', heading: 'Recent' }, ...recent.map((entry) => ({ key: entry.id, entry }))] : []),
    ];
  });

  protected title(entry: KubeHistoryEntry): string {
    return kubeOperationInfo(entry.query.operation)?.title ?? entry.query.operation;
  }

  protected summary(entry: KubeHistoryEntry): string {
    return summarizeQuery(entry.query) || '—';
  }

  protected dotClass(entry: KubeHistoryEntry): string {
    return entry.exitCode === 0 ? 'bg-success' : entry.exitCode === null ? 'bg-muted' : 'bg-danger';
  }

  protected runAgain(event: MouseEvent, entry: KubeHistoryEntry): void {
    event.stopPropagation();
    this.rerun.emit(entry);
  }

  protected togglePin(event: MouseEvent, entry: KubeHistoryEntry): void {
    event.stopPropagation();
    this.host.invoke('teleport.kube.history.pin', { id: entry.id }, null).catch((err) => this.toasts.error(err));
  }

  protected remove(event: MouseEvent, entry: KubeHistoryEntry): void {
    event.stopPropagation();
    this.host.invoke('teleport.kube.history.delete', { id: entry.id }, null).catch((err) => this.toasts.error(err));
  }

  protected async clear(): Promise<void> {
    const ok = await this.dialogs.confirm({
      title: `Clear the history of ${this.cluster()}?`,
      message: 'Favourites stay. The history lives only on this machine.',
      confirmLabel: 'Clear',
      danger: true,
    });
    if (!ok) return;
    await this.host.invoke('teleport.kube.history.clear', { proxy: this.proxy(), cluster: this.cluster() }, null).catch((err) => this.toasts.error(err));
  }
}
