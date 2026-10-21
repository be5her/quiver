import { Component, computed, effect, inject, input, linkedSignal, signal, untracked } from '@angular/core';
import type { RunnerTask } from '@quiver/core';
import { Button, Icon, Segment, Segmented, TabsState, invokeResource, type Tab, type TabComponent } from '@quiver/ui';
import { ExternalLink, Play, RotateCw, Square } from 'lucide';
import { RunnerOutput } from './output-pane';
import { RunnerActions, type TaskView } from './runner-actions';
import { injectRunnerChanged } from './runner-events';
import { STATE_LABEL, formatUptime, isLive, portUrl, stateDot, taskState, type RunnerProcInfo } from './runner-format';
import { RunnerTaskEditor } from './task-editor';

/**
 * A saved task: a header with its state, pid, uptime, restarts, exit code and port (a link that opens the system
 * browser), Start, Stop and Restart, then its live output or its settings.
 */
@Component({
  selector: 'q-runner-task-tab',
  imports: [Button, Icon, RunnerOutput, RunnerTaskEditor, Segment, Segmented],
  template: `
    @if (task.error(); as error) {
      <div class="p-4 text-sm text-danger" data-testid="runner-task-error">{{ error.message }}</div>
    } @else if (task.value(); as t) {
      @let s = state();
      @let p = proc();
      <div class="flex flex-col h-full min-h-0 w-full" data-testid="runner-task-tab" [attr.data-id]="t.id" [attr.data-state]="s">
        <div class="flex items-center gap-3 px-3 h-10 border-b border-edge shrink-0 text-xs">
          <span class="flex items-center gap-1.5 shrink-0" data-testid="runner-tab-state"><span class="size-2 rounded-full" [class]="dot(s)"></span><span class="font-medium">{{ label[s] }}</span></span>
          <span class="font-mono text-muted truncate min-w-0" [attr.title]="t.command">{{ t.command }}</span>
          <span class="flex-1 min-w-2"></span>
          @if (port(); as port) {
            <a class="flex items-center gap-1 font-mono text-accent hover:underline shrink-0" [href]="url(port)" target="_blank" rel="noopener" title="Open in the browser" data-testid="runner-port-link"
              >localhost:{{ port }}<svg [qIcon]="icons.ExternalLink" class="size-3"></svg
            ></a>
          }
          @if (p) {
            <dl class="flex items-center gap-3 text-muted shrink-0" data-testid="runner-tab-facts">
              @if (p.pid && live()) {
                <div class="flex gap-1"><dt>pid</dt><dd class="font-mono text-fg" data-testid="runner-tab-pid">{{ p.pid }}</dd></div>
              }
              @if (uptime(); as up) {
                <div class="flex gap-1"><dt>up</dt><dd class="font-mono text-fg" data-testid="runner-tab-uptime">{{ up }}</dd></div>
              }
              @if (p.restarts) {
                <div class="flex gap-1"><dt>restarts</dt><dd class="font-mono text-fg" data-testid="runner-tab-restarts">{{ p.restarts }}</dd></div>
              }
              @if (!live() && p.exitCode !== undefined && p.exitCode !== null) {
                <div class="flex gap-1"><dt>exit</dt><dd class="font-mono" [class]="s === 'crashed' ? 'text-danger' : 'text-fg'" [attr.title]="s === 'crashed' ? 'Exited by itself' : 'Stopped from Quiver, or exited by itself with code 0'" data-testid="runner-tab-exit">{{ p.exitCode }}</dd></div>
              }
            </dl>
          }
          @if (live()) {
            <button qButton size="sm" variant="secondary" [icon]="icons.Square" [loading]="busy()" data-testid="runner-tab-stop" (click)="run('stop', t)">Stop</button>
          } @else {
            <button qButton size="sm" variant="primary" [icon]="icons.Play" [loading]="busy()" data-testid="runner-tab-start" (click)="run('start', t)">Start</button>
          }
          <button qButton size="sm" variant="ghost" [icon]="icons.RotateCw" [disabled]="busy()" data-testid="runner-tab-restart" (click)="run('restart', t)">Restart</button>
        </div>
        <q-segmented [(value)]="view" class="shrink-0 px-1">
          <button qSegment="output" data-testid="runner-view-output">Output</button>
          <button qSegment="settings" data-testid="runner-view-settings">Settings{{ tab().dirty ? '*' : '' }}</button>
        </q-segmented>
        <!-- Both stay alive, so switching keeps the output read and the unsaved settings. -->
        <q-runner-output class="flex-1 min-h-0" [class.hidden]="view() !== 'output'" [taskId]="t.id" [live]="hasProcess()" />
        <q-runner-task-editor class="flex-1 min-h-0" [class.hidden]="view() !== 'settings'" [task]="t" (dirtyChange)="markDirty($event)" (remove)="remove(t)" />
      </div>
    }
  `,
  host: { class: 'flex flex-col h-full min-h-0' },
})
export class RunnerTaskTab implements TabComponent {
  private readonly tabs = inject(TabsState);
  protected readonly actions = inject(RunnerActions);

