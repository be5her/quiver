import { Component, booleanAttribute, computed, inject, input, linkedSignal, model, output } from '@angular/core';
import { FormField, form, type FormValueControl } from '@angular/forms/signals';
import { newSavedMessage, type RealtimeSavedMessage } from '@quiver/core';
import { Button, CodeEditor, HostBridge, Icon, IconButton, Input, Label, Toasts } from '@quiver/ui';
import { Plus, Send, Trash2 } from 'lucide';
import { textLanguage } from './realtime-format';

/** One saved payload: its name and body, sent as is (variables resolve on send). */
@Component({
  selector: 'q-realtime-saved-message-editor',
  imports: [Button, CodeEditor, FormField, Icon, IconButton, Input, Label],
  template: `
    <div class="flex items-end gap-2">
      <div class="flex-1">
        <label qLabel>Name</label>
        <input qInput [formField]="messageForm.name" />
      </div>
      <button qButton size="sm" variant="primary" [icon]="icons.Send" [disabled]="!canSend()" (click)="send.emit()">Send</button>
      <button qIconButton label="Delete message" (click)="removed.emit()"><svg [qIcon]="icons.Trash2" class="size-3.5"></svg></button>
    </div>
    <div class="flex-1 min-h-[160px]">
      <q-code-editor [formField]="messageForm.body" [language]="language()" [placeholder]="placeholder" />
    </div>
  `,
  host: { class: 'contents' },
})
export class RealtimeSavedMessageEditor implements FormValueControl<RealtimeSavedMessage> {
  readonly value = model.required<RealtimeSavedMessage>();
  readonly canSend = input(false, { transform: booleanAttribute });
  readonly send = output<void>();
  readonly removed = output<void>();

  protected readonly icons = { Send, Trash2 };
  protected readonly placeholder = 'Payload; {{variables}} resolve on send';
  protected readonly messageForm = form(this.value);
  protected readonly language = computed(() => textLanguage(this.value().body));
}

/** Payloads kept with a WebSocket connection, to send again or for agents to send by id. */
@Component({
  selector: 'q-realtime-saved-messages',
  imports: [Icon, IconButton, RealtimeSavedMessageEditor],
  template: `
    <div class="w-56 border-r border-edge flex flex-col min-h-0 shrink-0">
      <div class="flex items-center justify-between pl-3 pr-1 h-9 border-b border-edge shrink-0">
        <span class="text-[11px] text-muted">Reusable payloads</span>
        <button qIconButton label="Add message" size="sm" (click)="add()"><svg [qIcon]="icons.Plus" class="size-3.5"></svg></button>
      </div>
      <div class="flex-1 overflow-y-auto">
        @for (m of value(); track m.id) {
          <button type="button" class="w-full text-left px-3 h-8 text-xs hover:bg-elevated truncate" [class.bg-elevated]="m.id === selectedId()" (click)="selectedId.set(m.id)">{{ m.name || m.body.slice(0, 40) || '(empty)' }}</button>
        } @empty {
          <p class="px-3 py-3 text-xs text-muted">Keep messages you send often. Agents can send them by id with realtime.send.</p>
        }
      </div>
    </div>
    <div class="flex-1 min-w-0 flex flex-col gap-2 p-3">
      @if (selected(); as m) {
        <q-realtime-saved-message-editor [value]="m" (valueChange)="update($event)" [canSend]="connected()" (send)="send(m)" (removed)="remove()" />
      } @else {
        <p class="text-xs text-muted">Pick a message or add one.</p>
      }
    </div>
  `,
  host: { class: 'flex h-full min-h-0' },
})
export class RealtimeSavedMessages implements FormValueControl<RealtimeSavedMessage[]> {
  private readonly host = inject(HostBridge);
  private readonly toasts = inject(Toasts);

  readonly value = model.required<RealtimeSavedMessage[]>();
  readonly connectionId = input.required<string>();
  readonly connected = input(false, { transform: booleanAttribute });

  protected readonly icons = { Plus };
  /** Starts on the first message; afterwards only a click, an add or a delete moves it. */
  protected readonly selectedId = linkedSignal<RealtimeSavedMessage[], string | null>({
    source: this.value,
    computation: (messages, previous) => (previous ? previous.value : (messages[0]?.id ?? null)),
  });
  protected readonly selected = computed(() => this.value().find((m) => m.id === this.selectedId()) ?? null);

  protected add(): void {
    const message = newSavedMessage({ name: `Message ${this.value().length + 1}` });
    this.value.update((messages) => [...messages, message]);
    this.selectedId.set(message.id);
  }

  protected update(message: RealtimeSavedMessage): void {
    this.value.update((messages) => messages.map((m) => (m.id === message.id ? message : m)));
  }

  protected remove(): void {
    const id = this.selectedId();
    this.value.update((messages) => messages.filter((m) => m.id !== id));
    this.selectedId.set(null);
  }

  protected async send(message: RealtimeSavedMessage): Promise<void> {
    try {
      await this.host.invoke('realtime.send', { id: this.connectionId(), data: message.body });
    } catch (err) {
      this.toasts.error(err);
    }
  }
}
