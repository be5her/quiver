import { Component, computed, input, output } from '@angular/core';
import { FormField, type FieldTree } from '@angular/forms/signals';
import type { RealtimeConnection } from '@quiver/core';
import { Button, Checkbox, CodeEditor, Input, Label, Select } from '@quiver/ui';
import { Trash2 } from 'lucide';
import { clampInt, textLanguage } from './realtime-format';

/** The kind of connection, how it reconnects, and what an SSE stream request carries. */
@Component({
  selector: 'q-realtime-settings-view',
  imports: [Button, Checkbox, CodeEditor, FormField, Input, Label, Select],
  templateUrl: './settings-view.html',
  host: { class: 'flex flex-col gap-4 p-3 overflow-y-auto h-full max-w-3xl' },
})
export class RealtimeSettingsView {
  readonly form = input.required<FieldTree<RealtimeConnection>>();
  readonly remove = output<void>();

  protected readonly trash = Trash2;
  protected readonly bodyPlaceholder = 'Sent when the stream is opened; {{variables}} resolve on connect';
  protected readonly connection = computed(() => this.form()().value());
  protected readonly isWs = computed(() => this.connection().kind === 'websocket');
  protected readonly protocols = computed(() => this.connection().protocols.join(', '));
  protected readonly bodyLanguage = computed(() => textLanguage(this.connection().body));

  protected setProtocols(event: Event): void {
    const raw = (event.target as HTMLInputElement).value;
    this.form()
      .protocols()
      .value.set(
        raw
          .split(',')
          .map((p) => p.trim())
          .filter(Boolean),
      );
  }

  protected setLogLimit(event: Event): void {
    this.form().logLimit().value.set(clampInt((event.target as HTMLInputElement).value, 10, 5000, 500));
  }
}
