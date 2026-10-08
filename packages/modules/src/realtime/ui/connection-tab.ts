import { Component, computed, effect, inject, input, linkedSignal, signal, untracked } from '@angular/core';
import { FormField, form } from '@angular/forms/signals';
import { RealtimeConnectionSchema, newRealtimeConnection, newSavedMessage, type RealtimeConnection, type RealtimeConnectionSummary } from '@quiver/core';
import { Button, HostBridge, Input, KeyValueEditor, Segment, Segmented, Spinner, TabsState, Toasts, VariableInput, injectHostEvent, invokeResource, type Tab, type TabComponent } from '@quiver/ui';
import { Plug, Save, Unplug } from 'lucide';
import { ApiVariables, AuthEditor } from '../../api/ui';
import { RealtimeMessagesView } from './messages-view';
import { RealtimeActions, type ConnectionView } from './realtime-actions';
import { STATUS_LABEL, kindClass, statusDot } from './realtime-format';
import { RealtimeSavedMessages } from './saved-messages';
import { RealtimeSettingsView } from './settings-view';

function definitionOf(summary: RealtimeConnectionSummary): RealtimeConnection {
  return RealtimeConnectionSchema.parse(summary);
}

/** A WebSocket or SSE connection: the live log with a composer, and what the connection sends. Ctrl+S saves. */
@Component({
  selector: 'q-realtime-connection-tab',
  imports: [AuthEditor, Button, FormField, Input, KeyValueEditor, RealtimeMessagesView, RealtimeSavedMessages, RealtimeSettingsView, Segment, Segmented, Spinner, VariableInput],
  templateUrl: './connection-tab.html',
  hostDirectives: [ApiVariables],
  host: { class: 'contents', '(keydown)': 'shortcut($event)' },
})
export class RealtimeConnectionTab implements TabComponent {
  private readonly host = inject(HostBridge);
  private readonly tabs = inject(TabsState);
  private readonly toasts = inject(Toasts);
  protected readonly realtime = inject(RealtimeActions);

  readonly tab = input.required<Tab>();
  readonly scope = input.required<string>();

  protected readonly icons = { Plug, Save, Unplug };
  protected readonly statusLabel = STATUS_LABEL;
  private readonly connectionId = computed(() => String(this.tab().data?.['id'] ?? ''));
  protected readonly summary = invokeResource<RealtimeConnectionSummary>('realtime.connection.get', () => ({ id: this.connectionId() }), { refreshOn: ['realtime-connections'] });
  private readonly saved = computed(() => {
    const summary = this.summary.value();
    return summary ? definitionOf(summary) : undefined;
  });
  /** What the fields edit. Changes made elsewhere (MCP, another tab) replace it while it has no unsaved edits. */
  protected readonly draft = linkedSignal<RealtimeConnection | undefined, RealtimeConnection>({
    source: this.saved,
    computation: (saved, previous) => {
      if (!previous?.source) return saved ?? previous?.value ?? newRealtimeConnection();
      const edited = JSON.stringify(previous.value) !== JSON.stringify(previous.source);
      return edited || !saved ? previous.value : saved;
    },
  });
  protected readonly connectionForm = form(this.draft);
  protected readonly loadError = computed(() => this.summary.error()?.message ?? null);
  protected readonly dirty = computed(() => {
    const saved = this.saved();
    return Boolean(saved && JSON.stringify(this.draft()) !== JSON.stringify(saved));
  });
  /** The section on screen; the sidebar can ask for another one through the tab's data. */
  protected readonly view = linkedSignal<unknown, ConnectionView>({
    source: () => this.tab().data?.['nonce'],
    computation: (_nonce, previous) => untracked(() => (this.tab().data?.['view'] as ConnectionView | undefined)) ?? previous?.value ?? 'messages',
  });
  protected readonly busy = signal(false);
  protected readonly isWs = computed(() => this.draft().kind === 'websocket');
  protected readonly urlPlaceholder = computed(() => (this.isWs() ? 'wss://{{host}}/socket' : 'https://{{host}}/events'));
  protected readonly open = computed(() => this.summary.value()?.status !== 'disconnected');
  protected readonly dot = computed(() => {
    const summary = this.summary.value();
    return summary ? statusDot(summary.status, summary.error) : '';
  });
  protected readonly kind = computed(() => kindClass(this.draft().kind));
  protected readonly enabledHeaders = computed(() => this.draft().headers.filter((h) => h.enabled && h.key).length);

  constructor() {
    injectHostEvent('realtime.changed', (p) => p.connectionId === this.connectionId() && p.reason !== 'messages' && this.summary.reload());

    effect(() => {
      const dirty = this.dirty();
      const tab = this.tab();
      if (tab.dirty !== dirty) untracked(() => this.tabs.updateTab(this.scope(), tab.id, { dirty }));
    });
  }

  protected shortcut(event: KeyboardEvent): void {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      void this.saveAndSay();
    }
  }

  protected urlKey(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !this.open()) void this.toggle();
  }

  protected async saveAndSay(): Promise<void> {
    if (await this.save()) this.toasts.notify('Saved', 'success');
  }

  private async save(): Promise<boolean> {
    try {
      const stored = await this.host.invoke<RealtimeConnectionSummary>('realtime.connection.save', { connection: this.draft() });
      this.draft.set(definitionOf(stored));
      this.summary.reload();
      this.tabs.updateTab(this.scope(), this.tab().id, { title: stored.name });
      return true;
    } catch (err) {
      this.toasts.error(err);
      return false;
    }
  }

  protected async toggle(): Promise<void> {
    const summary = this.summary.value();
    if (!summary || this.busy()) return;
    this.busy.set(true);
    try {
      if (summary.status === 'disconnected') {
        if (this.dirty() && !(await this.save())) return;
        const opened = await this.host.invoke<RealtimeConnectionSummary>('realtime.connect', { id: this.connectionId() });
        if (opened.error && opened.status === 'disconnected') this.toasts.notify(opened.error, 'error');
      } else {
        await this.host.invoke('realtime.disconnect', { id: this.connectionId() });
      }
      this.summary.reload();
    } catch (err) {
      this.toasts.error(err);
    } finally {
      this.busy.set(false);
    }
  }

  /** Keep a message typed in the composer with the connection, as an unsaved edit. */
  protected saveMessage(body: string): void {
    this.draft.update((draft) => ({ ...draft, messages: [...draft.messages, newSavedMessage({ name: `Message ${draft.messages.length + 1}`, body })] }));
    this.view.set('saved');
    this.toasts.notify('Added to saved messages. Save the connection to keep it.', 'info');
  }
}
