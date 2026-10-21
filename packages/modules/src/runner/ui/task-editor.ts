import { Component, computed, effect, inject, input, linkedSignal, output, signal } from '@angular/core';
import { FormField, form } from '@angular/forms/signals';
import type { EnvProfileGroup, KeyValue, RunnerTask } from '@quiver/core';
import { Button, Checkbox, HostBridge, Input, KeyValueEditor, Label, Toasts, invokeResource } from '@quiver/ui';
import { Save, Trash2 } from 'lucide';

/** What the fields edit: the task with the port as text, so every field binds to a plain input. */
interface TaskDraft {
  name: string;
  command: string;
  cwd: string;
  env: KeyValue[];
  envProfile: string;
  autoRestart: boolean;
  readyPattern: string;
  port: string;
}

function draftOf(t: RunnerTask): TaskDraft {
  return {
    name: t.name,
    command: t.command,
    cwd: t.cwd,
    env: t.env,
    envProfile: t.envProfile ?? '',
    autoRestart: t.autoRestart,
    readyPattern: t.readyPattern ?? '',
    port: t.port === undefined ? '' : String(t.port),
  };
}

/** Why the typed port cannot be saved, or null when it is empty or a valid port. */
function portProblem(d: TaskDraft): string | null {
  const typed = d.port.trim();
  if (typed === '') return null;
  const n = Number(typed);
  return /^\d+$/.test(typed) && n >= 1 && n <= 65535 ? null : 'The port must be a number from 1 to 65535, or empty';
}

/**
 * The task's settings, saved through `runner.task.save`: an empty pattern or profile and an empty port clear them.
 * A change made elsewhere (MCP, the file) replaces the fields while they hold no unsaved edits. Ctrl+S saves.
 */
@Component({
  selector: 'q-runner-task-editor',
  imports: [Button, Checkbox, FormField, Input, KeyValueEditor, Label],
  template: `
    <div class="flex-1 min-h-0 overflow-y-auto" (keydown)="shortcut($event)">
      <div class="max-w-2xl flex flex-col gap-4 p-4" data-testid="runner-editor">
        <div class="grid grid-cols-[1fr_200px] gap-2">
          <div>
            <label qLabel for="runner-name">Name</label>
            <input qInput id="runner-name" [formField]="taskForm.name" data-testid="runner-edit-name" />
          </div>
          <div>
            <label qLabel for="runner-cwd">Folder</label>
            <input qInput id="runner-cwd" class="font-mono" placeholder="the workspace folder" [formField]="taskForm.cwd" data-testid="runner-edit-cwd" />
          </div>
        </div>
        <div>
          <label qLabel for="runner-command">Command</label>
          <input qInput id="runner-command" class="font-mono" placeholder="npm run dev" [formField]="taskForm.command" data-testid="runner-edit-command" />
          <p class="text-[11px] text-muted mt-1">Runs through the shell in the folder, relative to the workspace. Stopping it stops every process it started.</p>
        </div>
        <div class="grid grid-cols-[1fr_120px] gap-2">
          <div>
            <label qLabel for="runner-ready">Ready pattern</label>
            <input qInput id="runner-ready" class="font-mono" placeholder="listening on|ready in" [formField]="taskForm.readyPattern" data-testid="runner-edit-ready" />
          </div>
          <div>
            <label qLabel for="runner-port">Port</label>
            <input qInput id="runner-port" class="font-mono" inputmode="numeric" placeholder="3000" [formField]="taskForm.port" data-testid="runner-edit-port" />
          </div>
        </div>
        <p class="text-[11px] text-muted -mt-2">The task is ready once a line matches the pattern (a case-insensitive regular expression) or the port accepts connections. The port shows as a link.</p>
        <label class="flex items-center gap-2 text-sm"><input type="checkbox" qCheckbox [formField]="taskForm.autoRestart" data-testid="runner-edit-autorestart" /> Restart when it crashes (after 1 s, backing off to 30 s)</label>
        <div>
          <label qLabel for="runner-profile">Env profile</label>
          <input qInput id="runner-profile" class="font-mono" placeholder="staging (reads .env.staging)" list="runner-profiles" [formField]="taskForm.envProfile" data-testid="runner-edit-profile" />
          <datalist id="runner-profiles">
            @for (p of profiles(); track p) {
              <option [value]="p"></option>
            }
          </datalist>
        </div>
        <div>
          <span qLabel>Environment</span>
          <q-key-value-editor [formField]="taskForm.env" keyPlaceholder="NAME" valuePlaceholder="value" data-testid="runner-edit-env" />
          <p class="text-[11px] text-muted mt-1">Committed with the task in plain text. Put secrets in an env file and name it as the profile instead.</p>
        </div>
        <div class="flex items-center gap-2 pt-2 border-t border-edge">
          <button qButton size="sm" [variant]="dirty() ? 'primary' : 'secondary'" [icon]="icons.Save" [loading]="saving()" title="Ctrl+S" data-testid="runner-save" (click)="save()">Save{{ dirty() ? '*' : '' }}</button>
          @if (dirty()) {
            <button qButton size="sm" variant="ghost" data-testid="runner-revert" (click)="revert()">Revert</button>
          }
          <span class="flex-1"></span>
          <button qButton size="sm" variant="ghost" [icon]="icons.Trash2" class="text-danger" data-testid="runner-delete" (click)="remove.emit()">Delete task</button>
        </div>
        @if (problem(); as p) {
          <p class="text-xs text-danger -mt-2" data-testid="runner-edit-problem">{{ p }}</p>
        }
        <p class="text-[11px] text-muted -mt-2">Saved as <span class="font-mono">.quiver/runner/{{ task().id }}.json</span>; a running task picks up the change on its next start.</p>
      </div>
    </div>
  `,
  host: { class: 'flex flex-col h-full min-h-0' },
})
export class RunnerTaskEditor {
  private readonly host = inject(HostBridge);
  private readonly toasts = inject(Toasts);

