import { Component, computed, inject, input, output, signal } from '@angular/core';
import { FormField, form } from '@angular/forms/signals';
import type { RealtimeConnectionSummary, RealtimeSavedMessage } from '@quiver/core';
import { Button, CodeEditor, HostBridge, Select, Toasts } from '@quiver/ui';
import { Save, Send } from 'lucide';
import { textLanguage } from './realtime-format';

type Format = 'text' | 'json';

/** What to send next on a WebSocket: text or checked JSON, typed or loaded from the saved messages. */
@Component({
  selector: 'q-realtime-composer',
  imports: [Button, CodeEditor, FormField, Select],
  template: `
    @let c = composer();
    <div class="h-24">
      <q-code-editor [formField]="composerForm.text" [language]="c.format === 'json' ? 'json' : 'text'" [placeholder]="open() ? 'Message to send (Ctrl+Enter)' : 'Connect to send messages'" (run)="send()" />
    </div>
    <div class="flex items-center gap-2">
      <select qSelect [formField]="composerForm.format" class="h-7 text-xs w-20">
        <option value="text">Text</option>
        <option value="json">JSON</option>
      </select>
      @if (savedMessages().length > 0) {
        <select qSelect class="h-7 text-xs w-44" title="Load a saved message" (change)="loadSaved($event)">
          <option value="">Saved messages…</option>
          @for (m of savedMessages(); track m.id) {
            <option [value]="m.id">{{ m.name || m.body.slice(0, 40) || '(empty)' }}</option>
          }
        </select>
      }
      <button qButton size="sm" variant="ghost" [icon]="icons.Save" [disabled]="!c.text.trim()" title="Keep this message with the connection" (click)="saveMessage.emit(c.text)">Save message</button>
      <div class="flex-1"></div>
      <span class="text-[11px] text-muted">{{ hint }}</span>
      <button qButton size="sm" variant="primary" [icon]="icons.Send" [loading]="sending()" [disabled]="!open()" title="Ctrl+Enter" data-testid="realtime-send" (click)="send()">Send</button>
    </div>
  `,
  host: { class: 'border-t border-edge shrink-0 flex flex-col gap-1 p-2', 'data-testid': 'realtime-composer' },
})
export class RealtimeComposer {
  private readonly host = inject(HostBridge);
  private readonly toasts = inject(Toasts);

  readonly connection = input.required<RealtimeConnectionSummary>();
  readonly savedMessages = input.required<RealtimeSavedMessage[]>();
  readonly saveMessage = output<string>();

  protected readonly icons = { Save, Send };
  protected readonly hint = '{{variables}} resolve on send';
  protected readonly composer = signal<{ text: string; format: Format }>({ text: '', format: 'text' });
  protected readonly composerForm = form(this.composer);
  protected readonly sending = signal(false);
  protected readonly open = computed(() => this.connection().status === 'open');

  protected async send(): Promise<void> {
    if (!this.open() || this.sending()) return;
    const { text, format } = this.composer();
    if (format === 'json') {
      try {
        JSON.parse(text);
      } catch (err) {
        this.toasts.notify(`Not valid JSON: ${(err as Error).message}`, 'error');
        return;
      }
    }
    this.sending.set(true);
    try {
      await this.host.invoke('realtime.send', { id: this.connection().id, data: text });
    } catch (err) {
      this.toasts.error(err);
    } finally {
      this.sending.set(false);
    }
  }

  /** Put a saved message in the composer; the picker goes back to its prompt. */
  protected loadSaved(event: Event): void {
    const select = event.target as HTMLSelectElement;
    const saved = this.savedMessages().find((m) => m.id === select.value);
    select.value = '';
    if (saved) this.composer.set({ text: saved.body, format: textLanguage(saved.body) === 'json' ? 'json' : 'text' });
  }
}
