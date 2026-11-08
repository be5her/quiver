import { Service, inject, untracked } from '@angular/core';
import type { RunnerDiscoveredRow, RunnerProcInfo, RunnerTask } from '@quiver/core';
import { AppState, Dialogs, HostBridge, TabsState, Toasts, type ContextMenuItem } from '@quiver/ui';
import { isLive, taskState } from './runner-format';

type TaskRef = Pick<RunnerTask, 'id' | 'name'>;
export type TaskView = 'output' | 'settings';

/** Opens task tabs, starts and stops tasks, saves discovered scripts; deleting a task asks first. */
@Service()
export class RunnerActions {
  private readonly app = inject(AppState);
  private readonly host = inject(HostBridge);
  private readonly tabs = inject(TabsState);
  private readonly dialogs = inject(Dialogs);
  private readonly toasts = inject(Toasts);

  private scope(): string {
    return untracked(this.app.scope);
  }

  /**
   * The workspace on screen, taken before a command is awaited: the user may switch to another checkout of the project
   * meanwhile, which shares task ids, and the command and the tabs it opens belong to the one it started in.
   */
  private here(): { scope: string; workspaceId: string | null } {
    return { scope: this.scope(), workspaceId: untracked(this.app.activeWorkspaceId) };
  }

  /** Open (or focus) a task on its output or its settings. */
  openTask(task: TaskRef, view?: TaskView, scope = this.scope()): void {
    const tab = this.tabs.openTab(scope, { type: 'runner.task', title: task.name, data: { id: task.id, view, nonce: Date.now() } }, { singletonKey: `runner.task:${task.id}` });
    // A tab that was already open keeps its view unless asked for another.
    if (view) this.tabs.updateTab(scope, tab.id, { data: { ...tab.data, view, nonce: Date.now() } });
  }

  /** Ask for the command, save the task and open its settings for the rest. */
  async createTask(): Promise<void> {
    const command = await this.dialogs.prompt({ title: 'New task', label: 'Command', placeholder: 'npm run dev', confirmLabel: 'Create' });
    if (!command?.trim()) return;
    const { scope, workspaceId } = this.here();
    try {
      const created = await this.host.invoke<RunnerTask>('runner.task.save', { task: { command: command.trim() } }, workspaceId);
      this.openTask(created, 'settings', scope);
    } catch (err) {
      this.toasts.error(err);
    }
  }

  async start(task: TaskRef, open = false): Promise<void> {
    const { scope, workspaceId } = this.here();
    try {
      await this.host.invoke<RunnerProcInfo>('runner.proc.start', { taskId: task.id }, workspaceId);
      if (open) this.openTask(task, 'output', scope);
    } catch (err) {
      this.toasts.error(err);
    }
  }

  async stop(task: TaskRef): Promise<void> {
    try {
      await this.host.invoke('runner.proc.stop', { taskId: task.id });
    } catch (err) {
      this.toasts.error(err);
    }
  }

  async restart(task: TaskRef): Promise<void> {
    try {
      await this.host.invoke('runner.proc.restart', { taskId: task.id });
    } catch (err) {
      this.toasts.error(err);
    }
  }

  /** Stop every task of the workspace on screen that has a process or a restart pending. */
  async stopAll(): Promise<void> {
    const { workspaceId } = this.here();
    try {
      const procs = await this.host.invoke<RunnerProcInfo[]>('runner.proc.list', {}, workspaceId);
      const live = procs.filter((p) => isLive(taskState(p)));
      if (!live.length) {
        this.toasts.notify('No task is running');
        return;
      }
      const results = await Promise.allSettled(live.map((p) => this.host.invoke('runner.proc.stop', { taskId: p.taskId }, workspaceId)));
      const failed = results.filter((r) => r.status === 'rejected').length;
      if (failed) this.toasts.notify(`${failed} of ${live.length} tasks did not stop`, 'error');
      else this.toasts.notify(live.length === 1 ? 'Stopped 1 task' : `Stopped ${live.length} tasks`, 'success');
    } catch (err) {
      this.toasts.error(err);
    }
  }

  async deleteTask(task: TaskRef, running: boolean): Promise<boolean> {
    if (
      !(await this.dialogs.confirm({
        title: `Delete task "${task.name}"?`,
        message: `Its file under .quiver/runner is removed from the project.${running ? ' It is running, so it is stopped first, with every process it started.' : ''}`,
        danger: true,
        confirmLabel: 'Delete',
      }))
    )
      return false;
    const { scope, workspaceId } = this.here();
    try {
      await this.host.invoke('runner.task.delete', { id: task.id }, workspaceId);
      this.tabs.closeWhere(scope, (t) => t.type === 'runner.task' && t.data?.['id'] === task.id);
      return true;
    } catch (err) {
      this.toasts.error(err);
      return false;
    }
  }

