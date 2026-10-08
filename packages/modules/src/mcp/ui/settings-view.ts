import { Component, computed, input, output } from '@angular/core';
import { FormField, type FieldTree } from '@angular/forms/signals';
import type { McpServer } from '@quiver/core';
import { Button, Checkbox, Input, KeyValueEditor, Label, Select } from '@quiver/ui';
import { Trash2 } from 'lucide';
import { AuthEditor } from '../../api/ui';
import { clampInt } from './mcp-format';

/** The transport and how the server is started or reached, with what each request carries. */
@Component({
  selector: 'q-mcp-settings-view',
  imports: [AuthEditor, Button, Checkbox, FormField, Input, KeyValueEditor, Label, Select],
  templateUrl: './settings-view.html',
  host: { class: 'flex flex-col gap-4 p-3 overflow-y-auto h-full max-w-3xl' },
})
export class McpSettingsView {
  readonly form = input.required<FieldTree<McpServer>>();
  readonly remove = output<void>();

  protected readonly trash = Trash2;
  protected readonly variablesHint = "{{variables}} resolve from the active environment and ${NAME} or ${NAME:-default} from Quiver's environment when connecting. Quiver announces the project folder as the root.";
  protected readonly server = computed(() => this.form()().value());
  protected readonly isStdio = computed(() => this.server().transport === 'stdio');

  protected setLogLimit(event: Event): void {
    this.form().logLimit().value.set(clampInt((event.target as HTMLInputElement).value, 10, 5000, 500));
  }
}
