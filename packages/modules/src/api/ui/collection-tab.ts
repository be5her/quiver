import { Component, computed, effect, inject, input, linkedSignal, resource, untracked } from '@angular/core';
import { FormField, form } from '@angular/forms/signals';
import { collectionPath, compareRequests, inheritedAuth, inheritedBaseUrl, newCollection, toErrorPayload, type ApiCollection, type ApiRequest } from '@quiver/core';
import { Button, CodeEditor, HostBridge, Icon, IconButton, Input, KeyValueEditor, METHOD_COLORS, Spinner, TabsState, Toasts, VariableInput, injectHostEvent, invokeResource, type Tab, type TabComponent } from '@quiver/ui';
import { ArrowDown, ArrowUp, Play, Save } from 'lucide';
import { ApiActions } from './api-actions';
import { ApiVariables } from './api-variables';
import { AuthEditor, type InheritedAuthInfo } from './auth-editor';

/**
 * A collection and what the requests inside inherit: a base URL for URLs starting with `/`, headers,
 * auth (or `inherit`, passing on the parent's) and a description. Like the request and environment
 * tabs, it follows changes made elsewhere while it has no unsaved edits.
 */
@Component({
  selector: 'q-collection-tab',
  imports: [AuthEditor, Button, CodeEditor, FormField, Icon, IconButton, Input, KeyValueEditor, Spinner, VariableInput],
  hostDirectives: [ApiVariables],
  templateUrl: './collection-tab.html',
  host: { class: 'contents', '(keydown)': 'shortcut($event)' },
})
export class CollectionTab implements TabComponent {
  private readonly host = inject(HostBridge);
  private readonly tabs = inject(TabsState);
  private readonly toasts = inject(Toasts);
  private readonly api = inject(ApiActions);

  readonly tab = input.required<Tab>();
  readonly scope = input.required<string>();

  protected readonly icons = { ArrowDown, ArrowUp, Play, Save };
  protected readonly methodColors = METHOD_COLORS;
  protected readonly baseUrlPlaceholder = 'https://{{host}}/v1';
  protected readonly descriptionPlaceholder = 'What these requests are for and what they need. Agents read this too.';
  private readonly id = computed(() => String(this.tab().data?.['id'] ?? ''));
  private readonly stored = resource({
    params: () => ({ id: this.id() }),
    loader: ({ params }) => this.host.invoke<ApiCollection>('api.collection.get', { id: params.id }),
  });
  private readonly all = invokeResource<ApiCollection[]>('api.collection.list', () => ({}), { refreshOn: ['collections'] });
  protected readonly loaded = computed(() => this.stored.hasValue());
  private readonly requests = invokeResource<ApiRequest[]>('api.request.list', () => ({ collectionId: this.id() }), { refreshOn: ['requests'] });
  /** The requests directly in the collection, in the order a run sends them. */
  protected readonly ordered = computed(() => [...(this.requests.value() ?? [])].sort(compareRequests));
  protected readonly loadError = computed(() => (this.stored.status() === 'error' ? toErrorPayload(this.stored.error()).message : null));
  /** What the fields edit. A newer stored version replaces it while it has no unsaved edits. */
  protected readonly collection = linkedSignal<ApiCollection | undefined, ApiCollection>({
    source: () => (this.stored.hasValue() ? this.stored.value() : undefined),
    computation: (source, previous) => {
      if (!previous?.source) return source ?? previous?.value ?? newCollection('');
      const edited = JSON.stringify(previous.value) !== JSON.stringify(previous.source);
      return edited || !source ? previous.value : source;
    },
  });
  protected readonly collectionForm = form(this.collection);
  protected readonly dirty = computed(() => this.loaded() && JSON.stringify(this.collection()) !== JSON.stringify(this.stored.value()));

  /** Where the collection sits, for the header line. */
  protected readonly path = computed(() => {
    const parentId = this.collection().parentId;
    return parentId ? collectionPath(this.all.value() ?? [], parentId) : null;
  });
  protected readonly authInheritance = computed<InheritedAuthInfo>(() => {
    const { auth, from } = inheritedAuth(this.all.value() ?? [], this.collection().parentId);
    return { resolved: auth, from: from?.name ?? null, label: 'parent collection' };
  });
  /** The base URL requests inside get when this collection sets none. */
  protected readonly parentBaseUrl = computed(() => inheritedBaseUrl(this.all.value() ?? [], this.collection().parentId));

  constructor() {
    injectHostEvent('store.changed', (p) => {
      if (p.workspaceId !== this.scope() || p.collection !== 'collections' || this.dirty()) return;
      this.stored.reload();
    });

    effect(() => {
      const dirty = this.dirty();
      const tab = this.tab();
      if (tab.dirty !== dirty) untracked(() => this.tabs.updateTab(this.scope(), tab.id, { dirty }));
    });
  }

  protected shortcut(event: KeyboardEvent): void {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      void this.save();
    }
  }

  /** Swap a request with its neighbour; the whole order is written, so requests without one get one. */
  protected async move(index: number, delta: number): Promise<void> {
    const ids = this.ordered().map((r) => r.id);
    const to = index + delta;
    if (to < 0 || to >= ids.length) return;
    [ids[index], ids[to]] = [ids[to], ids[index]];
    try {
      await this.host.invoke('api.collection.reorder', { collectionId: this.id(), requestIds: ids });
    } catch (err) {
      this.toasts.error(err);
    }
  }

  protected openRequest(request: ApiRequest): void {
    this.api.openRequestTab(request);
  }

  protected runCollection(): void {
    this.api.runCollection(this.collection()).catch((err) => this.toasts.error(err));
  }

  protected setDescription(text: string): void {
    this.collection.update((c) => {
      const next: ApiCollection = { ...c, description: text };
      if (!text) delete next.description;
      return next;
    });
  }

  protected async save(): Promise<void> {
    try {
      const stored = await this.host.invoke<ApiCollection>('api.collection.save', { collection: this.collection() });
      this.stored.set(stored);
      this.collection.set(stored);
      this.tabs.updateTab(this.scope(), this.tab().id, { title: stored.name });
      this.toasts.notify('Collection saved', 'success');
    } catch (err) {
      this.toasts.error(err);
    }
  }
}
