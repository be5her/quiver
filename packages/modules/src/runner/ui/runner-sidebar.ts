import { Component, computed, inject } from '@angular/core';
import type { RunnerTask } from '@quiver/core';
import { Button, ContextMenu, Icon, IconButton, SectionHeader, Spinner, TreeState, invokeResource } from '@quiver/ui';
import { BookmarkPlus, Check, ChevronDown, ChevronRight, Ellipsis, Play, Plus, RefreshCw, RotateCw, Square, SquareX } from 'lucide';
import { DbRow } from '../../db/ui/db-row';
import { RunnerActions } from './runner-actions';
import { injectRunnerChanged } from './runner-events';
import { SOURCE_BADGE, STATE_LABEL, isLive, stateDot, taskState, type RunnerDiscoveredRow, type RunnerProcInfo, type TaskState } from './runner-format';

const DISCOVERED_KEY = 'runner/discovered';

/** The saved tasks with their state and Start, Stop and Restart, then the scripts the project defines. */
@Component({
  selector: 'q-runner-sidebar',
  imports: [Button, DbRow, Icon, IconButton, SectionHeader, Spinner],
  template: `
    <q-section-header title="Tasks">
      @if (liveCount()) {
        <button qIconButton label="Stop all tasks" size="sm" data-testid="runner-stop-all" (click)="actions.stopAll()"><svg [qIcon]="icons.SquareX" class="size-3.5"></svg></button>
      }
      <button qIconButton label="New task" size="sm" data-testid="runner-new-task" (click)="actions.createTask()"><svg [qIcon]="icons.Plus" class="size-3.5"></svg></button>
    </q-section-header>
    @if (tasks.isLoading() && !tasks.value()) {
      <div class="px-3 py-2"><svg qSpinner></svg></div>
    }
    @for (t of tasks.value() ?? []; track t.id) {
      @let state = stateOf(t.id);
      <div
        qDbRow
        [label]="t.name"
        [hint]="hintOf(t, state)"
        data-testid="runner-task-row"
        [attr.data-id]="t.id"
        [attr.data-state]="state"
        (click)="actions.openTask(t, 'output')"
        (keydown.enter)="actions.openTask(t, 'output')"
        (contextmenu)="menu($event, t)"
      >
        <span rowPrefix class="size-2 rounded-full shrink-0 mx-0.5" [class]="dot(state)" [attr.title]="label[state]" data-testid="runner-task-dot"></span>
        @if (live(state)) {
          <button qIconButton label="Stop" size="sm" data-testid="runner-task-stop" (click)="act($event, () => actions.stop(t))"><svg [qIcon]="icons.Square" class="size-3.5"></svg></button>
        } @else {
          <button qIconButton label="Start" size="sm" data-testid="runner-task-start" (click)="act($event, () => actions.start(t))"><svg [qIcon]="icons.Play" class="size-3.5"></svg></button>
        }
        <button qIconButton label="Restart" size="sm" data-testid="runner-task-restart" (click)="act($event, () => actions.restart(t))"><svg [qIcon]="icons.RotateCw" class="size-3.5"></svg></button>
        <button qIconButton label="More actions" size="sm" data-testid="runner-task-menu" (click)="menu($event, t)"><svg [qIcon]="icons.Ellipsis" class="size-3.5"></svg></button>
      </div>
    }
    @if (tasks.value()?.length === 0) {
      <div class="px-3 py-2 flex flex-col gap-2" data-testid="runner-empty">
        <p class="text-xs text-muted">The project's long-running commands: dev servers, watchers, containers. Tasks are saved with the project under .quiver/runner; save one from the scripts found below or make your own.</p>
        <div><button qButton size="sm" variant="secondary" [icon]="icons.Plus" (click)="actions.createTask()">New task</button></div>
      </div>
    }
    @if (tasks.error(); as error) {
      <p class="px-3 py-2 text-xs text-danger">{{ error.message }}</p>
    }

    <q-section-header class="mt-2 cursor-pointer select-none" data-testid="runner-discovered-header" (click)="toggleDiscovered()">
      <span sectionTitle class="flex items-center gap-1 -ml-1"><svg [qIcon]="discoveredOpen() ? icons.ChevronDown : icons.ChevronRight" class="size-3.5"></svg>Discovered</span>
      <button qIconButton label="Look again" size="sm" (click)="refreshDiscovered($event)"><svg [qIcon]="icons.RefreshCw" class="size-3.5"></svg></button>
    </q-section-header>
    @if (discoveredOpen()) {
      @if (discovered.isLoading() && !discovered.value()) {
        <div class="px-3 py-2"><svg qSpinner></svg></div>
      }
      @for (d of discovered.value() ?? []; track d.source + d.file + d.name) {
        <div qDbRow [label]="d.name" [hint]="d.cwd || ''" data-testid="runner-discovered-row" [attr.data-source]="d.source" [attr.data-name]="d.name" [attr.data-saved]="d.taskId ? 'true' : 'false'" (click)="openSaved(d)" (keydown.enter)="openSaved(d)">
          <span rowPrefix class="text-[9px] font-bold text-muted shrink-0 w-8" [attr.title]="d.file + '\n' + d.command">{{ badge[d.source] }}</span>
          @if (d.taskId) {
            <span rowBadge class="shrink-0 flex" title="Saved as a task"><svg [qIcon]="icons.Check" class="size-3 text-success"></svg></span>
          }
          <button qIconButton [label]="d.taskId ? 'Run its task' : 'Run once (saves it as a task first)'" size="sm" data-testid="runner-discovered-run" (click)="act($event, () => actions.runDiscovered(d))"><svg [qIcon]="icons.Play" class="size-3.5"></svg></button>
          @if (!d.taskId) {
            <button qIconButton label="Save as task" size="sm" data-testid="runner-discovered-save" (click)="act($event, () => actions.saveDiscovered(d))"><svg [qIcon]="icons.BookmarkPlus" class="size-3.5"></svg></button>
          }
        </div>
      }
      @if (discovered.value()?.length === 0) {
        <p class="px-3 py-1 text-xs text-muted">No package.json scripts, Makefile targets, justfile recipes or compose services found.</p>
      }
      @if (discovered.error(); as error) {
        <p class="px-3 py-2 text-xs text-danger">{{ error.message }}</p>
      }
    }
  `,
  host: { class: 'flex flex-col h-full min-h-0 overflow-y-auto text-sm', 'data-testid': 'runner-sidebar' },
})
export class RunnerSidebar {
  private readonly tree = inject(TreeState);
  private readonly contextMenu = inject(ContextMenu);
  protected readonly actions = inject(RunnerActions);