  /** Save a discovered script as a task; saving the same script again gives back the task it already is. */
  private saveScript(row: RunnerDiscoveredRow, workspaceId: string | null): Promise<RunnerTask> {
    const { source, name, command, cwd } = row;
    return this.host.invoke<RunnerTask>('runner.task.save', { task: { source, name, command, cwd } }, workspaceId);
  }

  async saveDiscovered(row: RunnerDiscoveredRow): Promise<void> {
    const { scope, workspaceId } = this.here();
    try {
      const saved = await this.saveScript(row, workspaceId);
      this.toasts.notify(`Saved "${saved.name}" as a task`, 'success');
      this.openTask(saved, 'settings', scope);
    } catch (err) {
      this.toasts.error(err);
    }
  }

  /**
   * Run a discovered script. The runner starts only saved tasks, so a script that is not one yet is saved first
   * (once: running it again starts the same task) and shown on its output.
   */
  async runDiscovered(row: RunnerDiscoveredRow): Promise<void> {
    const { scope, workspaceId } = this.here();
    try {
      const task = row.taskId ? { id: row.taskId, name: row.name } : await this.saveScript(row, workspaceId);
      await this.host.invoke('runner.proc.start', { taskId: task.id }, workspaceId);
      this.openTask(task, 'output', scope);
    } catch (err) {
      this.toasts.error(err);
    }
  }

  /**
   * The palette's "Run task" and "Open task": pick a saved task from the list, or type part of its name (the hint
   * lists what matches, and a single match wins over the list).
   */
  async pickTask(mode: 'run' | 'open'): Promise<void> {
    const { scope, workspaceId } = this.here();
    try {
      const tasks = await this.host.invoke<RunnerTask[]>('runner.task.list', {}, workspaceId);
      if (!tasks.length) {
        this.app.setActiveModule('runner');
        this.toasts.notify('No saved task yet: save one from the Runner sidebar');
        return;
      }
      const matches = (text: string) => {
        const needle = text.trim().toLowerCase();
        return needle ? tasks.filter((t) => t.name.toLowerCase().includes(needle) || t.command.toLowerCase().includes(needle)) : [];
      };
      const answer = await this.dialogs.promptWithChoice({
        title: mode === 'run' ? 'Run task' : 'Open task',
        label: 'Name',
        placeholder: 'Type to filter, or pick below',
        confirmLabel: mode === 'run' ? 'Run' : 'Open',
        choice: {
          label: 'Task',
          options: tasks.map((t) => ({ value: t.id, label: t.name })),
          defaultValue: tasks[0].id,
          hint: (text) => {
            if (!text.trim()) return null;
            const found = matches(text);
            if (!found.length) return 'No match; the task picked below is used';
            return found.length === 1 ? `→ ${found[0].name}` : found.slice(0, 4).map((t) => t.name).join(', ') + (found.length > 4 ? ` +${found.length - 4}` : '');
          },
        },
      });
      if (!answer) return;
      const found = matches(answer.value);
      const exact = found.find((t) => t.name.toLowerCase() === answer.value.trim().toLowerCase());
      const task = exact ?? (found.length === 1 ? found[0] : tasks.find((t) => t.id === answer.choice));
      if (!task) return;
      if (mode === 'run') {
        await this.host.invoke('runner.proc.start', { taskId: task.id }, workspaceId);
        this.openTask(task, 'output', scope);
      } else this.openTask(task, undefined, scope);
    } catch (err) {
      this.toasts.error(err);
    }
  }

  /** The `…` and right-click menu of a saved task. */
  taskMenu(task: RunnerTask, proc: RunnerProcInfo | undefined): ContextMenuItem[] {
    const live = isLive(taskState(proc));
    return [
      live ? { label: 'Stop', testId: 'runner-menu-stop', select: () => void this.stop(task) } : { label: 'Start', testId: 'runner-menu-start', select: () => void this.start(task) },
      { label: 'Restart', testId: 'runner-menu-restart', select: () => void this.restart(task) },
      'separator',
      { label: 'Output', select: () => this.openTask(task, 'output') },
      { label: 'Edit task', testId: 'runner-menu-edit', select: () => this.openTask(task, 'settings') },
      'separator',
      { label: 'Delete task…', testId: 'runner-menu-delete', danger: true, select: () => void this.deleteTask(task, live) },
    ];
  }
}
