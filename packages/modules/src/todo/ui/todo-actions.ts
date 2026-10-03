import { Service, inject } from '@angular/core';
import { AppState, Dialogs, HostBridge, Toasts } from '@quiver/ui';

/** Adds, updates and removes todos; a failure is shown as a toast. */
@Service()
export class TodoActions {
  private readonly app = inject(AppState);
  private readonly host = inject(HostBridge);
  private readonly dialogs = inject(Dialogs);
  private readonly toasts = inject(Toasts);

  async run(id: string, input: unknown): Promise<void> {
    try {
      await this.host.invoke(id, input);
    } catch (err) {
      this.toasts.error(err);
    }
  }

  async addFromPalette(): Promise<void> {
    const title = await this.dialogs.prompt({ title: 'Add a todo', label: 'What needs doing?', confirmLabel: 'Add' });
    if (!title?.trim()) return;
    await this.host.invoke('todo.add', { title });
    this.app.setActiveModule('todo');
    this.toasts.notify('Added to the todo list', 'success');
  }
}
