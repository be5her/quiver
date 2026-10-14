import { Component, computed, effect, inject, input, linkedSignal, resource, signal, untracked } from '@angular/core';
import { FormField, form } from '@angular/forms/signals';
import { HttpMethodSchema, newApiRequest, toErrorPayload, type ApiRequest, type ApiResponse } from '@quiver/core';
import {
  Button,
  HostBridge,
  Input,
  KeyValueEditor,
  METHOD_COLORS,
  Segment,
  Segmented,
  Select,
  Spinner,
  TabsState,
  Toasts,
  VariableInput,
  injectHostEvent,
  type Tab,
  type TabComponent,
} from '@quiver/ui';
import { Copy, Save, Send } from 'lucide';
import { ApiVariables } from './api-variables';
import { AuthEditor } from './auth-editor';
import { BodyEditor } from './body-editor';
import { ResponsePane } from './response-pane';

type Section = 'params' | 'headers' | 'body' | 'auth';

/**
 * One request: name, method and URL, then params, headers, body and auth, and the last response.
 * Ctrl+Enter sends, Ctrl+S saves. While there are no unsaved edits, it follows the stored request
 * when it changes elsewhere (an agent, a git pull or branch switch, another tab).
 */
@Component({
  selector: 'q-request-tab',
  imports: [AuthEditor, BodyEditor, Button, FormField, Input, KeyValueEditor, ResponsePane, Segment, Segmented, Select, Spinner, VariableInput],
  hostDirectives: [ApiVariables],
  templateUrl: './request-tab.html',
  host: { class: 'contents', '(keydown)': 'shortcut($event)' },
})
export class RequestTab implements TabComponent {
  private readonly host = inject(HostBridge);
  private readonly tabs = inject(TabsState);
  private readonly toasts = inject(Toasts);

  readonly tab = input.required<Tab>();
  readonly scope = input.required<string>();

  protected readonly icons = { Copy, Save, Send };
  protected readonly methods = HttpMethodSchema.options;
  protected readonly methodColors = METHOD_COLORS;
  protected readonly urlPlaceholder = 'https://{{baseUrl}}/path';
  /** A history replay opens as a draft: an unsaved request with no stored version. */
  private readonly draft = computed(() => this.tab().data?.['draft'] as ApiRequest | undefined);
  private readonly requestId = computed(() => String(this.tab().data?.['id'] ?? ''));
  /** The request as stored; null for a draft. */
  private readonly stored = resource({
    params: () => ({ id: this.requestId(), draft: this.draft() }),
    loader: ({ params }) => (params.draft ? Promise.resolve(null) : this.host.invoke<ApiRequest>('api.request.get', { id: params.id })),
  });
  private readonly saved = computed(() => (this.stored.hasValue() ? this.stored.value() : null));
  /** Shown once there is a request to edit, and kept while it is fetched again. */
  protected readonly loaded = linkedSignal<boolean, boolean>({ source: () => this.stored.hasValue(), computation: (has, previous) => has || (previous?.value ?? false) });
  protected readonly loadError = computed(() => (this.stored.status() === 'error' ? toErrorPayload(this.stored.error()).message : null));
  /** What the fields edit. A newer stored version replaces it while it has no unsaved edits. */
  protected readonly request = linkedSignal<ApiRequest | undefined, ApiRequest>({
    source: () => (this.stored.hasValue() ? (this.stored.value() ?? this.draft()) : undefined),
    computation: (source, previous) => {
      if (!previous?.source) return source ?? previous?.value ?? newApiRequest();
      const edited = JSON.stringify(previous.value) !== JSON.stringify(previous.source);
      return edited || !source ? previous.value : source;
    },
  });
  protected readonly requestForm = form(this.request);
  protected readonly dirty = computed(() => {
    if (!this.loaded()) return false;
    if (this.draft() && !this.saved()) return true;
    return JSON.stringify(this.request()) !== JSON.stringify(this.saved());
  });
  protected readonly section = signal<Section>('params');
  protected readonly response = signal<ApiResponse | null>(null);
  protected readonly sendError = signal<string | null>(null);
  protected readonly sending = signal(false);
  protected readonly counts = computed(() => {
    const request = this.request();
    return {
      params: request.params.filter((p) => p.enabled && p.key).length,
      headers: request.headers.filter((h) => h.enabled && h.key).length,
      body: request.body.type === 'none' ? 0 : 1,
      auth: request.auth.type === 'none' ? 0 : 1,
    };
  });

  constructor() {
    injectHostEvent('store.changed', (p) => {
      if (this.draft() || p.workspaceId !== this.scope() || p.collection !== 'requests' || this.dirty()) return;
      this.stored.reload();
    });

    // The tab strip shows the unsaved-changes dot.
    effect(() => {
      const dirty = this.dirty();
      const tab = this.tab();
      if (tab.dirty !== dirty) untracked(() => this.tabs.updateTab(this.scope(), tab.id, { dirty }));
    });
  }

  protected shortcut(event: KeyboardEvent): void {
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key === 'Enter') {
      event.preventDefault();
      void this.send();
    } else if (mod && event.key.toLowerCase() === 's') {
      event.preventDefault();
      void this.save();
    }
  }

  protected async save(): Promise<void> {
    try {
      const stored = await this.host.invoke<ApiRequest>('api.request.save', { request: this.request() });
      this.stored.set(stored);
      this.request.set(stored);
      this.tabs.updateTab(this.scope(), this.tab().id, { title: stored.name, data: { id: stored.id } });
      this.toasts.notify('Saved', 'success');
    } catch (err) {
      this.toasts.error(err);
    }
  }

  protected async send(): Promise<void> {
    if (this.sending()) return;
    this.sending.set(true);
    this.sendError.set(null);
    try {
      this.response.set(await this.host.invoke<ApiResponse>('api.request.send', { request: this.request() }));
    } catch (err) {
      this.sendError.set(toErrorPayload(err).message);
    } finally {
      this.sending.set(false);
    }
  }

  protected async copyCurl(): Promise<void> {
    try {
      const { command } = await this.host.invoke<{ command: string }>('api.export.curl', { request: this.request() });
      await navigator.clipboard.writeText(command);
      this.toasts.notify('Copied curl command', 'success');
    } catch (err) {
      this.toasts.error(err);
    }
  }
}
