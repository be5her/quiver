import { Component, computed, effect, inject, input, linkedSignal, resource, signal, untracked } from '@angular/core';
import { FormField, form } from '@angular/forms/signals';
import {
  CODE_TARGETS,
  HttpMethodSchema,
  inheritedAuth,
  inheritedBaseUrl,
  inheritedHeaders,
  newApiRequest,
  newId,
  toErrorPayload,
  type ApiCollection,
  type ApiRequest,
  type ApiResponse,
  type Capture,
  type Check,
  type CodeTarget,
  type Environment,
  type RequestOptions,
} from '@quiver/core';
import {
  Button,
  CodeEditor,
  ContextMenu,
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
  invokeResource,
  type Tab,
  type TabComponent,
} from '@quiver/ui';
import { Code, Copy, Save, Send, Square } from 'lucide';
import { ApiVariables } from './api-variables';
import { AuthEditor, type InheritedAuthInfo } from './auth-editor';
import { BodyEditor } from './body-editor';
import { CaptureEditor } from './capture-editor';
import { CheckEditor } from './check-editor';
import { CodeView } from './code-view';
import { RequestSettings } from './request-settings';
import { ResponsePane } from './response-pane';

type Section = 'params' | 'headers' | 'body' | 'auth' | 'capture' | 'checks' | 'settings' | 'notes';

/**
 * One request: name, method and URL, then params, headers, body and auth, and the last response.
 * Ctrl+Enter sends, Escape stops a send, Ctrl+S saves. While there are no unsaved edits, it follows the stored request
 * when it changes elsewhere (an agent, a git pull or branch switch, another tab).
 */
@Component({
  selector: 'q-request-tab',
  imports: [AuthEditor, BodyEditor, Button, CaptureEditor, CheckEditor, CodeView, CodeEditor, FormField, Input, KeyValueEditor, RequestSettings, ResponsePane, Segment, Segmented, Select, Spinner, VariableInput],
  hostDirectives: [ApiVariables],
  templateUrl: './request-tab.html',
  host: { class: 'contents', '(keydown)': 'shortcut($event)' },
})
export class RequestTab implements TabComponent {
  private readonly host = inject(HostBridge);
  private readonly tabs = inject(TabsState);
  private readonly toasts = inject(Toasts);
  private readonly contextMenu = inject(ContextMenu);

  readonly tab = input.required<Tab>();
  readonly scope = input.required<string>();

  protected readonly icons = { Code, Copy, Save, Send, Square };
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
  /** Bytes of the body so far, while a big one downloads. */
  protected readonly received = signal(0);
  /** The id the running send was given, so Stop can cancel it. */
  private sendId: string | null = null;
  protected readonly envPickerTitle = 'Active environment, where {{variables}} come from';
  protected readonly notesPlaceholder = 'What this request is for, what it needs and what it returns. Agents read this too.';
  protected readonly environments = invokeResource<Environment[]>('api.environment.list', () => ({}), { refreshOn: ['environments'] });
  private readonly active = invokeResource<{ id: string | null }>('api.environment.active', () => ({}), { refreshOnState: ['api.activeEnvironment'] });
  protected readonly activeEnvironmentId = computed(() => this.active.value()?.id ?? null);
  /** What the lower pane shows: the last response, or the request as code. */
  protected readonly lower = signal<'response' | 'code'>('response');
  /** The language last picked for code, per workspace on this machine. */
  private readonly savedTarget = invokeResource<{ value: CodeTarget | null }>('workspace.state.get', () => ({ key: 'api.codegen.target' }));
  protected readonly codeTarget = computed<CodeTarget>(() => {
    const saved = this.savedTarget.value()?.value;
    return saved && CODE_TARGETS.some((t) => t.value === saved) ? saved : 'curl';
  });
  private readonly collections = invokeResource<ApiCollection[]>('api.collection.list', () => ({}), { refreshOn: ['collections'] });
  /** The headers the collections above add, struck through where the request sets its own of that name. */
  protected readonly inheritedHeaders = computed(() => {
    const request = this.request();
    const own = new Set(request.headers.filter((h) => h.enabled && h.key.trim()).map((h) => h.key.trim().toLowerCase()));
    return inheritedHeaders(this.collections.value() ?? [], request.collectionId).map((row) => ({ ...row, overridden: own.has(row.header.key.trim().toLowerCase()) }));
  });
  /** What "Inherit from collection" means for this request; offered only inside a collection. */
  protected readonly authInheritance = computed<InheritedAuthInfo | null>(() => {
    const request = this.request();
    if (!request.collectionId && request.auth.type !== 'inherit') return null;
    const { auth, from } = inheritedAuth(this.collections.value() ?? [], request.collectionId);
    return { resolved: auth, from: from?.name ?? null, label: 'collection' };
  });
  /** The base URL a URL starting with `/` gets, shown under the URL. */
  protected readonly baseUrlHint = computed(() => {
    const request = this.request();
    return request.url.trim().startsWith('/') ? inheritedBaseUrl(this.collections.value() ?? [], request.collectionId) : null;
  });
  protected readonly counts = computed(() => {
    const request = this.request();
    return {
      params: request.params.filter((p) => p.enabled && p.key).length,
      headers: request.headers.filter((h) => h.enabled && h.key).length + this.inheritedHeaders().filter((h) => !h.overridden).length,
      body: request.body.type === 'none' ? 0 : 1,
      auth: request.auth.type === 'none' || (request.auth.type === 'inherit' && !this.authInheritance()?.from) ? 0 : 1,
      capture: (request.capture ?? []).filter((c) => c.enabled).length,
      checks: (request.checks ?? []).filter((c) => c.enabled).length,
      settings: Object.keys(request.options ?? {}).length,
      notes: request.description?.trim() ? 1 : 0,
    };
  });