  readonly task = input.required<RunnerTask>();
  readonly dirtyChange = output<boolean>();
  readonly remove = output<void>();

  protected readonly icons = { Save, Trash2 };
  private readonly saved = computed(() => draftOf(this.task()));
  protected readonly draft = linkedSignal<TaskDraft, TaskDraft>({
    source: this.saved,
    computation: (saved, previous) => {
      if (!previous) return saved;
      const edited = JSON.stringify(previous.value) !== JSON.stringify(previous.source);
      return edited ? previous.value : saved;
    },
  });
  protected readonly taskForm = form(this.draft);
  protected readonly saving = signal(false);
  protected readonly dirty = computed(() => JSON.stringify(this.draft()) !== JSON.stringify(this.saved()));
  protected readonly problem = computed(() => portProblem(this.draft()) ?? (this.draft().command.trim() ? null : 'A task needs a command'));
  private readonly profileGroups = invokeResource<EnvProfileGroup[]>('env.profile.list', () => ({}));
  protected readonly profiles = computed(() => [...new Set((this.profileGroups.value() ?? []).flatMap((g) => g.profiles.map((p) => p.name)))].sort());

  constructor() {
    effect(() => this.dirtyChange.emit(this.dirty()));
  }

  protected shortcut(event: KeyboardEvent): void {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      void this.save();
    }
  }

  protected revert(): void {
    this.draft.set(this.saved());
  }

  async save(): Promise<void> {
    if (this.saving() || !this.dirty()) return;
    const problem = this.problem();
    if (problem) {
      this.toasts.notify(problem, 'error');
      return;
    }
    const d = this.draft();
    this.saving.set(true);
    try {
      const port = d.port.trim() === '' ? null : Number(d.port.trim());
      const stored = await this.host.invoke<RunnerTask>('runner.task.save', {
        task: { id: this.task().id, name: d.name, command: d.command, cwd: d.cwd, env: d.env, envProfile: d.envProfile.trim(), autoRestart: d.autoRestart, readyPattern: d.readyPattern, port },
      });
      this.draft.set(draftOf(stored));
      this.toasts.notify('Saved', 'success');
    } catch (err) {
      this.toasts.error(err);
    } finally {
      this.saving.set(false);
    }
  }
}
