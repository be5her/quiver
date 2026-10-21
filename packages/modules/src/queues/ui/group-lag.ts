import { Component, computed, input, signal } from '@angular/core';
import type { QueueConsumerGroup } from '@quiver/core';
import { Badge, Icon, IconButton, Spinner, invokeResource } from '@quiver/ui';
import { ChevronDown, ChevronRight, RefreshCw } from 'lucide';

interface GroupRow {
  group: QueueConsumerGroup;
  lag: QueueConsumerGroup['lag'];
  total: number;
}

/** Kafka consumer groups with their state, members and lag per partition; with `topic`, only the groups reading it. */
@Component({
  selector: 'q-queues-group-lag',
  imports: [Badge, Icon, IconButton, Spinner],
  template: `
    <div class="flex items-center gap-2 px-3 h-9 border-b border-edge shrink-0">
      <span class="text-xs text-muted">{{ topic() ? 'Groups reading ' + topic() : 'Every consumer group' }} · Quiver's own peek and tail groups are left out</span>
      <span class="flex-1"></span>
      @if (groups.isLoading()) {
        <svg qSpinner></svg>
      }
      <button qIconButton label="Refresh" size="sm" data-testid="queues-groups-refresh" (click)="groups.reload()"><svg [qIcon]="icons.RefreshCw" class="size-3.5"></svg></button>
    </div>
    <div class="flex-1 min-h-0 overflow-auto" data-testid="queues-groups">
      @if (groups.error(); as error) {
        <p class="p-3 text-xs text-danger">{{ error.message }}</p>
      }
      @for (row of rows(); track row.group.id) {
        @let open = expanded().has(row.group.id);
        <button type="button" class="w-full flex items-center gap-2 px-3 h-8 border-b border-edge/60 hover:bg-elevated text-left" data-testid="queues-group" [attr.data-group]="row.group.id" (click)="toggle(row.group.id)">
          <svg [qIcon]="open ? icons.ChevronDown : icons.ChevronRight" class="size-3.5 text-muted shrink-0"></svg>
          <span class="font-mono text-xs truncate flex-1">{{ row.group.id }}</span>
          <span qBadge [class]="stateClass(row.group.state)">{{ row.group.state }}</span>
          <span class="text-[11px] text-muted w-24 text-right">{{ row.group.members }} member{{ row.group.members === 1 ? '' : 's' }}</span>
          <span class="text-xs font-mono w-24 text-right" [class]="row.total > 0 ? 'text-warning' : 'text-success'" data-testid="queues-group-lag">lag {{ row.total }}</span>
        </button>
        @if (open) {
          <table class="w-full text-xs border-b border-edge">
            <thead class="text-muted text-[11px]">
              <tr>
                <th class="text-left font-normal pl-9 py-1">Topic</th>
                <th class="text-right font-normal py-1">Partition</th>
                <th class="text-right font-normal py-1">Committed</th>
                <th class="text-right font-normal py-1">End</th>
                <th class="text-right font-normal py-1 pr-3">Lag</th>
              </tr>
            </thead>
            <tbody class="font-mono">
              @for (l of row.lag; track l.topic + ':' + l.partition) {
                <tr class="border-t border-edge/40">
                  <td class="pl-9 py-0.5 truncate">{{ l.topic }}</td>
                  <td class="text-right">{{ l.partition }}</td>
                  <td class="text-right">{{ l.offset }}</td>
                  <td class="text-right">{{ l.end }}</td>
                  <td class="text-right pr-3" [class.text-warning]="l.lag > 0">{{ l.lag }}</td>
                </tr>
              }
            </tbody>
          </table>
        }
      }
      @if (groups.value() && rows().length === 0) {
        <p class="p-3 text-xs text-muted">{{ topic() ? 'No consumer group has committed offsets on this topic.' : 'No consumer groups on this cluster.' }}</p>
      }
    </div>
  `,
  host: { class: 'flex flex-col h-full min-h-0', 'data-testid': 'queues-group-lag' },
})
export class QueuesGroupLag {
  readonly connectionId = input.required<string>();
  readonly topic = input<string>();

  protected readonly icons = { ChevronDown, ChevronRight, RefreshCw };
  protected readonly groups = invokeResource<QueueConsumerGroup[]>('queues.group.list', () => ({ connectionId: this.connectionId() }));
  protected readonly expanded = signal(new Set<string>());
  protected readonly rows = computed<GroupRow[]>(() => {
    const topic = this.topic();
    return (this.groups.value() ?? [])
      .map((group) => {
        const lag = topic ? group.lag.filter((l) => l.topic === topic) : group.lag;
        return { group, lag, total: lag.reduce((n, l) => n + l.lag, 0) };
      })
      .filter((row) => !topic || row.lag.length > 0)
      .sort((a, b) => b.total - a.total || a.group.id.localeCompare(b.group.id));
  });

  protected toggle(id: string): void {
    this.expanded.update((set) => {
      const next = new Set(set);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  protected stateClass(state: string): string {
    const s = state.toLowerCase();
    if (s === 'stable') return 'text-success';
    if (s === 'empty' || s === 'dead') return 'text-muted';
    return 'text-warning';
  }
}