  constructor() {
    injectHostEvent('api.changed', (p) => {
      if (p.reason === 'progress' && this.sendId && p.sendId === this.sendId && this.sending()) this.received.set(p.received ?? 0);
    });
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
    } else if (event.key === 'Escape' && this.sending()) {
      event.preventDefault();
      void this.cancel();
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
    const sendId = newId();
    this.sendId = sendId;
    this.received.set(0);
    try {
      this.response.set(await this.host.invoke<ApiResponse>('api.request.send', { request: this.request(), sendId }));
    } catch (err) {
      this.sendError.set(toErrorPayload(err).message);
    } finally {
      this.sendId = null;
      this.sending.set(false);
    }
  }

  protected async cancel(): Promise<void> {
    if (!this.sendId) return;
    try {
      await this.host.invoke('api.request.cancel', { sendId: this.sendId });
    } catch (err) {
      this.toasts.error(err);
    }
  }

  /** Switches the workspace's active environment, the same one the sidebar ticks. */
  protected async setEnvironment(event: Event): Promise<void> {
    const id = (event.target as HTMLSelectElement).value || null;
    try {
      await this.host.invoke('api.environment.setActive', { id });
    } catch (err) {
      this.toasts.error(err);
    }
  }

  /** Overrides only; a request with none carries no `options` key, so it stays equal to the saved one. */
  protected setOptions(options: RequestOptions | undefined): void {
    this.request.update((request) => {
      const next: ApiRequest = { ...request, options };
      if (!options) delete next.options;
      return next;
    });
  }

  /** No captures means no `capture` key, so a request stays equal to the saved one. */
  protected setCapture(capture: Capture[] | undefined): void {
    this.request.update((request) => {
      const next: ApiRequest = { ...request, capture };
      if (!capture) delete next.capture;
      return next;
    });
  }

  /** No checks means no `checks` key, as for captures. */
  protected setChecks(checks: Check[] | undefined): void {
    this.request.update((request) => {
      const next: ApiRequest = { ...request, checks };
      if (!checks) delete next.checks;
      return next;
    });
  }

  protected setDescription(text: string): void {
    this.request.update((request) => {
      const next: ApiRequest = { ...request, description: text };
      if (!text) delete next.description;
      return next;
    });
  }

  /** Copy as one of the targets (the last one picked first), or show the code in the lower pane. */
  protected codeMenu(event: MouseEvent): void {
    const last = this.codeTarget();
    const ordered = [...CODE_TARGETS].sort((a, b) => (a.value === last ? -1 : b.value === last ? 1 : 0));
    this.contextMenu.open(event, [
      ...ordered.map((t) => ({ label: `Copy as ${t.label}`, select: () => void this.copyCode(t.value), testId: `api-copy-${t.value}` })),
      'separator',
      { label: 'Show code', select: () => this.lower.set('code'), testId: 'api-show-code' },
    ]);
  }

  protected async copyCode(target: CodeTarget): Promise<void> {
    try {
      const { code } = await this.host.invoke<{ code: string }>('api.export.code', { request: this.request(), target });
      await navigator.clipboard.writeText(code);
      this.toasts.notify(`Copied as ${CODE_TARGETS.find((t) => t.value === target)?.label ?? target}`, 'success');
      this.rememberTarget(target);
    } catch (err) {
      this.toasts.error(err);
    }
  }

  protected rememberTarget(target: CodeTarget): void {
    if (target === this.codeTarget()) return;
    this.host.invoke('workspace.state.set', { key: 'api.codegen.target', value: target }).then(() => this.savedTarget.reload(), (err) => this.toasts.error(err));
  }
}
