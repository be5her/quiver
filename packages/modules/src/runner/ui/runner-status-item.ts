import { Component, computed, inject, linkedSignal, untracked } from '@angular/core';
import type { RunnerProcInfo } from '@quiver/core';
import { AppState, invokeResource } from '@quiver/ui';
import { injectRunnerChanged } from './runner-events';
import { STATE_LABEL, isLive, taskState } from './runner-format';

/** The status bar's count of the workspace's running tasks; a click opens the Runner. Nothing while none runs. */
@Component({
  selector: 'q-runner-status-item',
  template: `
    @if (live().length; as count) {
      <button type="button" class="flex items-center gap-1 hover:text-fg" data-testid="runner-status-item" [attr.data-count]="count" [title]="title()" (click)="open()">
        <span class="size-1.5 rounded-full" [class]="settling() ? 'bg-warning animate-pulse' : 'bg-success'"></span>{{ count }} running</button>
    }
  `,
  host: { class: 'contents' },
})
export class RunnerStatusItem {
  private readonly app = inject(AppState);
  private readonly procs = invokeResource<RunnerProcInfo[]>('runner.proc.list');
  // Kept with the workspace they were read for, so another workspace's tasks are not counted while this one's load.
  private readonly procsOf = linkedSignal({ source: this.procs.value, computation: (value) => ({ value, ws: untracked(this.app.activeWorkspaceId) }) });
  protected readonly live = computed(() => {
    const { value, ws } = this.procsOf();
    return ws === this.app.activeWorkspaceId() ? (value ?? []).filter((p) => isLive(taskState(p))) : [];
  });
  /** Some are starting, stopping or waiting to restart. */
  protected readonly settling = computed(() => this.live().some((p) => !['ready', 'running'].includes(taskState(p))));
  protected readonly title = computed(() => [...this.live().map((p) => `${p.name}: ${STATE_LABEL[taskState(p)].toLowerCase()}`), 'Click to open the Runner'].join('\n'));

  constructor() {
    injectRunnerChanged((p) => {
      if (p.reason === 'state' || p.reason === 'tasks') this.procs.reload();
    });
  }

  protected open(): void {
    this.app.setActiveModule('runner');
  }
}