  readonly tab = input.required<Tab>();
  readonly scope = input.required<string>();

  protected readonly icons = { ExternalLink, Play, RotateCw, Square };
  protected readonly label = STATE_LABEL;
  protected readonly dot = stateDot;
  protected readonly url = portUrl;

  private readonly taskId = computed(() => String(this.tab().data?.['id'] ?? ''));
  protected readonly task = invokeResource<RunnerTask>('runner.task.get', () => ({ id: this.taskId() }), { refreshOn: ['runner'] });
  private readonly procs = invokeResource<RunnerProcInfo[]>('runner.proc.list', () => ({}));
  protected readonly proc = computed(() => (this.procs.value() ?? []).find((p) => p.taskId === this.taskId()));
  protected readonly state = computed(() => taskState(this.proc()));
  protected readonly live = computed(() => isLive(this.state()));
  /** Whether there is a process to write to: not while a crashed one waits to restart, nor while it stops. */
  protected readonly hasProcess = computed(() => ['starting', 'ready', 'running'].includes(this.state()));
  /** The running process's port; once stopped, the saved one, so an edit in Settings shows at once. */
  protected readonly port = computed(() => (this.live() ? this.proc()?.port : undefined) ?? this.task.value()?.port);
  /** The view the tab was opened on, until the user picks another or the tab is asked for one again. */
  protected readonly view = linkedSignal<string, TaskView>({
    // Keyed on the asked view and when it was asked, so other tab updates (title, dirty) leave the view alone.
    source: computed(() => `${String(this.tab().data?.['view'] ?? '')}:${String(this.tab().data?.['nonce'] ?? '')}`),
    computation: (key) => (key.startsWith('settings:') ? 'settings' : 'output'),
  });
  protected readonly busy = signal(false);

  /** When the proc list was read, so the uptime counts on between reads. */
  private readonly readAt = linkedSignal(() => (this.procs.value(), Date.now()));
  private readonly now = signal(Date.now());
  protected readonly uptime = computed(() => {
    const ms = this.live() ? this.proc()?.uptimeMs : undefined;
    return ms === undefined ? null : formatUptime(ms + Math.max(0, this.now() - this.readAt()));
  });

  constructor() {
    injectRunnerChanged((p) => {
      if (p.reason === 'state' && p.taskId === this.taskId()) this.procs.reload();
    });
    effect((onCleanup) => {
      if (!this.live()) return;
      const timer = setInterval(() => this.now.set(Date.now()), 1000);
      onCleanup(() => clearInterval(timer));
    });
    effect(() => {
      const name = this.task.value()?.name;
      const tab = this.tab();
      if (name && tab.title !== name) untracked(() => this.tabs.updateTab(this.scope(), tab.id, { title: name }));
    });
  }

  protected markDirty(dirty: boolean): void {
    const tab = untracked(this.tab);
    if (Boolean(tab.dirty) !== dirty) this.tabs.updateTab(untracked(this.scope), tab.id, { dirty });
  }

  protected async run(action: 'start' | 'stop' | 'restart', t: RunnerTask): Promise<void> {
    this.busy.set(true);
    try {
      await this.actions[action](t);
      this.procs.reload();
    } finally {
      this.busy.set(false);
    }
  }

  protected remove(t: RunnerTask): void {
    void this.actions.deleteTask(t, this.live());
  }
}