  protected readonly icons = { BookmarkPlus, Check, ChevronDown, ChevronRight, Ellipsis, Play, Plus, RefreshCw, RotateCw, Square, SquareX };
  protected readonly label = STATE_LABEL;
  protected readonly badge = SOURCE_BADGE;
  protected readonly dot = stateDot;
  protected readonly live = isLive;

  protected readonly tasks = invokeResource<RunnerTask[]>('runner.task.list', () => ({}), { refreshOn: ['runner'] });
  protected readonly procs = invokeResource<RunnerProcInfo[]>('runner.proc.list', () => ({}));
  /** Open unless closed, so the scripts show the first time the panel opens. */
  protected readonly discoveredOpen = computed(() => !this.tree.isExpanded(`${DISCOVERED_KEY}:closed`));
  /** Read again when tasks are saved or deleted (which marks the saved ones); changed project files show on "Look again". */
  protected readonly discovered = invokeResource<RunnerDiscoveredRow[]>('runner.task.discover', () => ({}), { enabled: () => this.discoveredOpen(), refreshOn: ['runner'] });

  private readonly procByTask = computed(() => new Map((this.procs.value() ?? []).map((p) => [p.taskId, p])));
  protected readonly liveCount = computed(() => [...this.procByTask().values()].filter((p) => isLive(taskState(p))).length);

  constructor() {
    injectRunnerChanged((p) => p.reason !== 'output' && this.procs.reload());
  }

  protected stateOf(taskId: string): TaskState {
    return taskState(this.procByTask().get(taskId));
  }

  protected hintOf(task: RunnerTask, state: TaskState): string {
    if (state === 'stopped') return '';
    const port = this.procByTask().get(task.id)?.port ?? task.port;
    return port && (state === 'ready' || state === 'running') ? `:${port}` : STATE_LABEL[state].toLowerCase();
  }

  protected act(event: Event, run: () => Promise<unknown>): void {
    event.stopPropagation();
    void run();
  }

  /** A script saved as a task opens that task; one that is not runs only from its buttons. */
  protected openSaved(d: RunnerDiscoveredRow): void {
    const task = d.taskId ? this.tasks.value()?.find((t) => t.id === d.taskId) : undefined;
    if (task) this.actions.openTask(task, 'output');
  }

  protected menu(event: MouseEvent, task: RunnerTask): void {
    event.preventDefault();
    event.stopPropagation();
    this.contextMenu.open(event, this.actions.taskMenu(task, this.procByTask().get(task.id)));
  }

  protected toggleDiscovered(): void {
    this.tree.toggle(`${DISCOVERED_KEY}:closed`);
  }

  protected refreshDiscovered(event: Event): void {
    event.stopPropagation();
    if (!this.discoveredOpen()) this.toggleDiscovered();
    else this.discovered.reload();
  }
}
